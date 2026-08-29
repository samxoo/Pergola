import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { invite, user } from "./db/schema.js";
import { hashInvite, mayJoin } from "./auth/instance.js";
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

/*
 * A ceiling on request bodies.
 *
 * Without one, an import is parsed into memory and then held in a single long
 * transaction against a ten-connection pool — a few of those at once and the
 * instance stops serving anybody. The file route enforces its own smaller limit.
 */
app.use("/api/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }));

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
          userId: session.user.id,
          // Both halves of revocation: taken off the board, or deactivated.
          stillAllowed: async (userId, boardId) => {
            const [live] = await db
              .select({ deactivatedAt: user.deactivatedAt })
              .from(user)
              .where(eq(user.id, userId))
              .limit(1);
            if (!live || live.deactivatedAt) return false;
            return (await roleOn(boardId, userId)) !== null;
          },
          close: () => ws.close(),
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
