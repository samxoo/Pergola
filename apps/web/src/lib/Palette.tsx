import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "./i18n.js";

export type Hit = {
  cardId: string;
  number: number;
  title: string;
  boardId: string;
  boardTitle: string;
  listTitle: string;
  archived: boolean;
  rank: number;
};

export type Action = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  actions: Action[];
  onPick: (hit: Hit) => void;
};

/**
 * The command palette.
 *
 * It searches every board you belong to, because "where did that card go" is the
 * question a board with any history actually generates — and it is the fast path
 * to every action, not an alternate one.
 */
export function Palette({ open, onClose, actions, onPick }: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setCursor(0);
      // The input must exist before it can take focus.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const cancelled = { current: false };
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
        const rows = (await res.json()) as Hit[];
        if (!cancelled.current) setHits(rows);
      } finally {
        if (!cancelled.current) setSearching(false);
      }
    }, 160);
    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, [q, open]);

  const shownActions = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(term));
  }, [actions, q]);

  const rows = useMemo(
    () => [
      ...shownActions.map((a) => ({ kind: "action" as const, action: a })),
      ...hits.map((h) => ({ kind: "hit" as const, hit: h })),
    ],
    [shownActions, hits],
  );

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  if (!open) return null;

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "action") row.action.run();
    else onPick(row.hit);
    onClose();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="palette" role="dialog" aria-label={t("Command palette")}>
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          placeholder={t("Search cards, or type a command")}
          aria-label={t("Search cards or run a command")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(cursor);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />

        <div className="palette-list">
          {rows.length === 0 && (
            <p className="palette-empty">
              {q.trim().length < 2
                ? t("Type at least two characters to search.")
                : searching
                  ? t("Searching…")
                  : t("Nothing matches “{q}”.", { q: q.trim() })}
            </p>
          )}

          {rows.map((row, i) => {
            const selected = i === cursor;
            if (row.kind === "action") {
              return (
                <button
                  key={`a:${row.action.id}`}
                  type="button"
                  className={`palette-row${selected ? " on" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(i)}
                >
                  <span className="palette-kind mono">{t("go")}</span>
                  <span className="palette-label">{row.action.label}</span>
                  {row.action.hint && <span className="palette-hint mono">{row.action.hint}</span>}
                </button>
              );
            }
            const h = row.hit;
            return (
              <button
                key={`h:${h.cardId}`}
                type="button"
                className={`palette-row${selected ? " on" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(i)}
              >
                <span className="palette-kind mono">PRG-{h.number}</span>
                <span className="palette-label">
                  {h.title}
                  {h.archived && <em className="palette-archived"> {t("archived")}</em>}
                </span>
                <span className="palette-hint">
                  {h.boardTitle} · {h.listTitle}
                </span>
              </button>
            );
          })}
        </div>

        <div className="palette-foot mono">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("move")}
          </span>
          <span>
            <kbd>↵</kbd> {t("open")}
          </span>
          <span>
            <kbd>esc</kbd> {t("close")}
          </span>
        </div>
      </div>
    </>
  );
}
