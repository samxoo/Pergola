import { generateKeyBetween } from "fractional-indexing";

/**
 * Card and list ordering.
 *
 * `position` is a base-62 fractional index key held in a text column. Moving an
 * item generates a key strictly between its two new neighbours, so a move writes
 * exactly one row and reads two — independent of how long the list is.
 *
 * The alternatives and why they lose:
 *   integer position  O(n) writes per move, and every move conflicts with every
 *                     other move on the same list.
 *   float midpoint    Dies silently: ~50 successive midpoint inserts into one gap
 *                     exhaust float64 precision and two cards compare equal.
 *   LexoRank          Works, but keys drift toward exhaustion and need a periodic
 *                     rebalance that rewrites the whole board.
 */

/**
 * A key ordered strictly between `before` and `after`. Pass null for either end.
 *
 * Deliberately *not* jittered. The usual trick of appending random characters to
 * de-duplicate concurrent inserts is unsound here: a generated key is sometimes a
 * prefix of its upper bound, and "a0K" + "XY" = "a0KXY" sorts *above* "a0K3". The
 * jitter silently inverts the order it was added to protect.
 *
 * Two clients dropping into the same gap at the same instant therefore do produce
 * the same key — which is fine, because `byPosition` breaks that tie on `id`, so
 * every client independently arrives at the same order. Determinism without the
 * hazard, and shorter keys.
 */
export function between(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** Key for an item appended to the end of a list. */
export function atEnd(last: string | null): string {
  return between(last, null);
}

/**
 * Ascending comparator for anything carrying a fractional `position`.
 *
 * Ties break on `id`, which is what makes concurrent inserts safe: two cards that
 * land on the same key still sort identically on every client, so nobody watches
 * their card jump when the server echo arrives.
 */
export function byPosition<T extends { position: string; id: string }>(a: T, b: T): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The position an item needs to land at `index` within `siblings`, ignoring the
 * item itself if it is already in the list. Callers pass the destination list
 * already sorted by position.
 */
export function positionForIndex<T extends { id: string; position: string }>(
  siblings: readonly T[],
  index: number,
  movingId?: string,
): string {
  const others = movingId ? siblings.filter((s) => s.id !== movingId) : siblings;
  const clamped = Math.max(0, Math.min(index, others.length));
  const before = clamped > 0 ? (others[clamped - 1]?.position ?? null) : null;
  const after = clamped < others.length ? (others[clamped]?.position ?? null) : null;
  return between(before, after);
}
