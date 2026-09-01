import { useEffect, useState } from "react";
import { describe, type MutationBody } from "@pergola/shared";
import { avatarColor, initials } from "../lib/labels.js";
import { useT, useDateLocale } from "../lib/i18n.js";

export type Entry = {
  id: string;
  seq: number;
  body: MutationBody;
  actorId: string | null;
  actorName: string | null;
  /** Set when an automation rule did this rather than a person. */
  ruleName: string | null;
  createdAt: string;
};

type Props = {
  boardId: string;
  /** Scope to one card, or omit for the whole board. */
  cardId?: string;
  /** Bump to refetch — the board's mutation cursor works well for this. */
  cursor: number;
};

/**
 * The activity feed.
 *
 * There is no activity table. This is the mutation log read backwards, which is
 * why it can never drift from what actually happened — the same rows drive live
 * sync and undo.
 */
export function Activity({ boardId, cardId, cursor }: Props) {
  const t = useT();
  const locale = useDateLocale();
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const qs = new URLSearchParams({ limit: cardId ? "30" : "60" });
      if (cardId) qs.set("cardId", cardId);
      const res = await fetch(`/api/boards/${boardId}/activity?${qs}`);
      if (!res.ok) return;
      const rows = (await res.json()) as Entry[];
      if (!cancelled) setEntries(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, cardId, cursor]);

  if (!entries) return <p className="muted">{t("Loading…")}</p>;
  if (entries.length === 0) return <p className="muted">{t("Nothing has happened yet.")}</p>;

  return (
    <div className="activity">
      {entries.map((e) => (
        <div key={e.id} className="activity-row">
          <span
            className="chip avatar small"
            style={{ background: e.actorId ? avatarColor(e.actorId) : "var(--muted)" }}
            title={e.actorName ?? t("Someone")}
          >
            {initials(e.actorName ?? "?")}
          </span>
          <span className="activity-text">
            <strong>{e.actorName ?? t("Someone")}</strong> {describe(e.body)}
            {/* A rule acts on behalf of whoever set it off — say which. */}
            {e.ruleName && <em className="via-rule"> {t("via {name}", { name: e.ruleName })}</em>}
          </span>
          <span className="muted mono activity-when" title={new Date(e.createdAt).toLocaleString(locale)}>
            {when(e.createdAt, t, locale)}
          </span>
        </div>
      ))}
    </div>
  );
}

function when(
  iso: string,
  t: (k: string, p?: Record<string, string | number>) => string,
  locale: string | undefined,
): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("now");
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
