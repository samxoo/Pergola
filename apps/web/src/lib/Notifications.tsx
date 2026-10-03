import { useEffect, useState } from "react";
import { avatarColor, initials } from "./labels.js";
import { useT } from "./i18n.js";
import { Icon } from "./Icon.js";
import { disablePush, enablePush, isIosBrowser, pushState, type PushState } from "./push.js";

type Note = {
  id: string;
  boardId: string;
  cardId: string | null;
  kind: string;
  body: string;
  actorId: string | null;
  /** Joined by the server: the inbox spans boards, so the open one cannot name everyone. */
  actorName: string | null;
  read: boolean;
  createdAt: string;
};

type Props = {
  onOpen: (boardId: string, cardId: string | null) => void;
  /** An icon instead of the word, for a top bar with no room to spare. */
  compact?: boolean;
};

/**
 * The bell.
 *
 * Polled rather than pushed: notifications are not board-scoped, so they do not
 * ride the board socket, and one request a minute is cheaper than a second
 * socket per client. If this ever needs to be instant, it gets its own channel.
 */
export function Notifications({ onOpen, compact = false }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);

  const refresh = async () => {
    const { unread: n } = (await (await fetch("/api/notifications/count")).json()) as {
      unread: number;
    };
    setUnread(n);
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 60_000);
    // A push that just landed is news now, not in up to a minute.
    const onWorker = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "pergola:notification") void refresh();
    };
    navigator.serviceWorker?.addEventListener("message", onWorker);
    return () => {
      clearInterval(timer);
      navigator.serviceWorker?.removeEventListener("message", onWorker);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setNotes((await (await fetch("/api/notifications")).json()) as Note[]);
      await fetch("/api/notifications/read", { method: "POST" });
      setUnread(0);
    })();
  }, [open]);

  return (
    <div className="bellwrap">
      <button
        className={`btn bell${compact ? " icon-only" : ""}`}
        type="button"
        aria-label={unread > 0 ? t("{count} unread notifications", { count: unread }) : t("Notifications")}
        title={compact ? t("Inbox") : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {compact ? <Icon name="inbox" /> : t("Inbox")}
        {unread > 0 && <span className="bell-count mono">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <>
          <div className="bell-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="bell-panel" role="dialog" aria-label={t("Notifications")}>
            <PushSwitch />
            {notes.length === 0 && <p className="muted bell-empty">{t("Nothing yet.")}</p>}
            {notes.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`bell-row${n.read ? "" : " fresh"}`}
                onClick={() => {
                  onOpen(n.boardId, n.cardId);
                  setOpen(false);
                }}
              >
                {n.actorId && (
                  <span
                    className="chip avatar small"
                    style={{ background: avatarColor(n.actorId) }}
                  >
                    {initials(n.actorName ?? "?")}
                  </span>
                )}
                <span className="bell-body">
                  <strong>{n.actorName ?? t("Someone")}</strong> {n.body}
                </span>
                <span className="muted mono bell-when">{when(n.createdAt, t)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * This device's notifications, at the top of the inbox — where someone who is
 * wondering how to hear about all this is already looking.
 */
function PushSwitch() {
  const t = useT();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void pushState().then(setState);
  }, []);

  const run = async (work: () => Promise<PushState>) => {
    setBusy(true);
    setProblem(null);
    try {
      setState(await work());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : t("Please try again."));
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return null;

  if (state === "unsupported") {
    // Only worth a line where there is something the person can do about it.
    if (!isIosBrowser()) return null;
    return (
      <p className="push-row muted">
        {t("To get notifications on an iPhone or iPad, tap Share → Add to Home Screen, then open Pergola from there.")}
      </p>
    );
  }

  if (state === "denied") {
    return (
      <p className="push-row muted">
        {t("Notifications are blocked for this site. Allow them in your browser's site settings to hear about mentions and new cards.")}
      </p>
    );
  }

  if (state === "on") {
    return (
      <div className="push-row">
        <span className="muted">{t("Notifications are on for this device.")}</span>
        <button
          className="linkish"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await disablePush();
              // Turned off on purpose: the bar should not come back to ask.
              dismissNudge();
              return "off";
            })
          }
        >
          {t("Turn off")}
        </button>
      </div>
    );
  }

  return (
    <div className="push-row off">
      <span>{t("Get a notification when you are mentioned or a card is added, even with Pergola closed.")}</span>
      <button
        className="btn primary"
        type="button"
        disabled={busy}
        onClick={() => void run(() => enablePush(confirmation(t)))}
      >
        {busy ? t("Working…") : t("Turn on")}
      </button>
      {problem && <span className="push-problem">{problem}</span>}
    </div>
  );
}

/** What the test notification says, in the language the page is in. */
const confirmation = (t: (k: string) => string) => ({
  title: "Pergola",
  body: t("Notifications are on for this device."),
});

const NUDGE_KEY = "pergola.push.nudge";

const dismissNudge = () => {
  try {
    localStorage.setItem(NUDGE_KEY, "dismissed");
  } catch {
    // Blocked storage: the bar comes back next visit, which is survivable.
  }
};

/**
 * The ask, where it cannot be missed.
 *
 * A browser only shows its permission prompt after a click, and one that
 * prompts on arrival gets its prompts hidden — so the page asks first, in a
 * bar under the top bar, and the browser asks when someone says yes. Once per
 * browser: it goes for good when push is on, blocked, or waved away.
 *
 * Safari on an iPhone has no push and never offers to install, so there the
 * bar says how to add Pergola to the home screen instead. The home screen app
 * keeps its own storage, so waving this away does not stop it asking there.
 */
export function PushNudge() {
  const t = useT();
  const [show, setShow] = useState<"ask" | "install" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(NUDGE_KEY) === "dismissed";
    } catch {
      // Unreadable storage reads as never dismissed.
    }
    if (dismissed) return;
    void pushState().then((s) => {
      if (s === "off") setShow("ask");
      else if (s === "unsupported" && isIosBrowser()) setShow("install");
    });
  }, []);

  if (!show) return null;

  const notNow = (
    <button
      className="linkish"
      type="button"
      onClick={() => {
        dismissNudge();
        setShow(null);
      }}
    >
      {t("Not now")}
    </button>
  );

  if (show === "install") {
    return (
      <div className="push-nudge" role="region" aria-label={t("Notifications")}>
        <span className="push-nudge-text">
          {t("To get notifications on an iPhone or iPad, tap Share → Add to Home Screen, then open Pergola from there.")}
        </span>
        {notNow}
      </div>
    );
  }

  const turnOn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      // Dismissing the browser's prompt leaves it "off": the bar stays to ask again.
      if ((await enablePush(confirmation(t))) !== "off") setShow(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : t("Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="push-nudge" role="region" aria-label={t("Notifications")}>
      <span className="push-nudge-text">
        {t("Get a notification when you are mentioned or a card is added, even with Pergola closed.")}
      </span>
      <button className="btn primary" type="button" disabled={busy} onClick={() => void turnOn()}>
        {busy ? t("Working…") : t("Turn on")}
      </button>
      {notNow}
      {problem && <span className="push-problem">{problem}</span>}
    </div>
  );
}

function when(iso: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("now");
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}
