import { useMemo, useState } from "react";
import {
  cardsInList,
  checklistProgress,
  orderedLists,
  type BoardState,
  type Card,
} from "@pergola/shared";
import { avatarColor, hexFor, initials } from "../lib/labels.js";
import { matches, type Filter } from "../lib/filters.js";
import { useT, useDateLocale } from "../lib/i18n.js";

type Props = {
  state: BoardState;
  filter: Filter;
  onOpenCard: (id: string) => void;
};

type SortKey = "number" | "title" | "list" | "due";

/**
 * Every card on one screen, sortable.
 *
 * Trello puts this behind Premium. It is a table.
 */
export function TableView({ state, filter, onOpenCard }: Props) {
  const t = useT();
  const [sort, setSort] = useState<SortKey>("number");
  const [desc, setDesc] = useState(false);

  const listById = useMemo(() => new Map(state.lists.map((l) => [l.id, l])), [state.lists]);
  const listOrder = useMemo(
    () => new Map(orderedLists(state).map((l, i) => [l.id, i])),
    [state],
  );
  const memberById = useMemo(() => new Map(state.members.map((m) => [m.id, m])), [state.members]);

  const rows = useMemo(() => {
    const live = state.lists.flatMap((l) => cardsInList(state, l.id));
    const kept = live.filter((c) => matches(state, c, filter));
    const dir = desc ? -1 : 1;
    return kept.sort((a, b) => dir * compare(a, b, sort, listOrder));
  }, [state, filter, sort, desc, listOrder]);

  const head = (key: SortKey, label: string) => (
    <th>
      <button
        type="button"
        className={`th-sort${sort === key ? " on" : ""}`}
        onClick={() => {
          if (sort === key) setDesc((d) => !d);
          else {
            setSort(key);
            setDesc(false);
          }
        }}
      >
        {label}
        {sort === key && <span aria-hidden="true">{desc ? " ↓" : " ↑"}</span>}
      </button>
    </th>
  );

  return (
    <div className="tablewrap">
      <table className="cardtable">
        <thead>
          <tr>
            {head("number", t("Card"))}
            {head("title", t("Title"))}
            {head("list", t("List"))}
            <th>{t("Labels")}</th>
            <th>{t("Who")}</th>
            {head("due", t("Due"))}
            <th>{t("Done")}</th>
            {state.fields.map((f) => (
              <th key={f.id}>{f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7 + state.fields.length} className="muted table-empty">
                {t("No cards match the current filter.")}
              </td>
            </tr>
          )}
          {rows.map((c) => {
            const progress = checklistProgress(state, c.id);
            return (
              <tr key={c.id} onClick={() => onOpenCard(c.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") onOpenCard(c.id); }}>
                <td className="mono nowrap">PRG-{c.number}</td>
                <td className="cell-title">{c.title}</td>
                <td className="nowrap">{listById.get(c.listId)?.title ?? "—"}</td>
                <td>
                  <span className="cell-labels">
                    {c.labelIds.map((id) => {
                      const l = state.labels.find((x) => x.id === id);
                      return l ? (
                        <span
                          key={id}
                          className="label-dash"
                          style={{ background: hexFor(l.color) }}
                          title={l.name || l.color}
                        />
                      ) : null;
                    })}
                  </span>
                </td>
                <td>
                  <span className="cell-people">
                    {c.assigneeIds.map((id) => (
                      <span
                        key={id}
                        className="chip avatar small"
                        style={{ background: avatarColor(id) }}
                        title={memberById.get(id)?.name ?? id}
                      >
                        {initials(memberById.get(id)?.name ?? "?")}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="nowrap">{c.dueAt ? <Due dueAt={c.dueAt} /> : <span className="muted">—</span>}</td>
                <td className="mono nowrap">
                  {progress.total > 0 ? `${progress.done}/${progress.total}` : "—"}
                </td>
                {state.fields.map((f) => (
                  <td key={f.id} className="nowrap">
                    {c.fields[f.id] ?? <span className="muted">—</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function compare(a: Card, b: Card, key: SortKey, listOrder: Map<string, number>): number {
  switch (key) {
    case "number":
      return a.number - b.number;
    case "title":
      return a.title.localeCompare(b.title);
    case "list": {
      const d = (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0);
      // Within a list, keep the board's own order rather than an arbitrary one.
      return d !== 0 ? d : a.position < b.position ? -1 : 1;
    }
    case "due": {
      // Undated cards sort last either way: "no date" is not "the beginning of
      // time", and burying the dated ones under them defeats the sort.
      if (!a.dueAt && !b.dueAt) return a.number - b.number;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return a.dueAt < b.dueAt ? -1 : 1;
    }
  }
}

function Due({ dueAt }: { dueAt: string }) {
  const locale = useDateLocale();
  const due = new Date(dueAt);
  const overdue = due.getTime() < Date.now();
  return (
    <span className={`badge due${overdue ? " overdue" : ""}`} title={due.toLocaleString(locale)}>
      {due.toLocaleDateString(locale, { month: "short", day: "numeric" })}
    </span>
  );
}
