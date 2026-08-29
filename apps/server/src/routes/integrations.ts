import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { RuleInput } from "@pergola/shared";
import { BlockedAddress, resolvePublic } from "../automation/ssrf.js";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { apiToken, board, notification, rule, webhook } from "../db/schema.js";
import {
  actorOf,
  type Actor,
  Forbidden,
  authorizeRead,
  hashToken,
  mintToken,
  requireUser,
  type Env,
} from "../auth/guard.js";

/** Board-structure changes need an admin; reads need any membership. */
async function requireAdmin(boardId: string, actor: Actor) {
  const role = await authorizeRead(boardId, actor);
  if (role !== "admin") {
    throw new Forbidden("Only a board admin can change this");
  }
}

export const integrations = new Hono<Env>()
  .use("*", requireUser)

  /* ------------------------------------------------------------- tokens */

  .get("/tokens", async (c) => {
    const rows = await db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        lastUsedAt: apiToken.lastUsedAt,
        expiresAt: apiToken.expiresAt,
        createdAt: apiToken.createdAt,
      })
      .from(apiToken)
      .where(eq(apiToken.userId, actorOf(c).id))
      .orderBy(desc(apiToken.createdAt));
    return c.json(rows);
  })

  .post(
    "/tokens",
    zValidator("json", z.object({
      name: z.string().min(1).max(80),
      expiresInDays: z.number().int().positive().max(3650).nullable().default(null),
    })),
    async (c) => {
      const { name, expiresInDays } = c.req.valid("json");
      const token = mintToken();
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 86_400_000)
        : null;

      const [row] = await db
        .insert(apiToken)
        .values({ userId: actorOf(c).id, name, tokenHash: hashToken(token), expiresAt })
        .returning({ id: apiToken.id, name: apiToken.name });

      // The only time the plaintext exists outside the caller's hands. Say so,
      // because a token they cannot copy again is a token they will re-create.
      return c.json({ ...row, token, shownOnce: true }, 201);
    },
  )

  .delete("/tokens/:id", async (c) => {
    await db
      .delete(apiToken)
      .where(and(eq(apiToken.id, c.req.param("id")), eq(apiToken.userId, actorOf(c).id)));
    return c.body(null, 204);
  })

  /* ----------------------------------------------------------- webhooks */

  .get("/boards/:id/webhooks", async (c) => {
    const boardId = c.req.param("id");
    await authorizeRead(boardId, actorOf(c));
    const rows = await db
      .select({
        id: webhook.id,
        url: webhook.url,
        active: webhook.active,
        lastStatus: webhook.lastStatus,
        lastError: webhook.lastError,
        lastFiredAt: webhook.lastFiredAt,
      })
      .from(webhook)
      .where(eq(webhook.boardId, boardId))
      .orderBy(asc(webhook.createdAt));
    return c.json(rows);
  })

  .post(
    "/boards/:id/webhooks",
    zValidator("json", z.object({ url: z.url().max(2000) })),
    async (c) => {
      const boardId = c.req.param("id");
      await requireAdmin(boardId, actorOf(c));

      // Refuse it here so the person is told why, rather than watching an
      // endpoint that silently never fires. Delivery checks again — see ssrf.ts.
      try {
        await resolvePublic(c.req.valid("json").url, { allowPrivate: env.WEBHOOK_ALLOW_PRIVATE });
      } catch (err) {
        return c.json(
          { message: err instanceof BlockedAddress ? err.message : "That URL was not accepted" },
          400,
        );
      }

      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const [row] = await db
        .insert(webhook)
        .values({ boardId, url: c.req.valid("json").url, secret })
        .returning({ id: webhook.id, url: webhook.url });
      // Same rule as tokens: the secret is shown once and stored only here.
      return c.json({ ...row, secret, shownOnce: true }, 201);
    },
  )

  .delete("/boards/:id/webhooks/:hookId", async (c) => {
    const boardId = c.req.param("id");
    await requireAdmin(boardId, actorOf(c));
    await db
      .delete(webhook)
      .where(and(eq(webhook.id, c.req.param("hookId")), eq(webhook.boardId, boardId)));
    return c.body(null, 204);
  })

  /* -------------------------------------------------------------- rules */

  .get("/boards/:id/rules", async (c) => {
    const boardId = c.req.param("id");
    await authorizeRead(boardId, actorOf(c));
    const rows = await db
      .select()
      .from(rule)
      .where(eq(rule.boardId, boardId))
      .orderBy(asc(rule.createdAt));
    return c.json(
      rows.map((r) => ({
        id: r.id,
        boardId: r.boardId,
        name: r.name,
        enabled: r.enabled,
        trigger: r.trigger,
        actions: r.actions,
        fireCount: r.fireCount,
        lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
      })),
    );
  })

  .post("/boards/:id/rules", zValidator("json", RuleInput), async (c) => {
    const boardId = c.req.param("id");
    await requireAdmin(boardId, actorOf(c));
    const input = c.req.valid("json");
    const [row] = await db
      .insert(rule)
      .values({
        boardId,
        name: input.name,
        enabled: input.enabled,
        trigger: input.trigger,
        actions: input.actions,
      })
      .returning({ id: rule.id });
    return c.json({ id: row!.id, ...input }, 201);
  })

  .patch(
    "/boards/:id/rules/:ruleId",
    zValidator("json", z.object({ enabled: z.boolean() })),
    async (c) => {
      const boardId = c.req.param("id");
      await requireAdmin(boardId, actorOf(c));
      await db
        .update(rule)
        .set({ enabled: c.req.valid("json").enabled })
        .where(and(eq(rule.id, c.req.param("ruleId")), eq(rule.boardId, boardId)));
      return c.body(null, 204);
    },
  )

  .delete("/boards/:id/rules/:ruleId", async (c) => {
    const boardId = c.req.param("id");
    await requireAdmin(boardId, actorOf(c));
    await db
      .delete(rule)
      .where(and(eq(rule.id, c.req.param("ruleId")), eq(rule.boardId, boardId)));
    return c.body(null, 204);
  })

  /* ------------------------------------------------------- public links */

  .patch(
    "/boards/:id/visibility",
    zValidator("json", z.object({ visibility: z.enum(["private", "public"]) })),
    async (c) => {
      const boardId = c.req.param("id");
      await requireAdmin(boardId, actorOf(c));
      await db
        .update(board)
        .set({ visibility: c.req.valid("json").visibility })
        .where(eq(board.id, boardId));
      return c.json({ visibility: c.req.valid("json").visibility });
    },
  )

  /* ------------------------------------------------------ notifications */

  .get("/notifications", async (c) => {
    const rows = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, actorOf(c).id))
      .orderBy(desc(notification.createdAt))
      .limit(50);
    return c.json(
      rows.map((n) => ({
        id: n.id,
        boardId: n.boardId,
        cardId: n.cardId,
        kind: n.kind,
        body: n.body,
        actorId: n.actorId,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      })),
    );
  })

  .post("/notifications/read", async (c) => {
    await db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.userId, actorOf(c).id), isNull(notification.readAt)));
    return c.body(null, 204);
  })

  .get("/notifications/count", async (c) => {
    const [row] = await db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(eq(notification.userId, actorOf(c).id), isNull(notification.readAt)));
    return c.json({ unread: row?.unread ?? 0 });
  });
