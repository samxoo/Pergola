import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { app } from "./app.js";

/**
 * The app as a Node request listener, for a serverless host that speaks
 * `(req, res)`.
 *
 * Vercel's Node runtime invokes a default-exported function with Node's own
 * request and response objects. Handing it something that takes a `Request` and
 * returns a `Response` does not fail — it is simply called with `(req, res)`,
 * the returned promise is dropped, and nothing ever ends the response, so every
 * request hangs until the platform's timeout kills it. A 60s stall with no body
 * and no log line is a miserable thing to debug, so the shape is explicit here
 * rather than inferred from a function's arity.
 *
 * The adapter is the same one the long-lived server uses, so streaming — which
 * the SSE route depends on — behaves identically in both deployments.
 */
const listener = getRequestListener(app.fetch);

export default async function handler(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  /*
   * TLS terminates at the edge, so the socket here is plain HTTP and the
   * adapter would reconstruct an http:// URL for a request the browser made
   * over https. It takes an absolute URL verbatim, so give it the real one:
   * anything deriving a link, a callback or a cookie's Secure flag from the
   * request should see the scheme the client actually used.
   */
  const forwarded = header(incoming, "x-forwarded-proto");
  const scheme = forwarded === "http" || forwarded === "https" ? forwarded : "https";
  const host = header(incoming, "x-forwarded-host") ?? incoming.headers.host;
  if (host && incoming.url?.startsWith("/")) {
    incoming.url = `${scheme}://${host}${incoming.url}`;
  }
  await listener(incoming, outgoing);
}

/** A header may arrive repeated, or as a comma-joined list. Take the first. */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(",")[0]?.trim() || undefined;
}
