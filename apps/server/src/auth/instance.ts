import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { invite, session, setting, user } from "../db/schema.js";

/**
 * Running this instance.
 *
 * The instance is the company. A self-hosted box does not need an organisation
 * object layered on top of itself — the people with accounts here are the
 * company, and the owner of the box owns it.
 */

export type InstanceRole = "owner" | "admin" | "member";

/** How people are allowed to get an account. */
export type SignupMode = "open" | "invite" | "domain";

export type Access = { signupMode: SignupMode; allowedDomains: string[] };

const ACCESS_KEY = "access";

/**
 * Invite-only by default.
 *
 * An instance reachable from the internet with open signup collects strangers,
 * and the person standing it up is rarely thinking about that in the first five
 * minutes. Defaulting closed costs one invite; defaulting open costs an incident.
 */
const DEFAULT_ACCESS: Access = { signupMode: "invite", allowedDomains: [] };

export async function getAccess(): Promise<Access> {
  const [row] = await db.select().from(setting).where(eq(setting.key, ACCESS_KEY)).limit(1);
  if (!row) return DEFAULT_ACCESS;
  const v = row.value as Partial<Access>;
  return {
    signupMode: v.signupMode ?? DEFAULT_ACCESS.signupMode,
    allowedDomains: v.allowedDomains ?? [],
  };
}

export async function setAccess(next: Partial<Access>): Promise<Access> {
  const merged = { ...(await getAccess()), ...next };
  await db
    .insert(setting)
    .values({ key: ACCESS_KEY, value: merged })
    .onConflictDoUpdate({ target: setting.key, set: { value: merged, updatedAt: new Date() } });
  return merged;
}

export async function userCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(user);
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ invites */

export const mintInvite = () => `inv_${randomBytes(24).toString("base64url")}`;
export const hashInvite = (token: string) => createHash("sha256").update(token).digest("hex");

/** A usable invite: not spent, not expired, and matching the address it was sent to. */
export async function findInvite(token: string, email?: string) {
  const [row] = await db
    .select()
    .from(invite)
    .where(and(eq(invite.tokenHash, hashInvite(token)), isNull(invite.acceptedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  // The link is bound to the address it was issued for; otherwise one leaked
  // invite is an open door for whoever finds it.
  if (email && row.email.toLowerCase() !== email.toLowerCase()) return null;
  return row;
}

/* ------------------------------------------------------------------- signup */

export type SignupVerdict = { ok: true; role: InstanceRole } | { ok: false; message: string };

/**
 * May this address create an account right now?
 *
 * The first account is always allowed — otherwise a fresh instance is a locked
 * room with the key inside — and it becomes the owner.
 */
export async function mayJoin(email: string, token?: string): Promise<SignupVerdict> {
  if ((await userCount()) === 0) return { ok: true, role: "owner" };

  const invited = token ? await findInvite(token, email) : null;
  if (invited) return { ok: true, role: invited.role };

  const access = await getAccess();
  switch (access.signupMode) {
    case "open":
      return { ok: true, role: "member" };
    case "domain": {
      const domain = email.split("@")[1]?.toLowerCase() ?? "";
      if (access.allowedDomains.some((d) => d.toLowerCase() === domain)) {
        return { ok: true, role: "member" };
      }
      return {
        ok: false,
        message: `Accounts here are limited to ${access.allowedDomains.join(", ")}. Ask an admin for an invite.`,
      };
    }
    case "invite":
      return {
        ok: false,
        message: "This instance is invite only. Ask an admin to send you a link.",
      };
  }
}

/* -------------------------------------------------------------- deactivation */

/**
 * Revoke access, now.
 *
 * Marking the account is not enough on its own: a session issued yesterday is
 * valid for thirty days, so the sessions go too. Someone who has left the
 * company is out the moment the button is pressed, not next month.
 */
export async function deactivate(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(user).set({ deactivatedAt: new Date() }).where(eq(user.id, userId));
    await tx.delete(session).where(eq(session.userId, userId));
  });
}

export async function reactivate(userId: string): Promise<void> {
  await db.update(user).set({ deactivatedAt: null }).where(eq(user.id, userId));
}

/** An instance always needs someone who can administer it. */
export async function ownerCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(and(eq(user.role, "owner"), isNull(user.deactivatedAt)));
  return row?.n ?? 0;
}
