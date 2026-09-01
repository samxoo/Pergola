import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  cardsInList,
  orderedLists,
  type BoardState,
  type Card,
  type MutationBody,
} from "@pergola/shared";
import { hexFor } from "../lib/labels.js";
import { matches, type Filter } from "../lib/filters.js";
import { useT, usePlural, useDateLocale } from "../lib/i18n.js";

type Props = {
  state: BoardState;
  filter: Filter;
  apply: (body: MutationBody) => void;
  onOpenCard: (id: string) => void;
};

const DAY = 86_400_000;
/** Column width. The drag arithmetic and the stylesheet both need it, so it is stated once. */
const DAY_W = 28;
/** Six weeks. A quarter is unreadable at this column width; a fortnight says nothing. */
const SPAN = 42;
/** Half a span, so a page still leaves you something you were already looking at. */
const PAGE = 14;

type Mode = "move" | "start" | "end";

type Drag = {
  cardId: string;
  mode: Mode;
  originX: number;
  days: number;
  /** A resize may not push one end through the other. */
  min: number;
  max: number;
};

type Dates = { startAt: string | null; dueAt: string | null };
/** Day indices from the window's first day, both ends inclusive. */
type Place = { from: number; to: number; bar: boolean };

/**
 * Dates on a horizontal axis.
 *
 * The calendar answers "what is due this month"; this answers "what overlaps
 * what". Everything is snapped to whole days — an hour of precision would be
 * invisible at 28px a day and would only make dragging feel loose.
 */
export function TimelineView({ state, filter, apply, onOpenCard }: Props) {
  const t = useT();
  const pl = usePlural();
  const locale = useDateLocale();
  const [anchor, setAnchor] = useState(windowStart);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends in a click on the same button. Without this the drawer opens
  // every time you let go of a bar.
  const moved = useRef(false);

  const days = useMemo(() => Array.from({ length: SPAN }, (_, i) => addDays(anchor, i)), [anchor]);

  // Consecutive days of one month, so the top tier can name the months it spans.
  const months = useMemo(() => {
    const out: { key: string; label: string; days: number }[] = [];
    for (const d of days) {
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.days++;
      else out.push({ key, label: d.toLocaleDateString(locale, { month: "long", year: "numeric" }), days: 1 });
    }
    return out;
  }, [days, locale]);

  const labelById = useMemo(() => new Map(state.labels.map((l) => [l.id, l])), [state.labels]);

  const groups = useMemo(
    () =>
      orderedLists(state)
        .map((list) => ({
          list,
          // cardsInList drops the archived and keeps board order. Sorting rows by
          // date instead would yank a row out from under the drag that moved it.
          cards: cardsInList(state, list.id).filter(
            (c) => (c.startAt ?? c.dueAt) !== null && matches(state, c, filter),
          ),
        }))
        .filter((g) => g.cards.length > 0),
    [state, filter],
  );

  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  const todayAt = daysBetween(anchor, new Date());
  const width = SPAN * DAY_W;
  const shift = (by: number) => setAnchor((a) => addDays(a, by));

  const begin = (e: PointerEvent<HTMLButtonElement>, card: Card, place: Place) => {
    if (e.button !== 0) return;
    // The grab zone is read off the target, so capture can stay on the bar itself.
    const zone = e.target instanceof HTMLElement ? e.target.dataset.grip : undefined;
    const mode: Mode = zone === "start" || zone === "end" ? zone : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    moved.current = false;
    setDrag({
      cardId: card.id,
      mode,
      originX: e.clientX,
      days: 0,
      min: mode === "end" ? place.from - place.to : -Infinity,
      max: mode === "start" ? place.to - place.from : Infinity,
    });
  };

  const track = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    if (Math.abs(dx) > 3) moved.current = true;
    const days = Math.min(drag.max, Math.max(drag.min, Math.round(dx / DAY_W)));
    if (days !== drag.days) setDrag({ ...drag, days });
  };

  const commit = () => {
    if (!drag) return;
    const card = state.cards.find((c) => c.id === drag.cardId);
    const next = card && shifted(card, drag);
    setDrag(null);
    if (!card || !next || drag.days === 0) return;
    apply({ kind: "card.setDates", cardId: card.id, startAt: next.startAt, dueAt: next.dueAt });
  };

  return (
    <div
      className="timeline"
      style={vars({ "--tl-day": `${DAY_W}px`, "--tl-days": String(SPAN) })}
    >
      <div className="tl-head">
        <button className="btn" type="button" onClick={() => shift(-PAGE)} aria-label={t("Earlier")}>
          ‹
        </button>
        <strong className="tl-range">
          {anchor.toLocaleDateString(locale, { day: "numeric", month: "short" })} –{" "}
          {addDays(anchor, SPAN - 1).toLocaleDateString(locale, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </strong>
        <button className="btn" type="button" onClick={() => shift(PAGE)} aria-label={t("Later")}>
          ›
        </button>
        <button className="btn" type="button" onClick={() => setAnchor(windowStart())}>
          {t("Today")}
        </button>
        <span className="spacer" />
        <span className="muted">
          {pl(total, "{count} card scheduled", "{count} cards scheduled")}
        </span>
      </div>

      {total === 0 ? (
        <p className="muted tl-empty">{t("No card has a start or due date yet.")}</p>
      ) : (
        <div className="tl-scroll">
          <div className="tl-canvas">
            <div className="tl-stripes" aria-hidden="true">
              {days.map((d, i) =>
                d.getDay() === 0 || d.getDay() === 6 ? (
                  <i key={i} style={{ left: i * DAY_W, width: DAY_W }} />
                ) : null,
              )}
            </div>
            {todayAt >= 0 && todayAt < SPAN && (
              <div className="tl-now" style={{ left: todayAt * DAY_W }} aria-hidden="true" />
            )}

            <div className="tl-axis">
              <div className="tl-months">
                {months.map((m) => (
                  <div key={m.key} className="tl-month" style={{ width: m.days * DAY_W }}>
                    {m.label}
                  </div>
                ))}
              </div>
              <div className="tl-days">
                {days.map((d, i) => (
                  <div
                    key={i}
                    className="tl-daycol"
                    data-weekend={d.getDay() === 0 || d.getDay() === 6 ? "" : undefined}
                    data-today={i === todayAt ? "" : undefined}
                  >
                    {d.toLocaleDateString(locale, { weekday: "narrow" })}
                    <span className="tl-dom mono">{d.getDate()}</span>
                  </div>
                ))}
              </div>
            </div>

            {groups.map((g) => (
              <div className="tl-group" key={g.list.id}>
                <div className="tl-grouphead">
                  <span>{g.list.title}</span>
                </div>
                {g.cards.map((card) => {
                  const dates = shifted(card, drag);
                  const place = placement(dates, anchor);
                  if (!place) return null;

                  const left = place.from * DAY_W;
                  const right = (place.to + 1) * DAY_W;
                  // Wholly outside the window: keep the row and stub it at the
                  // edge, so the group's card count is not a lie.
                  const off = right <= 0 ? "left" : left >= width ? "right" : undefined;
                  const x = off === "left" ? 0 : off === "right" ? width - DAY_W : Math.max(0, left);
                  const w = off ? DAY_W : Math.min(width, right) - x;
                  const clip = `${left < 0 ? "l" : ""}${right > width ? "r" : ""}`;

                  const labelId = card.labelIds[0];
                  const label = labelId ? labelById.get(labelId) : undefined;
                  const hue = label ? hexFor(label.color) : "var(--beam)";
                  const when = describe(dates, t, locale);

                  return (
                    <div className="tl-row" key={card.id}>
                      <button
                        type="button"
                        className="tl-bar"
                        style={{ ...vars({ "--tl-hue": hue }), left: x, width: w }}
                        data-marker={place.bar ? undefined : ""}
                        data-clip={clip || undefined}
                        data-off={off}
                        data-dragging={drag?.cardId === card.id ? "true" : undefined}
                        title={`${card.title} — ${when}`}
                        aria-label={`${card.title}, ${when}`}
                        onPointerDown={off ? undefined : (e) => begin(e, card, place)}
                        onPointerMove={track}
                        onPointerUp={commit}
                        onPointerCancel={() => setDrag(null)}
                        onClick={() => {
                          if (moved.current) {
                            moved.current = false;
                            return;
                          }
                          onOpenCard(card.id);
                        }}
                      >
                        <span className="tl-title">{card.title}</span>
                        {place.bar && !off && (
                          <>
                            <i className="tl-grip" data-grip="start" aria-hidden="true" />
                            <i className="tl-grip" data-grip="end" aria-hidden="true" />
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

/** React's CSSProperties has no room for custom properties; this is the door in. */
const vars = (v: Record<string, string>) => v as CSSProperties;

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A week of slack behind today: what has just slipped matters as much as what is next. */
const windowStart = () => addDays(midnight(new Date()), -7);

/** Whole days apart. Rounding absorbs the hour that daylight saving takes or gives back. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY);
}

/**
 * The dates a drag would produce.
 *
 * The preview and the commit both come through here, so what you let go of is
 * what gets saved.
 */
function shifted(card: Card, drag: Drag | null): Dates {
  if (!drag || drag.cardId !== card.id || drag.days === 0) {
    return { startAt: card.startAt, dueAt: card.dueAt };
  }
  const both = drag.mode === "move";
  return {
    startAt: both || drag.mode === "start" ? addIso(card.startAt, drag.days) : card.startAt,
    dueAt: both || drag.mode === "end" ? addIso(card.dueAt, drag.days) : card.dueAt,
  };
}

/** Whole days on, time of day kept — a card due at 5pm stays due at 5pm when it slips. */
function addIso(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).toISOString();
}

function placement(d: Dates, anchor: Date): Place | null {
  const s = d.startAt ? new Date(d.startAt) : null;
  const e = d.dueAt ? new Date(d.dueAt) : null;
  const first = s ?? e;
  const last = e ?? s;
  if (!first || !last) return null;
  const a = daysBetween(anchor, first);
  const b = daysBetween(anchor, last);
  // A due date before the start is bad data, but it still has to draw as something.
  return { from: Math.min(a, b), to: Math.max(a, b), bar: s !== null && e !== null };
}

/** What a bar spans, for the tooltip and the screen reader. */
function describe(
  d: Dates,
  t: (k: string, p?: Record<string, string | number>) => string,
  locale: string | undefined,
): string {
  const s = d.startAt ? day(d.startAt, locale) : null;
  const e = d.dueAt ? day(d.dueAt, locale) : null;
  if (s && e) return `${s} – ${e}`;
  if (e) return t("due {date}", { date: e });
  return s ? t("starts {date}", { date: s }) : "";
}

const day = (iso: string, locale: string | undefined) =>
  new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });
