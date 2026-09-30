import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, requireUser, type Env } from "../auth/guard.js";
import { BlockedAddress, resolvePublic } from "../automation/ssrf.js";
import { vapidKeys } from "../automation/webpush.js";
import { db } from "../db/index.js";
import { pushSubscription } from "../db/schema.js";

/**
 * Turning push on and off for one browser.
 *
 * The endpoint is an address the browser hands us and the server later posts
 * to, which makes it a webhook in all but name — so it gets the webhook's
 * guard: https only, and nothing that resolves into a private network.
 */
const Endpoint = z.string().max(2048).startsWith("https://");

export const push = new Hono<Env>()
  .use("*", requireUser)

  /** The key a browser subscribes with. Made on first ask — see webpush.ts. */
  .get("/push/key", async (c) => c.json({ key: (await vapidKeys()).publicKey }))

  .post(
    "/push/subscribe",
    zValidator(
      "json",
      z.object({
        endpoint: Endpoint,
        keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
      }),
    ),
    async (c) => {
      const { endpoint, keys } = c.req.valid("json");
      try {
        await resolvePublic(endpoint, { allowPrivate: false });
      } catch (err) {
        return c.json(
          { message: err instanceof BlockedAddress ? err.message : "That push address was not accepted" },
          400,
        );
      }
      const userId = actorOf(c).id;
      // A shared computer: whoever turned push on last is who this browser is for.
      await db
        .insert(pushSubscription)
        .values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: { userId, p256dh: keys.p256dh, auth: keys.auth },
        });
      return c.body(null, 204);
    },
  )

  .post("/push/unsubscribe", zValidator("json", z.object({ endpoint: Endpoint })), async (c) => {
    await db
      .delete(pushSubscription)
      .where(
        and(
          eq(pushSubscription.endpoint, c.req.valid("json").endpoint),
          eq(pushSubscription.userId, actorOf(c).id),
        ),
      );
    return c.body(null, 204);
  });
