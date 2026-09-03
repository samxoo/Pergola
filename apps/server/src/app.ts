import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { eq } from "drizzle-orm";
import { auth } from "./auth.js";
import { Forbidden } from "./auth/guard.js";
import { Stale } from "./mutations/handlers.js";
import { env } from "./env.js";
import { busStatus } from "./realtime/bus.js";
import { isServerless, runtime } from "./runtime.js";
import { db } from "./db/index.js";
import { invite, user } from "./db/schema.js";
import { hashInvite, mayJoin } from "./auth/instance.js";
import { admin } from "./routes/admin.js";
import { boards } from "./routes/boards.js";
import { files } from "./routes/files.js";
import { integrations } from "./routes/integrations.js";
import { publicBoards } from "./routes/public.js";
import { stream } from "./routes/stream.js";
import { mcp } from "./mcp/route.js";

/**
 * The application, and nothing else.
 *
 * Deliberately free of side effects: no port is bound, no migration runs and no
 * connection is opened by importing this file. That is what lets the same app
 * be served by a long-lived Node process (index.ts) and by a serverless
 * function woken per request (api/[[...route]].ts) without either one importing
 * machinery the other cannot use.
 */
export const app = new Hono();

if (env.NODE_ENV === "development") app.use("*", logger());

/**
 * One place that turns domain errors into status codes.
 *
 * Without it an authorization failure surfaces as a 500, which tells the caller
 * the server broke rather than that they lack access — and buries a real bug the
 * next time one happens.
 */
app.onError((err, c) => {
  if (err instanceof Forbidden) return c.json({ message: err.message }, 403);
  if (err instanceof Stale) return c.json({ message: err.message }, 409);
  console.error("[unhandled]", err);
  return c.json({ message: "Something went wrong on the server" }, 500);
});

/*
 * A ceiling on request bodies.
 *
 * Without one, an import is parsed into memory and then held in a single long
 * transaction against a ten-connection pool — a few of those at once and the
 * instance stops serving anybody. The file route enforces its own smaller limit.
 */
app.use("/api/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }));

/**
 * Is this instance actually able to serve?
 *
 * Answered differently per runtime because "healthy" means different things. A
 * container that is up but whose listener has died should fail its healthcheck
 * rather than degrade silently. A serverless function has no listener to lose:
 * each stream carries its own, so being able to answer at all is the whole test.
 */
function health(c: Context) {
  const bus = busStatus();
  const ok = isServerless || bus.live;
  return c.json(
    {
      ok,
      runtime,
      realtime: isServerless ? { mode: "stream", live: true } : bus,
      // Surfaced so an operator can notice it is on without reading the config.
      ...(env.WEBHOOK_ALLOW_PRIVATE ? { warning: "webhooks may reach private addresses" } : {}),
    },
    ok ? 200 : 503,
  );
}

// Both spellings: /health is the conventional one a container healthcheck uses,
// and /api/health is reachable on a host that only routes /api to the function.
app.get("/health", health);
app.get("/api/health", health);

/*
 * Who may create an account.
 *
 * Checked inside the wildcard rather than as its own route. An exact-path route
 * in front of a wildcard is not a gate: Hono matches paths strictly, so
 * "/api/auth/sign-up/email/" skips the exact route and falls through to the
 * handler behind it. Normalising here means no spelling of the path can get
 * past the check, and it stays true for whatever route is added next.
 */
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/\/+$/, "");

  if (c.req.method === "POST" && path === "/api/auth/sign-up/email") {
    let email = "";
    let token: string | undefined;
    try {
      const body = (await c.req.raw.clone().json()) as { email?: string; inviteToken?: string };
      email = String(body.email ?? "");
      token = body.inviteToken;
    } catch {
      return c.json({ message: "That sign-up could not be read" }, 400);
    }

    const verdict = await mayJoin(email, token);
    if (!verdict.ok) return c.json({ message: verdict.message }, 403);

    const res = await auth.handler(c.req.raw);

    if (res.ok) {
      await db.transaction(async (tx) => {
        // The first account to exist owns the instance; otherwise a fresh box is
        // a locked room with the key inside.
        if (verdict.role !== "member") {
          await tx.update(user).set({ role: verdict.role }).where(eq(user.email, email.toLowerCase()));
        }
        // An invitation redeemed through the ordinary form must still be spent,
        // or it stays valid until it expires and its role is silently dropped.
        if (token) {
          await tx
            .update(invite)
            .set({ acceptedAt: new Date() })
            .where(eq(invite.tokenHash, hashInvite(token)));
        }
      });
    }
    return res;
  }

  return auth.handler(c.req.raw);
});

// Mounted before the authenticated API so it never inherits its middleware.
app.route("/api/public", publicBoards);
// Likewise: the MCP endpoint does its own bearer check, and answers a missing
// token with the challenge an MCP client understands, not a sign-in message.
app.route("/api", mcp);

const api = app
  .route("/api", admin)
  .route("/api", boards)
  .route("/api", integrations)
  .route("/api", files)
  .route("/api", stream);

export type AppType = typeof api;
