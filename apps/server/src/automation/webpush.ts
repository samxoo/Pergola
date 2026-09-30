import { and, eq, inArray, isNull } from "drizzle-orm";
import webpush from "web-push";
import { db } from "../db/index.js";
import { pushSubscription, setting, user } from "../db/schema.js";
import { env } from "../env.js";
import { BlockedAddress, resolvePublic } from "./ssrf.js";

/**
 * Web Push: a notification that reaches someone with Pergola closed.
 *
 * The in-app bell is still the record. This is only the tap on the shoulder
 * that sends someone to it, so a push that fails is logged and dropped — it
 * never holds up, or fails, the change that caused it.
 */

const VAPID_KEY = "push.vapid";

type Keys = { publicKey: string; privateKey: string };

let keys: Promise<Keys> | null = null;

/**
 * The instance's push keys, made the first time anyone asks for them.
 *
 * Stored rather than configured, so push works on a fresh box with nothing to
 * set up. Insert-if-absent and then read back: two instances racing to make the
 * first pair both end up signing with whichever one landed. Changing the pair
 * would silently orphan every subscription, so nothing here ever does.
 */
export function vapidKeys(): Promise<Keys> {
  keys ??= (async () => {
    const fresh = webpush.generateVAPIDKeys();
    await db.insert(setting).values({ key: VAPID_KEY, value: fresh }).onConflictDoNothing();
    const [row] = await db.select().from(setting).where(eq(setting.key, VAPID_KEY)).limit(1);
    return row!.value as Keys;
  })().catch((err: unknown) => {
    keys = null; // a failed read is retried on the next ask, not cached forever
    throw err;
  });
  return keys;
}

/**
 * Who the push services should contact about this sender.
 *
 * They want an https: page or a mailto:. The instance's own address when it is
 * public; otherwise a mailto: that names no one, because a localhost URL is one
 * Apple's service refuses outright.
 */
const subject = env.BETTER_AUTH_URL.startsWith("https://")
  ? env.BETTER_AUTH_URL
  : "mailto:push@pergola.invalid";

export type PushMessage = {
  title: string;
  body: string;
  /** Where a tap on it lands, as a path on this instance. */
  url: string;
  /** Notifications with one tag replace each other instead of piling up. */
  tag: string;
};

/**
 * Send one message to every device these people turned push on for.
 *
 * The message is composed only once there is a device to send it to: most
 * notifications go to people with push off, and they should cost one query.
 */
export async function pushTo(userIds: string[], compose: () => Promise<PushMessage>): Promise<void> {
  if (userIds.length === 0) return;
  // An account that has been shut out stops hearing about the boards it was on.
  const subs = await db
    .select({
      id: pushSubscription.id,
      endpoint: pushSubscription.endpoint,
      p256dh: pushSubscription.p256dh,
      auth: pushSubscription.auth,
    })
    .from(pushSubscription)
    .innerJoin(user, eq(user.id, pushSubscription.userId))
    .where(and(inArray(pushSubscription.userId, userIds), isNull(user.deactivatedAt)));
  if (subs.length === 0) return;

  const { publicKey, privateKey } = await vapidKeys();
  const payload = JSON.stringify(await compose());

  await Promise.all(
    subs.map(async (s) => {
      try {
        // Checked again on the way out, as a webhook is: DNS is not a promise.
        await resolvePublic(s.endpoint);
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          {
            vapidDetails: { subject, publicKey, privateKey },
            // A day: a phone that was off overnight still hears about it.
            TTL: 60 * 60 * 24,
            timeout: 10_000,
          },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // Gone: the browser unsubscribed, or the person cleared its data. Or
        // the address now points somewhere no request of ours should go.
        if (status === 404 || status === 410 || err instanceof BlockedAddress) {
          await db.delete(pushSubscription).where(eq(pushSubscription.id, s.id));
        } else {
          console.error("[push] delivery failed:", status ?? err);
        }
      }
    }),
  );
}
