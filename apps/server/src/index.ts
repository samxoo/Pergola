import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer } from "ws";
import type { ClientFrame, ServerFrame } from "@pergola/shared";
import { app } from "./app.js";
import { auth } from "./auth.js";
import { roleOn, stillHasAccess } from "./auth/guard.js";
import { runMigrations } from "./db/migrate.js";
import { env, warnIfDegraded } from "./env.js";
import { flush, join, leave, startBus, type Subscriber } from "./realtime/bus.js";

/**
 * The long-lived deployment: one process, one port, serving both the API and the
 * built client. The container image and `pnpm start` run this file.
 *
 * Everything here is what a process that stays alive can do and a serverless
 * function cannot — bind a port, upgrade a WebSocket, hold a Postgres LISTEN
 * connection open, migrate once at boot. The app itself lives in app.ts and is
 * shared with api/[[...route]].ts, so the two deployments cannot drift apart.
 */

warnIfDegraded();
await runMigrations();
await startBus();

/**
 * The socket carries log deltas and nothing else. It is a cache-invalidation
 * channel, not a second serialisation format that could disagree with the REST
 * response.
 *
 * It is authenticated exactly like the REST API — the session cookie rides along
 * on the upgrade request — and every subscribe re-checks board membership, so a
 * socket cannot become a back door into a board the person cannot open.
 *
 * A client that cannot reach this — because the instance is deployed somewhere
 * sockets do not exist — falls back to /api/stream, which speaks the same frames
 * over SSE.
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
          stillAllowed: stillHasAccess,
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
// container on one port with no reverse proxy in the way. Registered last, after
// every API route, because the catch-all would otherwise swallow them.
if (env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./public" }));
  app.get("*", serveStatic({ path: "./public/index.html" }));
}

const wss = new WebSocketServer({ noServer: true });

serve({ fetch: app.fetch, port: env.PORT, websocket: { server: wss } }, (info) => {
  console.log(`Pergola listening on http://localhost:${info.port}`);
});
