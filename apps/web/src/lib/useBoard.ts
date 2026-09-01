import { useCallback, useEffect, useRef, useState } from "react";
import { dequeue, enqueue, readQueue } from "./queue.js";
import { connect } from "./realtime.js";
import {
  reduce,
  type BoardState,
  type Meta,
  type MutationBody,
  type MutationEnvelope,
  type MutationRecord,
} from "@pergola/shared";

/**
 * Everything the board needs to stay in sync.
 *
 * The rule that keeps this small: the live connection writes to state, it never
 * triggers a refetch. A card moving on someone else's screen costs zero
 * round-trips on yours. And the same `reduce()` from @pergola/shared serves the
 * optimistic path and the live path, so if it is right once it is right twice.
 */
export function useBoard(boardId: string | null, meId: string | null) {
  const [state, setState] = useState<BoardState | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // Inverses of our own writes, newest last. Undo pops one and submits it as a
  // fresh mutation — so undo is replicated, undoable, and visible to everyone.
  const undoStack = useRef<MutationBody[]>([]);
  // Read inside the frame handler without making it a dependency.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!boardId) return;
    const r = await fetch(`/api/boards/${boardId}`);
    if (!r.ok) {
      setError("That board could not be loaded.");
      return;
    }
    const snapshot = (await r.json()) as BoardState;
    seqRef.current = snapshot.seq;
    setState(snapshot);
  }, [boardId]);

  useEffect(() => {
    setState(null);
    undoStack.current = [];
    void load();
  }, [load]);

  // ---- live: subscribe from the snapshot cursor, then stay caught up ----
  useEffect(() => {
    if (!boardId || !state) return;
    /*
     * Which transport this is — a WebSocket or an SSE stream — depends on where
     * the instance is deployed, and is entirely lib/realtime.ts's problem. From
     * here it is one thing: frames arrive, and reconnecting resumes from the
     * cursor, so the catch-up path and the steady-state path are the same code.
     */
    const conn = connect(boardId, {
      cursor: () => seqRef.current,
      onLive: setLive,
      onFrame: (frame) => {
        if (frame.type !== "delta") return;
        applyDelta(frame.mutations);
      },
    });
    return () => {
      setLive(false);
      conn.close();
    };
    // Only re-run when the board changes, not on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, state !== null]);

  const applyDelta = useCallback((records: MutationRecord[]) => {
    setState((prev) => {
      if (!prev) return prev;
      let next = prev;
      for (const rec of records) {
        if (rec.seq <= next.seq) continue;
        // reduce() is idempotent per mutation, so our own echo is a no-op — and
        // where it is not (comments), the server's meta overwrites our guess.
        const meta: Meta = { actorId: rec.actorId, at: rec.createdAt };
        next = { ...reduce(next, rec.body, meta), seq: rec.seq };
      }
      seqRef.current = next.seq;
      return next;
    });
  }, []);

  /**
   * Send one envelope.
   *
   * Two failures that look alike and must not be treated alike: the server
   * refusing the change (a 4xx — roll back and say why) and the network being
   * gone (fetch throws — keep the optimistic state and queue it). Conflating
   * them either loses work offline or hides real rejections.
   */
  const send = useCallback(
    async (envelope: MutationEnvelope, queued: boolean): Promise<"ok" | "refused" | "offline"> => {
      try {
        const r = await fetch("/api/mutations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        });
        if (!r.ok) {
          const { message } = (await r.json().catch(() => ({}))) as { message?: string };
          setError(message ?? "That change could not be saved.");
          if (queued) dequeue(envelope.boardId, envelope.id);
          await load();
          return "refused";
        }
        const rec = (await r.json()) as MutationRecord;
        if (rec.inverse) undoStack.current.push(rec.inverse);
        applyDelta([rec]);
        if (queued) dequeue(envelope.boardId, envelope.id);
        return "ok";
      } catch {
        return "offline";
      }
    },
    [load, applyDelta],
  );

  /**
   * Apply locally first so the interaction lands at 0 ms, then confirm.
   *
   * On rejection we reload the snapshot rather than restoring a captured one:
   * other people's deltas may have arrived in between, and a captured snapshot
   * would silently throw those away.
   */
  const apply = useCallback(
    async (body: MutationBody) => {
      if (!boardId) return;
      // Optimistically we are the actor and the clock is local; the echo corrects
      // both. Keeping identity out of the mutation body means a client cannot
      // claim to be someone else.
      const optimistic: Meta = { actorId: meId, at: new Date().toISOString() };
      setState((prev) => (prev ? reduce(prev, body, optimistic) : prev));

      const envelope: MutationEnvelope = { id: crypto.randomUUID(), boardId, body };
      const outcome = await send(envelope, false);
      if (outcome === "offline") {
        setPending(enqueue(boardId, envelope));
        setError("Offline — your change is saved here and will sync when the connection returns.");
      }
    },
    [boardId, meId, send],
  );

  /**
   * Replay whatever is waiting, oldest first.
   *
   * Order matters: a card created offline and then moved has to arrive in that
   * order. Idempotency by mutation id means a partial drain can simply be run
   * again rather than reconciled.
   */
  const drain = useCallback(async () => {
    if (!boardId) return;
    const queued = readQueue(boardId);
    if (queued.length === 0) return;
    for (const envelope of queued) {
      const outcome = await send(envelope, true);
      if (outcome === "offline") break; // still down; keep the rest for later
    }
    setPending(readQueue(boardId).length);
  }, [boardId, send]);

  // Drain on load, whenever the connection comes back, and when the browser says so.
  useEffect(() => {
    if (!boardId) return;
    setPending(readQueue(boardId).length);
    void drain();
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [boardId, drain]);

  useEffect(() => {
    if (live) void drain();
  }, [live, drain]);

  const undo = useCallback(() => {
    const inverse = undoStack.current.pop();
    if (inverse) void apply(inverse);
  }, [apply]);

  // Undo is a first-class action, so it gets the shortcut people already know.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement &&
        (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  return {
    state,
    live,
    /** Re-read the snapshot. For writes the server makes on its own, like uploads. */
    refresh: load,
    /** Mutations written while offline, waiting to sync. */
    pending,
    error,
    apply,
    undo,
    canUndo: undoStack.current.length > 0,
    dismissError: () => setError(null),
    /** Local-only reorder while a drag is in flight; committed once on drop. */
    setState,
  };
}
