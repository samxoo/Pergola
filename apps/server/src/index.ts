import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";
import type { ClientFrame, ServerFrame } from "@pergola/shared";
import { auth } from "./auth.js";
import { Forbidden, roleOn } from "./auth/guard.js";
import { Stale } from "./mutations/handlers.js";
import { runMigrations } from "./db/migrate.js";
import { env, warnIfDegraded } from "./env.js";
import { busStatus, flush, join, leave, startBus, type Subscriber } from "./realtime/bus.js";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { user } from "./db/schema.js";
import { mayJoin } from "./auth/instance.js";
import { admin } from "./routes/admin.js";
import { boards } from "./routes/boards.js";
import { files } from "./routes/files.js";
import { integrations } from "./routes/integrations.js";
import { publicBoards } from "./routes/public.js";

warnIfDegraded();
await runMigrations();
await startBus();

const app = new Hono();
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

app.get("/health", (c) => {
  const bus = busStatus();
  // A container that is up but not receiving notifications should fail its
  // healthcheck, not degrade silently.
  return c.json(
    {
      ok: bus.live,
      realtime: bus,
      // Surfaced so an operator can notice it is on without reading the config.
      ...(env.WEBHOOK_ALLOW_PRIVATE ? { warning: "webhooks may reach private addresses" } : {}),
    },
    bus.live ? 200 : 503,
  );
});

/*
 * Who may create an account.
 *
 * Checked here rather than inside Better Auth so the rule is visible in the
 * routing, and so it applies to every sign-up path at once. Without it, anyone
 * who can reach the URL has an account — which is exactly what a company
 * running this on the internet does not want.
 */
app.post("/api/auth/sign-up/email", async (c, next) => {
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

  await next();
  // The first account to exist owns the instance; otherwise a fresh box is a
  // locked room with the key inside.
  if (verdict.role === "owner") {
    await db.update(user).set({ role: "owner" }).where(eq(user.email, email.toLowerCase()));
  }
});

// Better Auth owns sign-up, sign-in, sessions and cookies under this prefix.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Mounted before the authenticated API so it never inherits its middleware.
app.route("/api/public", publicBoards);

const api = app
  .route("/api", admin)
  .route("/api", boards)
  .route("/api", integrations)
  .route("/api", files);

/**
 * The socket carries log deltas and nothing else. It is a cache-invalidation
 * channel, not a second serialisation format that could disagree with the REST
 * response.
 *
 * It is authenticated exactly like the REST API — the session cookie rides along
 * on the upgrade request — and every subscribe re-checks board membership, so a
 * socket cannot become a back door into a board the person cannot open.
 */
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    let sub: Subscriber | null = null;

    return {
      async onMessage(event, ws) {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(event.data)) as ClientFrame;
        } catch {
          return send(ws, { type: "error", message: "Unreadable frame" });
        }

        if (frame.type === "ping") return;
        if (frame.type !== "subscribe") return;

        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session?.user) {
          return send(ws, { type: "error", message: "Sign in to continue" });
        }
        if (!(await roleOn(frame.boardId, session.user.id))) {
          return send(ws, { type: "error", message: "You are not a member of that board" });
        }

        if (sub) leave(sub);
        sub = {
          boardId: frame.boardId,
          cursor: frame.since,
          send: (f) => send(ws, f),
        };
        join(sub);
        send(ws, { type: "hello", boardId: frame.boardId, seq: frame.since });
        // Anything that happened between the snapshot and this subscribe.
        void flush(sub);
      },
      onClose() {
        if (sub) leave(sub);
        sub = null;
      },
      onError(err) {
        console.error("[ws]", err);
        if (sub) leave(sub);
        sub = null;
      },
    };
  }),
);

function send(ws: { send: (data: string) => void }, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

// In production the server also serves the built client, so the whole app is one
// container on one port with no reverse proxy in the way.
if (env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.get("*", serveStatic({ path: "./public/index.html" }));
}

const wss = new WebSocketServer({ noServer: true });

serve({ fetch: app.fetch, port: env.PORT, websocket: { server: wss } }, (info) => {
  console.log(`Pergola listening on http://localhost:${info.port}`);
});

export type AppType = typeof api;
