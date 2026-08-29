import { useMemo, useState } from "react";
import { cardsInList, type BoardState, type Card, type MutationBody } from "@pergola/shared";
import { hexFor } from "../lib/labels.js";
import { matches, type Filter } from "../lib/filters.js";

type Props = {
  state: BoardState;
  filter: Filter;
  apply: (body: MutationBody) => void;
  onOpenCard: (id: string) => void;
};

const DAY = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Due dates on a month grid.
 *
 * Dropping a card on a day moves its due date there, keeping the time of day it
 * already had — a card due at 5pm should stay due at 5pm when it slips a week.
 */
export function CalendarView({ state, filter, apply, onOpenCard }: Props) {
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const dated = useMemo(() => {
    const live = state.lists.flatMap((l) => cardsInList(state, l.id));
    return live.filter((c) => c.dueAt && matches(state, c, filter));
  }, [state, filter]);

  const byDay = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const c of dated) {
      const key = dayKey(new Date(c.dueAt!));
      const bucket = map.get(key);
      if (bucket) bucket.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [dated]);

  // Weeks start on Monday; getDay() puts Sunday at 0, so shift it to the end.
  const firstCell = useMemo(() => {
    const d = new Date(monthStart);
    const offset = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
  }, [monthStart]);

  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => new Date(firstCell.getTime() + i * DAY)),
    [firstCell],
  );

  const shiftMonth = (by: number) =>
    setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + by, 1));

  const todayKey = dayKey(new Date());

  return (
    <div className="calendar">
      <div className="cal-head">
        <button className="btn" type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <strong className="cal-month">
          {monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </strong>
        <button className="btn" type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
          ›
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const d = new Date();
            setMonthStart(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
        >
          Today
        </button>
        <span className="spacer" />
        <span className="muted">
          {dated.length} card{dated.length === 1 ? "" : "s"} with a due date
        </span>
      </div>

      <div className="cal-grid" role="grid">
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-weekday">
            {d}
          </div>
        ))}

        {cells.map((day) => {
          const key = dayKey(day);
          const outside = day.getMonth() !== monthStart.getMonth();
          const cards = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`cal-day${outside ? " outside" : ""}${key === todayKey ? " today" : ""}${overKey === key ? " over" : ""}`}
              onDragOver={(e) => {
                if (!dragCardId) return;
                e.preventDefault();
                setOverKey(key);
              }}
              onDragLeave={() => setOverKey((k) => (k === key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                setOverKey(null);
                if (!dragCardId) return;
                const card = state.cards.find((c) => c.id === dragCardId);
                if (!card?.dueAt) return;
                const was = new Date(card.dueAt);
                // Keep the time of day; only the date moves.
                const next = new Date(
                  day.getFullYear(), day.getMonth(), day.getDate(),
                  was.getHours(), was.getMinutes(),
                );
                apply({
                  kind: "card.setDates",
                  cardId: card.id,
                  startAt: card.startAt,
                  dueAt: next.toISOString(),
                });
                setDragCardId(null);
              }}
            >
              <div className="cal-date mono">{day.getDate()}</div>
              {cards.map((c) => {
                const first = c.labelIds[0];
                const colour = first
                  ? hexFor(state.labels.find((l) => l.id === first)?.color ?? "")
                  : null;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="cal-card"
                    draggable
                    onDragStart={() => setDragCardId(c.id)}
                    onDragEnd={() => {
                      setDragCardId(null);
                      setOverKey(null);
                    }}
                    onClick={() => onOpenCard(c.id)}
                    title={c.title}
                  >
                    {colour && <i style={{ background: colour }} />}
                    <span>{c.title}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Local calendar day, not UTC — a card due at 1am should land on that day. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
