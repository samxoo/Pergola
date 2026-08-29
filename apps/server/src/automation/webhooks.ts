import { and, eq } from "drizzle-orm";
import type { MutationRecord } from "@pergola/shared";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { webhook } from "../db/schema.js";
import { sign } from "./signature.js";
import { BlockedAddress, resolvePublic } from "./ssrf.js";

/**
 * Outbound webhooks.
 *
 * A signature rather than a bearer token, because the receiver needs to prove
 * the payload came from here *and* that it was not altered — and because a
 * shared secret that never travels is one fewer credential to leak.
 */
const TIMEOUT_MS = 5000;

export { sign, verify } from "./signature.js";

/**
 * Fire and forget, but record the outcome.
 *
 * Delivery must never block or fail the mutation that triggered it — an
 * unreachable endpoint is the endpoint's problem, not the board's. The last
 * status is stored so a broken hook is visible in the UI without reading logs.
 */
export async function deliver(record: MutationRecord): Promise<void> {
  const hooks = await db
    .select()
    .from(webhook)
    .where(and(eq(webhook.boardId, record.boardId), eq(webhook.active, true)));
  if (hooks.length === 0) return;

  const body = JSON.stringify({
    id: record.id,
    boardId: record.boardId,
    seq: record.seq,
    kind: record.body.kind,
    actorId: record.actorId,
    body: record.body,
    createdAt: record.createdAt,
  });
  const timestamp = String(Date.now());

  await Promise.all(
    hooks.map(async (h) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        /*
         * Re-checked on every delivery, not just when the hook was created.
         * A hostname that resolved publicly last week can point at 127.0.0.1
         * today, and the whole point of DNS rebinding is that the check on the
         * way in has already passed.
         */
        await resolvePublic(h.url, { allowPrivate: env.WEBHOOK_ALLOW_PRIVATE });

        const res = await fetch(h.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Pergola-Webhook/1",
            "x-pergola-event": record.body.kind,
            "x-pergola-timestamp": timestamp,
            "x-pergola-signature": sign(h.secret, body, timestamp),
          },
          body,
          signal: controller.signal,
          /*
           * A checked address is worth nothing if the response can redirect the
           * request somewhere else. undici follows up to twenty hops by default,
           * and hop two is not checked by anybody.
           */
          redirect: "manual",
        });
        await db
          .update(webhook)
          .set({
            lastStatus: res.status,
            lastError: res.ok ? null : `HTTP ${res.status}`,
            lastFiredAt: new Date(),
          })
          .where(eq(webhook.id, h.id));
      } catch (err) {
        // A hook that starts pointing somewhere private is switched off, not
        // merely failed — otherwise it retries into the private network forever.
        const blocked = err instanceof BlockedAddress;
        await db
          .update(webhook)
          .set({
            lastStatus: null,
            lastError: err instanceof Error ? err.message : "Delivery failed",
            lastFiredAt: new Date(),
            ...(blocked ? { active: false } : {}),
          })
          .where(eq(webhook.id, h.id));
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
