import pg from "pg";
import type { ServerFrame } from "@pergola/shared";
import { listenUrl, realtimeMode } from "../env.js";
import { since } from "../mutations/commit.js";

export type Subscriber = {
  boardId: string;
  /** Last sequence this subscriber has been sent. Its sync cursor. */
  cursor: number;
  send: (frame: ServerFrame) => void;
};

/** boardId -> everyone on this replica watching it. */
const rooms = new Map<string, Set<Subscriber>>();

export function join(sub: Subscriber): void {
  let room = rooms.get(sub.boardId);
  if (!room) rooms.set(sub.boardId, (room = new Set()));
  room.add(sub);
}

export function leave(sub: Subscriber): void {
  const room = rooms.get(sub.boardId);
  if (!room) return;
  room.delete(sub);
  if (room.size === 0) rooms.delete(sub.boardId);
}

/**
 * Push everything a subscriber is missing.
 *
 * A client that reconnects after ten minutes offline and one that is merely a
 * single mutation behind take exactly the same path — there is no separate
 * "catch up" mode to get wrong.
 */
export async function flush(sub: Subscriber): Promise<void> {
  const pending = await since(sub.boardId, sub.cursor);
  if (pending.length === 0) return;
  sub.cursor = pending[pending.length - 1]!.seq;
  sub.send({ type: "delta", boardId: sub.boardId, mutations: pending });
}

async function fanOut(boardId: string, seq: number): Promise<void> {
  const room = rooms.get(boardId);
  if (!room?.size) return; // nobody on this replica is watching it
  await Promise.all(
    [...room].filter((s) => s.cursor < seq).map((s) => flush(s).catch(reportSendFailure)),
  );
}

function reportSendFailure(err: unknown): void {
  console.error("[realtime] failed to deliver a delta:", err);
}

let stop: (() => Promise<void>) | null = null;

/** Start listening for board changes. Returns once the listener is live. */
export async function startBus(): Promise<void> {
  if (realtimeMode === "poll") return startPolling();

  const client = new pg.Client({ connectionString: listenUrl });

  client.on("error", (err) => {
    console.error("[realtime] listener connection lost, reconnecting in 1s:", err.message);
    setTimeout(() => void startBus().catch(() => {}), 1000);
  });

  await client.connect();
  await client.query("LISTEN board_changed");

  client.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      const { boardId, seq } = JSON.parse(msg.payload) as { boardId: string; seq: number };
      void fanOut(boardId, seq);
    } catch (err) {
      console.error("[realtime] unreadable notification payload:", err);
    }
  });

  stop = async () => {
    await client.end();
  };
  console.log("[realtime] listening on board_changed");
}

/**
 * Fallback for when DATABASE_URL is a transaction-mode pooler and no direct URL
 * was given. Correct but chatty — env.ts warns loudly at boot rather than
 * letting the operator believe realtime is working.
 */
function startPolling(): void {
  const timer = setInterval(() => {
    for (const [boardId, room] of rooms) {
      const behind = [...room].sort((a, b) => a.cursor - b.cursor)[0];
      if (behind) void flush(behind).catch(reportSendFailure);
      for (const sub of room) if (sub !== behind) void flush(sub).catch(reportSendFailure);
      void boardId;
    }
  }, 2000);
  timer.unref();
  stop = async () => clearInterval(timer);
  console.log("[realtime] polling every 2s (pooled connection, no direct URL)");
}

export async function stopBus(): Promise<void> {
  await stop?.();
  stop = null;
}

/** For the health endpoint: is fan-out actually wired up? */
export function busStatus(): { mode: string; live: boolean; rooms: number } {
  return { mode: realtimeMode, live: stop !== null, rooms: rooms.size };
}
