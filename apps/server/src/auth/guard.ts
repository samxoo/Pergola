import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { MutationKind } from "@pergola/shared";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { apiToken, board, boardMember, user } from "../db/schema.js";
import type { InstanceRole } from "./instance.js";

export type Actor = { id: string; name: string; email: string; role: InstanceRole };

/** What a banned person is told when whoever banned them left no message. */
export const BAN_FALLBACK = "Your account has been banned from this instance.";
export type Role = "admin" | "member" | "observer";

export type Env = { Variables: { actor: Actor } };

export class Forbidden extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Forbidden";
  }
}

/* --------------------------------------------------------------- API tokens */

/** Tokens are visibly ours, so a leaked one is recognisable in a log or a repo. */
export const mintToken = () => `prg_${randomBytes(24).toString("base64url")}`;

/**
 * Only the hash is ever stored.
 *
 * SHA-256 without a salt is right here and wrong for passwords: the input is 192
 * bits of our own randomness, so there is nothing to brute-force or rainbow, and
 * the lookup has to be a single indexed equality on every API call.
 */
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function actorFromToken(header: string | undefined): Promise<Actor | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      deactivatedAt: user.deactivatedAt,
      tokenId: apiToken.id,
      expiresAt: apiToken.expiresAt,
    })
    .from(apiToken)
    .innerJoin(user, eq(user.id, apiToken.userId))
    .where(eq(apiToken.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  // A revoked account's tokens die with it, or "deactivate" means nothing to
  // anyone holding one.
  if (row.deactivatedAt) return null;

  // Best effort: knowing a token is unused is worth more than this write costing
  // nothing, but a failure here must not refuse an otherwise valid request.
  void db
    .update(apiToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiToken.id, row.tokenId))
    .catch(() => {});

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as InstanceRole,
  };
}

/**
 * Every route behind this has a real person attached — through a session cookie
 * in the browser, or a bearer token from a script. Anonymous requests stop here
 * rather than defaulting to some placeholder identity.
 */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const viaToken = await actorFromToken(c.req.header("authorization"));
  if (viaToken) {
    c.set("actor", viaToken);
    return next();
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ message: "Sign in, or send a Bearer token" }, 401);
  }

  /*
   * Deactivation deletes the account's sessions, but a request already in flight
   * — or a stale cookie against a replica — must not slip through. One indexed
   * read is worth it on the path that decides who anyone is.
   */
  const [live] = await db
    .select({ role: user.role, deactivatedAt: user.deactivatedAt, banReason: user.banReason })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (!live) {
    return c.json({ message: "That account no longer has access to this instance" }, 401);
  }
  /*
   * Banned. A 403 with the reason, not a 401: the session is real, the person
   * is who they say they are, and what they need to hear is why the door is
   * shut — which the client shows them, and keeps showing them.
   */
  if (live.deactivatedAt) {
    return c.json({ code: "banned", message: live.banReason ?? BAN_FALLBACK }, 403);
  }

  c.set("actor", {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: live.role as InstanceRole,
  });
  await next();
};

export const actorOf = (c: Context<Env>) => c.get("actor");

/**
 * What each role may do.
 *
 * One table, checked in one place. Scattered `if (role === "admin")` checks are
 * how a tool grows a hole where one endpoint forgot to ask.
 */
const BOARD_STRUCTURE: MutationKind[] = [
  "list.create", "list.rename", "list.move", "list.delete", "list.setWip",
  "label.create", "label.update", "label.delete",
  "field.create", "field.update", "field.delete",
];

const CARD_CONTENT: MutationKind[] = [
  "card.create", "card.move", "card.rename", "card.describe", "card.setDates",
  "card.setCover", "card.archive", "card.delete", "card.label", "card.assign",
  "card.setField",
  "checklist.create", "checklist.rename", "checklist.delete",
  "item.create", "item.toggle", "item.rename", "item.setDue", "item.move", "item.delete",
  "attachment.add", "attachment.remove", "card.vote",
  "comment.create", "comment.edit", "comment.delete",
];

const CAPABILITIES: Record<Role, ReadonlySet<MutationKind>> = {
  admin: new Set([...BOARD_STRUCTURE, ...CARD_CONTENT]),
  member: new Set(CARD_CONTENT),
  // An observer may still comment — that is the point of inviting one.
  observer: new Set<MutationKind>(["comment.create", "comment.edit", "comment.delete"]),
};

/** Owners and admins run the instance; the rest are members of it. */
export const runsInstance = (role: InstanceRole | string | null | undefined) =>
  role === "owner" || role === "admin";

/**
 * What this person is on this board.
 *
 * Membership answers first. Failing that, whoever runs the instance is an admin
 * on every board on it: the instance is the company, and the people running it
 * can open any board the company has — the way a workspace admin can in Trello.
 * That is the one place instance roles and board roles meet, so it lives here
 * and nowhere else. Pass `instanceRole` when the caller already knows it, to
 * spare a read.
 */
export async function roleOn(
  boardId: string,
  userId: string,
  instanceRole?: InstanceRole,
): Promise<Role | null> {
  const [row] = await db
    .select({ role: boardMember.role })
    .from(boardMember)
    .where(and(eq(boardMember.boardId, boardId), eq(boardMember.userId, userId)))
    .limit(1);
  if (row) return row.role;

  let role: string | undefined = instanceRole;
  if (role === undefined) {
    const [who] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
    role = who?.role;
  }
  if (!runsInstance(role)) return null;

  // Admin on any board that exists — not on a board id someone made up.
  const [exists] = await db.select({ id: board.id }).from(board).where(eq(board.id, boardId)).limit(1);
  return exists ? "admin" : null;
}

/** Read access. Throws rather than returning an empty board. */
export async function authorizeRead(boardId: string, actor: Actor): Promise<Role> {
  const role = await roleOn(boardId, actor.id, actor.role);
  if (!role) throw new Forbidden("You are not a member of that board");
  return role;
}

/** Write access for one specific kind of change. */
export async function authorizeWrite(boardId: string, actor: Actor, kind: MutationKind) {
  const role = await authorizeRead(boardId, actor);
  if (!CAPABILITIES[role].has(kind)) {
    // Name the missing capability. An unauthorised action that merely returns
    // nothing is miserable to debug from either side of the screen.
    throw new Forbidden(`A ${role} cannot ${kind.replace(".", " ")} on this board`);
  }
  return role;
}

/**
 * Is this person still allowed on this board, right now?
 *
 * Both halves of revocation — taken off the board, or deactivated outright —
 * asked in one place because both live subscriptions need it. A subscription
 * outlives the request that opened it, so authorising once at subscribe time is
 * not enough: without a re-check, removing someone leaves their open connection
 * streaming every change on the board until they close the tab.
 */
export async function stillHasAccess(userId: string, boardId: string): Promise<boolean> {
  const [live] = await db
    .select({ deactivatedAt: user.deactivatedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!live || live.deactivatedAt) return false;
  return (await roleOn(boardId, userId)) !== null;
}
