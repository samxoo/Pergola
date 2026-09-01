import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ServerFrame } from "@pergola/shared";
import { actorOf, requireUser, roleOn, stillHasAccess, type Env } from "../auth/guard.js";
import { busStatus, flush, join, leave, type Subscriber } from "../realtime/bus.js";

/**
 * The same realtime protocol as /ws, over Server-Sent Events.
 *
 * It exists because a serverless host cannot hold a WebSocket: the function is
 * woken per request and frozen after the response, so there is no process to
 * upgrade a connection or to keep a Postgres LISTEN open. SSE is a plain HTTP
 * response that stays open, which every host can do — and the protocol was
 * already one-directional, so nothing is lost. The client says what it wants in
 * the query string instead of a subscribe frame; the server only ever pushes.
 *
 * The frames on the wire are the same ServerFrame values the socket sends, so
 * the client's handling of a delta is one code path, not two.
 *
 * Both runtimes serve this route. On a long-lived process it attaches to the
 * LISTEN/NOTIFY bus and is pushed to; where there is no bus it polls the
 * mutation log. Same catch-up semantics either way — `since()` from a cursor is
 * the entire sync protocol, and neither path has a separate "catch up" mode to
 * get out of step.
 */

/**
 * How long one stream lives before it closes itself and invites a reconnect.
 *
 * Serverless functions are killed at a hard timeout, and being killed mid-frame
 * is how a client ends up with half a JSON object. Ending first, deliberately,
 * turns a platform limit into an ordinary reconnect — which the cursor already
 * makes free. Default is comfortably under Vercel's shortest (60s) ceiling.
 */
const MAX_SECONDS = clamp(process.env.REALTIME_STREAM_SECONDS, 50, 5, 3600);
const POLL_MS = clamp(process.env.REALTIME_POLL_MS, 2000, 250, 60_000);
/** Idle connections get closed by proxies; a comment frame is enough to keep one. */
const HEARTBEAT_MS = 15_000;
/** How soon the browser should come back after a stream ends. */
const RETRY_MS = 750;

function clamp(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

export const stream = new Hono<Env>()
  .use("/stream", requireUser)
  .get("/stream", async (c) => {
    const boardId = c.req.query("boardId") ?? "";
    if (!z.uuid().safeParse(boardId).success) {
      return c.json({ message: "Not a board id" }, 400);
    }

    const actor = actorOf(c);
    if (!(await roleOn(boardId, actor.id))) {
      // A 403 rather than an empty stream: EventSource gives up on a failed
      // handshake, which is exactly the behaviour we want for "not a member".
      return c.json({ message: "You are not a member of that board" }, 403);
    }

    /*
     * Where to resume from.
     *
     * Last-Event-ID is what the browser replays automatically when a stream
     * ends, so a reconnect resumes exactly where the last frame left off with
     * no client-side bookkeeping. `since` is the opening position, from the
     * snapshot the page already loaded. Whichever is higher wins, and a replay
     * is harmless anyway — the client drops any mutation at or below its cursor.
     */
    const resume = Number(c.req.header("Last-Event-ID"));
    const opening = Number(c.req.query("since"));
    const cursor = Math.max(
      Number.isFinite(resume) && resume >= 0 ? resume : 0,
      Number.isFinite(opening) && opening >= 0 ? opening : 0,
    );

    return streamSSE(c, async (sse) => {
      let done = false;
      /*
       * Writes are chained rather than fired off in parallel. Two overlapping
       * writes to one SSE response can interleave their frames, and half of one
       * JSON object followed by half of another is unparseable on the far end.
       */
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (write: () => Promise<void>): Promise<void> => {
        queue = queue.then(() => (done ? undefined : write())).catch(() => {
          // A write that fails means the far end is gone. Ending the stream is
          // the whole response to that; the client reconnects on its own.
          done = true;
        });
        return queue;
      };
      const write = (frame: ServerFrame, id: number) => {
        void enqueue(() => sse.writeSSE({ data: JSON.stringify(frame), id: String(id) }));
      };

      const sub: Subscriber = {
        boardId,
        cursor,
        userId: actor.id,
        send: (frame) => write(frame, frame.type === "delta" ? lastSeq(frame, sub.cursor) : sub.cursor),
        stillAllowed: stillHasAccess,
        close: () => {
          done = true;
        },
      };

      // An opening frame, so Last-Event-ID is set before anything happens on the
      // board — otherwise a reconnect after a quiet minute would replay from the
      // page's original cursor instead of the current one.
      await sse.writeSSE({
        data: JSON.stringify({ type: "hello", boardId, seq: cursor } satisfies ServerFrame),
        id: String(cursor),
        retry: RETRY_MS,
      });

      const live = busStatus().live;
      if (live) join(sub);

      sse.onAbort(() => {
        done = true;
        if (live) leave(sub);
      });

      const deadline = Date.now() + MAX_SECONDS * 1000;
      let lastBeat = Date.now();

      // Anything that happened between the snapshot and this connection.
      await flush(sub).catch(reportFailure);

      while (!done && !sse.aborted && Date.now() < deadline) {
        await sleep(live ? HEARTBEAT_MS : POLL_MS);
        if (done || sse.aborted) break;

        // Without a bus there is nothing to push us, so we ask. With one, the
        // fan-out has already written and this is only a keep-alive.
        if (!live) await flush(sub).catch(reportFailure);

        if (Date.now() - lastBeat >= HEARTBEAT_MS) {
          lastBeat = Date.now();
          // A named event rather than a message: it keeps proxies from reaping
          // an idle connection and is invisible to the client's frame handler.
          await enqueue(() => sse.writeSSE({ event: "ping", data: "" }));
        }
      }

      if (live) leave(sub);
      await queue;
    });
  });

function lastSeq(frame: Extract<ServerFrame, { type: "delta" }>, fallback: number): number {
  return frame.mutations[frame.mutations.length - 1]?.seq ?? fallback;
}

function reportFailure(err: unknown): void {
  console.error("[stream] failed to deliver a delta:", err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
