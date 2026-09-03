import { zValidator } from "@hono/zod-validator";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { board, invite, user } from "../db/schema.js";
import {
  ban,
  findInvite,
  getAccess,
  hashInvite,
  liftBan,
  mayJoin,
  mintInvite,
  ownerCount,
  setAccess,
  type InstanceRole,
} from "../auth/instance.js";
import { actorOf, BAN_FALLBACK, Forbidden, requireUser, type Env } from "../auth/guard.js";

/** Running the instance is for owners and admins. Members cannot see any of it. */
async function requireInstanceAdmin(userId: string): Promise<InstanceRole> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  const role = (row?.role ?? "member") as InstanceRole;
  if (role !== "owner" && role !== "admin") {
    // Must be the mapped error type, or index.ts turns it into a 500 and tells
    // the caller the server broke rather than that they lack access.
    throw new Forbidden("Only an owner or admin can do that");
  }
  return role;
}

const INVITE_DAYS = 7;

export const admin = new Hono<Env>()
  /* ------------------------------------------------------- public: joining */

  /**
   * Validate an invite before showing the sign-up form.
   *
   * Unauthenticated by necessity — the whole point is that the person has no
   * account yet. It returns only the address the invite was issued for, so a
   * guessed token reveals nothing about the instance.
   */
  .get("/invites/:token", async (c) => {
    const found = await findInvite(c.req.param("token"));
    if (!found) return c.json({ message: "That invitation has expired or been used" }, 404);
    return c.json({ email: found.email, role: found.role });
  })

  .post(
    "/invites/:token/accept",
    zValidator("json", z.object({
      name: z.string().min(1).max(120),
      password: z.string().min(10).max(200),
    })),
    async (c) => {
      const token = c.req.param("token");
      const found = await findInvite(token);
      if (!found) return c.json({ message: "That invitation has expired or been used" }, 404);

      const { name, password } = c.req.valid("json");
      const created = await auth.api.signUpEmail({
        body: { email: found.email, password, name },
        asResponse: true,
      });
      if (!created.ok) {
        return c.json({ message: "That account could not be created" }, 400);
      }

      // The invite decides the role, and it is spent either way — a link that
      // still works after it has been used is a link worth stealing.
      await db.transaction(async (tx) => {
        await tx.update(user).set({ role: found.role }).where(eq(user.email, found.email));
        await tx
          .update(invite)
          .set({ acceptedAt: new Date() })
          .where(eq(invite.tokenHash, hashInvite(token)));
      });

      // Hand back the session cookie Better Auth just issued.
      const headers = new Headers();
      for (const cookie of created.headers.getSetCookie()) headers.append("set-cookie", cookie);
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: (headers.set("content-type", "application/json"), headers),
      });
    },
  )

  /** What the sign-up page needs to know before it renders. */
  /**
   * Who am I, and am I allowed in?
   *
   * Answered for a banned person too — it is the one route that is — because
   * the notice they see needs the reason, and every other route refuses them
   * before it says anything. Session only; a token cannot be banned into a
   * notice, it simply stops working.
   */
  .get("/me", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ message: "Sign in first" }, 401);
    const [row] = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        deactivatedAt: user.deactivatedAt,
        banReason: user.banReason,
      })
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1);
    if (!row) return c.json({ message: "That account no longer exists" }, 401);
    return c.json({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      banned: row.deactivatedAt !== null,
      banReason: row.deactivatedAt !== null ? (row.banReason ?? BAN_FALLBACK) : null,
    });
  })

  .get("/access", async (c) => {
    const access = await getAccess();
    const verdict = await mayJoin("someone@example.invalid");
    return c.json({
      // Never leak the domain list to an anonymous visitor; only whether the
      // door is open at all.
      openToAnyone: verdict.ok && access.signupMode === "open",
      mode: access.signupMode,
    });
  })

  /* --------------------------------------------------- everything below: admin */

  .use("/admin/*", requireUser)

  .get("/admin/people", async (c) => {
    await requireInstanceAdmin(actorOf(c).id);
    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        deactivatedAt: user.deactivatedAt,
        banReason: user.banReason,
        createdAt: user.createdAt,
        /*
         * Aliased by hand, deliberately.
         *
         * Interpolating Drizzle columns into a correlated subquery emits them
         * UNQUALIFIED — `where "user_id" = "id"` — so Postgres binds "id" to the
         * inner table whenever it has a column by that name, and the subquery
         * quietly stops correlating. It returns null or zero rather than an
         * error, so it looks like data. Explicit aliases are the only way to be
         * sure which table each name means.
         */
        boardCount: sql<number>`(
          select count(*)::int from board_member bm where bm.user_id = "user".id
        )`,
        lastSeenAt: sql<string | null>`(
          select max(s.updated_at) from "session" s where s.user_id = "user".id
        )`,
      })
      .from(user)
      .orderBy(asc(user.createdAt));

    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        active: r.deactivatedAt === null,
        banReason: r.deactivatedAt === null ? null : (r.banReason ?? BAN_FALLBACK),
        boardCount: r.boardCount,
        lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  })

  .patch(
    "/admin/people/:id",
    zValidator("json", z.object({
      role: z.enum(["owner", "admin", "member"]).optional(),
      /** false bans, true lifts the ban. */
      active: z.boolean().optional(),
      /** What the banned person will be told. Required when banning. */
      reason: z.string().trim().max(1000).optional(),
    })),
    async (c) => {
      const me = actorOf(c);
      const myRole = await requireInstanceAdmin(me.id);
      const targetId = c.req.param("id");
      const { role, active, reason } = c.req.valid("json");

      // A ban with no message is a locked door with no note on it. Insist.
      if (active === false && !reason) {
        return c.json({ message: "Say why: the message is what the banned person sees" }, 400);
      }

      // You cannot promote or lock out yourself. Both are how an instance ends
      // up with nobody able to administer it, and both look like accidents.
      if (targetId === me.id) {
        return c.json({ message: "You cannot change your own role or access" }, 409);
      }

      const [target] = await db.select().from(user).where(eq(user.id, targetId)).limit(1);
      if (!target) return c.json({ message: "No such person" }, 404);

      /*
       * Ownership is only handed out by an owner, in both directions.
       *
       * Without this an admin promotes a second account they control to owner,
       * and from there changes who may join and demotes the real owner — the
       * invite route already guards exactly this, and this route missed it.
       */
      if (role === "owner" && myRole !== "owner") {
        return c.json({ message: "Only an owner can make someone an owner" }, 403);
      }
      if (target.role === "owner" && myRole !== "owner") {
        return c.json({ message: "Only an owner can change another owner" }, 403);
      }

      const losingAnOwner =
        target.role === "owner" && ((role && role !== "owner") || active === false);
      if (losingAnOwner && (await ownerCount()) <= 1) {
        return c.json({ message: "An instance needs at least one active owner" }, 409);
      }

      if (role) await db.update(user).set({ role }).where(eq(user.id, targetId));
      if (active === false) await ban(targetId, reason!);
      if (active === true) await liftBan(targetId);

      return c.json({ ok: true });
    },
  )

  .get("/admin/invites", async (c) => {
    await requireInstanceAdmin(actorOf(c).id);
    const rows = await db
      .select({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        invitedByName: user.name,
      })
      .from(invite)
      .leftJoin(user, eq(user.id, invite.invitedBy))
      .where(isNull(invite.acceptedAt))
      .orderBy(desc(invite.createdAt));

    return c.json(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        invitedByName: r.invitedByName,
      })),
    );
  })

  .post(
    "/admin/invites",
    zValidator("json", z.object({
      email: z.email().max(200),
      role: z.enum(["owner", "admin", "member"]).default("member"),
    })),
    async (c) => {
      const me = actorOf(c);
      const myRole = await requireInstanceAdmin(me.id);
      const { email, role } = c.req.valid("json");

      // An admin must not be able to mint an owner and take the instance.
      if (role === "owner" && myRole !== "owner") {
        return c.json({ message: "Only an owner can invite another owner" }, 403);
      }

      const [existing] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email.toLowerCase()))
        .limit(1);
      if (existing) return c.json({ message: "That person already has an account" }, 409);

      const token = mintInvite();
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
      const [row] = await db
        .insert(invite)
        .values({
          email: email.toLowerCase(),
          role,
          tokenHash: hashInvite(token),
          invitedBy: me.id,
          expiresAt,
        })
        .returning({ id: invite.id });

      const origin = new URL(c.req.url).origin;
      // Shown once. There is no mail server on a fresh self-hosted box, so the
      // admin passes the link on however they like.
      return c.json(
        { id: row!.id, url: `${origin}/join/${token}`, expiresAt: expiresAt.toISOString() },
        201,
      );
    },
  )

  .delete("/admin/invites/:id", async (c) => {
    await requireInstanceAdmin(actorOf(c).id);
    await db.delete(invite).where(eq(invite.id, c.req.param("id")));
    return c.body(null, 204);
  })

  /** Every board on the instance. The "what is going on here" view. */
  .get("/admin/boards", async (c) => {
    await requireInstanceAdmin(actorOf(c).id);
    const rows = await db
      .select({
        id: board.id,
        title: board.title,
        visibility: board.visibility,
        createdAt: board.createdAt,
        memberCount: sql<number>`(
          select count(*)::int from board_member bm where bm.board_id = board.id
        )`,
        cardCount: sql<number>`(
          select count(*)::int from card c
          where c.board_id = board.id and c.archived_at is null
        )`,
        ownerName: sql<string | null>`(
          select u.name from board_member bm join "user" u on u.id = bm.user_id
          where bm.board_id = board.id and bm.role = 'admin'
          order by bm.created_at asc limit 1
        )`,
      })
      .from(board)
      .orderBy(asc(board.createdAt));

    return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  })

  .get("/admin/settings", async (c) => {
    await requireInstanceAdmin(actorOf(c).id);
    return c.json(await getAccess());
  })

  .patch(
    "/admin/settings",
    zValidator("json", z.object({
      signupMode: z.enum(["open", "invite", "domain"]).optional(),
      allowedDomains: z.array(z.string().min(1).max(200)).max(20).optional(),
    })),
    async (c) => {
      const myRole = await requireInstanceAdmin(actorOf(c).id);
      // Who may join is an ownership decision, not a day-to-day admin one.
      if (myRole !== "owner") {
        return c.json({ message: "Only an owner can change how people get in" }, 403);
      }
      return c.json(await setAccess(c.req.valid("json")));
    },
  );
