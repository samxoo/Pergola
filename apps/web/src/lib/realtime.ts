import type { ServerFrame } from "@pergola/shared";

/**
 * The live connection to a board, over whichever transport this deployment has.
 *
 * A self-hosted Pergola is one long-lived process, so it can hold a WebSocket
 * open and push. A serverless deployment cannot: the function is woken per
 * request and frozen after the response, so there is nothing to upgrade. It
 * serves the same frames over Server-Sent Events instead.
 *
 * The protocol was already one-directional — the server pushes deltas, the
 * client only ever says where it is — so both transports carry the identical
 * ServerFrame values and the caller cannot tell which one it got.
 *
 * Which to use is asked once per page load rather than guessed, because a
 * WebSocket that will never connect fails slowly and looks exactly like a quiet
 * network. The guess is still there underneath as a safety net, for a host that
 * proxies HTTP but silently drops upgrades.
 */

type Transport = "ws" | "sse";

export type Handlers = {
  onFrame: (frame: ServerFrame) => void;
  onLive: (live: boolean) => void;
  /** Read at every (re)connect, so catching up and staying caught up are one path. */
  cursor: () => number;
};

let probe: Promise<Transport> | null = null;

/**
 * What this deployment last told us it was.
 *
 * The answer cannot change without a redeploy, and asking costs a round trip on
 * the path between opening a board and seeing it go live. So remember it, use it
 * immediately on the next visit, and re-ask in the background — a stale answer
 * survives one load at worst, and both the refresh and the dead-socket fallback
 * below correct it.
 */
const REMEMBERED = "pergola.transport";

function remembered(): Transport | null {
  try {
    const saved = localStorage.getItem(REMEMBERED);
    return saved === "ws" || saved === "sse" ? saved : null;
  } catch {
    return null; // Private mode or blocked storage: just ask.
  }
}

/** Ask the server what it is. Cached for the page: it cannot change under us. */
function preferred(): Promise<Transport> {
  probe ??= fetch("/api/health")
    .then((r) => (r.ok ? (r.json() as Promise<{ runtime?: string }>) : null))
    .then((body) => {
      const kind: Transport = body?.runtime === "serverless" ? "sse" : "ws";
      try {
        localStorage.setItem(REMEMBERED, kind);
      } catch {
        // Not persisting only costs the next load one round trip.
      }
      return kind;
    })
    // An unreachable health endpoint says nothing about transports. Assume the
    // self-hosted shape, which the fallback below corrects if it is wrong.
    .catch(() => "ws" as Transport);
  return probe;
}

/** Set once a WebSocket has proved it cannot connect here. Sticky for the page. */
let ruledOut: Transport | null = null;

export function connect(boardId: string, h: Handlers): { close: () => void } {
  let closed = false;
  let dispose: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 500;
  /** Sockets that closed without ever delivering a frame, in a row. */
  let mute = 0;

  const again = () => {
    if (closed) return;
    h.onLive(false);
    retry = setTimeout(() => void start(), backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };

  const settled = () => {
    backoff = 500;
    mute = 0;
    h.onLive(true);
  };

  const openSocket = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    let heard = false;

    ws.onopen = () => {
      // Not live until it answers: an upgrade that a proxy accepts and then
      // drops opens cleanly and then says nothing at all.
      ws.send(JSON.stringify({ type: "subscribe", boardId, since: h.cursor() }));
    };
    ws.onmessage = (ev) => {
      if (!heard) {
        heard = true;
        settled();
      }
      h.onFrame(JSON.parse(ev.data as string) as ServerFrame);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      /*
       * Two sockets in a row that opened and never spoke means this host does
       * not really carry WebSockets, whatever it claimed. Stop asking — the SSE
       * route is served by every deployment, so there is always somewhere to go.
       */
      if (!heard && ++mute >= 2) ruledOut = "ws";
      again();
    };

    return () => ws.close();
  };

  const openStream = () => {
    const url = `/api/stream?boardId=${encodeURIComponent(boardId)}&since=${h.cursor()}`;
    const es = new EventSource(url);

    es.onopen = () => settled();
    es.onmessage = (ev) => h.onFrame(JSON.parse(ev.data) as ServerFrame);
    es.onerror = () => {
      h.onLive(false);
      /*
       * EventSource reconnects itself when a stream ends — which ours do, on
       * purpose, before a serverless host times them out — and replays
       * Last-Event-ID so nothing is missed. It gives up only on a refused
       * handshake, and that is the one case worth retrying by hand.
       */
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        again();
      }
    };

    return () => es.close();
  };

  const start = async () => {
    if (closed) return;

    // Connect on what we already know, and only wait when we know nothing.
    const known = ruledOut === "ws" ? "sse" : remembered();
    if (known) void preferred(); // refresh for next time, off the critical path
    const kind = known ?? (await preferred());

    if (closed) return;
    dispose = kind === "sse" ? openStream() : openSocket();
  };

  void start();

  return {
    close: () => {
      closed = true;
      clearTimeout(retry);
      dispose?.();
    },
  };
}
