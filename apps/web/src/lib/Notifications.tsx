import { useEffect, useState } from "react";
import { avatarColor, initials } from "./labels.js";
import { useT } from "./i18n.js";

type Note = {
  id: string;
  boardId: string;
  cardId: string | null;
  kind: string;
  body: string;
  actorId: string | null;
  read: boolean;
  createdAt: string;
};

type Props = {
  names: Map<string, string>;
  onOpen: (boardId: string, cardId: string | null) => void;
};

/**
 * The bell.
 *
 * Polled rather than pushed: notifications are not board-scoped, so they do not
 * ride the board socket, and one request a minute is cheaper than a second
 * socket per client. If this ever needs to be instant, it gets its own channel.
 */
export function Notifications({ names, onOpen }: Props) {
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
    return () => clearInterval(timer);
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
        className="btn bell"
        type="button"
        aria-label={unread > 0 ? t("{count} unread notifications", { count: unread }) : t("Notifications")}
        onClick={() => setOpen((v) => !v)}
      >
        {t("Inbox")}
        {unread > 0 && <span className="bell-count mono">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <>
          <div className="bell-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="bell-panel" role="dialog" aria-label={t("Notifications")}>
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
                    {initials(names.get(n.actorId) ?? "?")}
                  </span>
                )}
                <span className="bell-body">
                  <strong>{names.get(n.actorId ?? "") ?? t("Someone")}</strong> {n.body}
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

function when(iso: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("now");
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}
