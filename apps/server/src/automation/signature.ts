import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing, on its own.
 *
 * Pure crypto with no database or configuration behind it, so a receiver — or a
 * test — can import it without standing up a server. That separation is the
 * whole reason this is not inside webhooks.ts.
 *
 * The timestamp is signed alongside the body so a captured delivery cannot be
 * replayed later against a receiver that checks it.
 */
export function sign(secret: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verify(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  const expected = Buffer.from(sign(secret, body, timestamp));
  const given = Buffer.from(signature);
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return expected.length === given.length && timingSafeEqual(expected, given);
}
