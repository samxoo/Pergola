import type { BoardState, Card } from "@pergola/shared";

export type Due = "any" | "overdue" | "soon" | "dated" | "undated";

export type Filter = {
  text: string;
  labelIds: string[];
  assigneeIds: string[];
  due: Due;
};

export const EMPTY: Filter = { text: "", labelIds: [], assigneeIds: [], due: "any" };

export const isActive = (f: Filter): boolean =>
  f.text.trim() !== "" || f.labelIds.length > 0 || f.assigneeIds.length > 0 || f.due !== "any";

/**
 * Does this card survive the filter?
 *
 * Within a facet the test is "any of" — picking two labels widens the result.
 * Across facets it is "all of" — a label *and* an assignee narrows it. That is
 * what people expect from filters, and it is the opposite of what you get by
 * writing the obvious single loop.
 */
export function matches(state: BoardState, card: Card, f: Filter): boolean {
  const text = f.text.trim().toLowerCase();
  if (text) {
    const inTitle = card.title.toLowerCase().includes(text);
    const inDesc = (card.descMd ?? "").toLowerCase().includes(text);
    const inNumber = `prg-${card.number}`.includes(text);
    if (!inTitle && !inDesc && !inNumber) return false;
  }

  if (f.labelIds.length && !f.labelIds.some((id) => card.labelIds.includes(id))) return false;
  if (f.assigneeIds.length && !f.assigneeIds.some((id) => card.assigneeIds.includes(id)))
    return false;

  if (f.due !== "any") {
    const due = card.dueAt ? new Date(card.dueAt).getTime() : null;
    if (f.due === "undated" && due !== null) return false;
    if (f.due === "dated" && due === null) return false;
    if (f.due === "overdue" && (due === null || due >= Date.now())) return false;
    // "Soon" is the next 48 hours: long enough to act on, short enough to mean it.
    if (f.due === "soon" && (due === null || due < Date.now() || due > Date.now() + 48 * 3600_000))
      return false;
  }

  void state;
  return true;
}

/** How many cards the current filter is hiding, for the "showing N of M" line. */
export function countVisible(state: BoardState, f: Filter) {
  const live = state.cards.filter((c) => !c.archivedAt);
  return { shown: live.filter((c) => matches(state, c, f)).length, total: live.length };
}
