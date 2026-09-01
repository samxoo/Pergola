/**
 * Which world this process is running in.
 *
 * Pergola ships two deployments from one codebase:
 *
 *   "node"        one long-lived process — the container, a VM, `pnpm start`.
 *                 It binds a port, holds a Postgres LISTEN connection open and
 *                 upgrades WebSockets.
 *
 *   "serverless"  a function that is woken per request and frozen after the
 *                 response — Vercel. Nothing survives between invocations, so
 *                 there is no port to bind, no socket to upgrade and no shared
 *                 in-process bus; the SSE route in routes/stream.ts polls the
 *                 mutation log for the life of one request instead.
 *
 * Detected rather than configured, because getting it wrong is silent: a
 * WebSocket that never connects or a listener that never fires looks exactly
 * like a quiet board. RUNTIME overrides the detection for a host this does not
 * know about yet.
 */
export type Runtime = "node" | "serverless";

function detect(): Runtime {
  const forced = process.env.RUNTIME?.trim();
  if (forced === "node" || forced === "serverless") return forced;
  // Vercel sets this in every function invocation and every build.
  return process.env.VERCEL ? "serverless" : "node";
}

export const runtime: Runtime = detect();
export const isServerless = runtime === "serverless";

/**
 * Vercel's per-request `waitUntil`, if this invocation has one.
 *
 * Read through the request-context symbol rather than importing
 * `@vercel/functions`, so a self-hosted install does not carry a dependency on
 * a platform it will never run on.
 */
type RequestContext = { waitUntil?: (p: Promise<unknown>) => void };
function waitUntil(): ((p: Promise<unknown>) => void) | null {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    | { get?: () => RequestContext | undefined }
    | undefined;
  const fn = ctx?.get?.()?.waitUntil;
  return typeof fn === "function" ? fn : null;
}

/**
 * Work that should outlive the response — a webhook delivery, say.
 *
 * On a long-lived process this is fire-and-forget and returns immediately. On a
 * serverless host the instance is frozen the moment the response is sent, so
 * fire-and-forget means "sometimes delivered": the platform's `waitUntil` keeps
 * it alive if there is one, and failing that the caller awaits it and pays the
 * latency. Slower is the right failure here — a webhook that silently stops
 * firing in production is much harder to notice than a slow one.
 */
export function background(work: Promise<unknown>, label: string): Promise<void> {
  const swallow = work.catch((err) => console.error(`[${label}]`, err)).then(() => undefined);

  if (!isServerless) return Promise.resolve();

  const keepAlive = waitUntil();
  if (keepAlive) {
    keepAlive(swallow);
    return Promise.resolve();
  }
  return swallow;
}
