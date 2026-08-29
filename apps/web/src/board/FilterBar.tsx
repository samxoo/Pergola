import type { BoardState } from "@pergola/shared";
import { avatarColor, hexFor, initials } from "../lib/labels.js";
import { EMPTY, countVisible, isActive, type Due, type Filter } from "../lib/filters.js";

type Props = {
  state: BoardState;
  filter: Filter;
  onChange: (f: Filter) => void;
  archivedCount: number;
  onShowArchive: () => void;
};

const DUE_OPTIONS: { value: Due; label: string }[] = [
  { value: "any", label: "Any date" },
  { value: "overdue", label: "Overdue" },
  { value: "soon", label: "Due soon" },
  { value: "dated", label: "Has a date" },
  { value: "undated", label: "No date" },
];

export function FilterBar({ state, filter, onChange, archivedCount, onShowArchive }: Props) {
  const active = isActive(filter);
  const { shown, total } = countVisible(state, filter);

  const toggle = (key: "labelIds" | "assigneeIds", id: string) =>
    onChange({
      ...filter,
      [key]: filter[key].includes(id)
        ? filter[key].filter((x) => x !== id)
        : [...filter[key], id],
    });

  return (
    <div className="filterbar">
      <input
        className="filter-text"
        value={filter.text}
        placeholder="Filter cards"
        aria-label="Filter cards by text"
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
      />

      <div className="filter-group" role="group" aria-label="Filter by label">
        {state.labels.map((l) => {
          const on = filter.labelIds.includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              className={`filter-label${on ? " on" : ""}`}
              style={{ background: on ? hexFor(l.color) : "transparent", borderColor: hexFor(l.color) }}
              title={l.name || l.color}
              aria-pressed={on}
              onClick={() => toggle("labelIds", l.id)}
            >
              <span className="sr-only">{l.name || l.color}</span>
            </button>
          );
        })}
      </div>

      <div className="filter-group" role="group" aria-label="Filter by member">
        {state.members.map((m) => {
          const on = filter.assigneeIds.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              className={`filter-avatar${on ? " on" : ""}`}
              title={m.name || m.email}
              aria-pressed={on}
              onClick={() => toggle("assigneeIds", m.id)}
            >
              <span className="chip avatar small" style={{ background: avatarColor(m.id) }}>
                {initials(m.name || m.email)}
              </span>
            </button>
          );
        })}
      </div>

      <select
        className="btn"
        value={filter.due}
        aria-label="Filter by due date"
        onChange={(e) => onChange({ ...filter, due: e.target.value as Due })}
      >
        {DUE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {active && (
        <>
          <span className="filter-count mono">
            {shown} of {total}
          </span>
          <button className="linkish" type="button" onClick={() => onChange(EMPTY)}>
            Clear
          </button>
        </>
      )}

      <span className="spacer" />

      {archivedCount > 0 && (
        <button className="btn" type="button" onClick={onShowArchive}>
          Archive <span className="mono">{archivedCount}</span>
        </button>
      )}
    </div>
  );
}
