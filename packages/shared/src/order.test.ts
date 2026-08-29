import assert from "node:assert/strict";
import { test } from "node:test";
import { atEnd, between, byPosition, positionForIndex } from "./order.js";
import { cardsInList, reduce, type BoardState } from "./state.js";

const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "22222222-2222-4222-8222-222222222222";

function board(titles: string[]): BoardState {
  let state: BoardState = {
    id: "b",
    title: "t",
    seq: 0,
    lists: [
      { id: L1, title: "To do", position: "a0", wipLimit: null },
      { id: L2, title: "Doing", position: "a1", wipLimit: null },
    ],
    cards: [],
    labels: [],
    fields: [],
    checklists: [],
    items: [],
    attachments: [],
    comments: [],
    members: [],
  };
  let pos: string | null = null;
  titles.forEach((title, i) => {
    pos = atEnd(pos);
    state = reduce(state, {
      kind: "card.create",
      cardId: `card-${i}`,
      listId: L1,
      title,
      position: pos,
    }, META);
  });
  return state;
}

const META = { actorId: "tester", at: "2026-08-29T00:00:00.000Z" };

const order = (s: BoardState, listId: string) => cardsInList(s, listId).map((c) => c.title);

test("keys stay strictly ordered between neighbours", () => {
  const a = between(null, null);
  const b = between(a, null);
  const mid = between(a, b);
  assert.ok(a < mid && mid < b, `expected ${a} < ${mid} < ${b}`);
});

test("survives repeated midpoint inserts — the float64 failure mode", () => {
  // A float `position` column compares equal after ~50 of these. Fractional
  // indexing just grows the key by a character.
  let lo = between(null, null);
  let hi = between(lo, null);
  for (let i = 0; i < 500; i++) {
    const mid = between(lo, hi);
    assert.ok(lo < mid && mid < hi, `lost ordering at insert ${i}`);
    hi = mid;
  }
});

test("a generated key never escapes its gap", () => {
  // The regression that started all this: jitter appended to a key that was a
  // prefix of its upper bound sorted *above* that bound.
  let lo = between(null, null);
  let hi = between(lo, null);
  for (let i = 0; i < 200; i++) {
    const mid = between(lo, hi);
    assert.ok(lo < mid && mid < hi, `key ${mid} escaped (${lo}, ${hi})`);
    // Alternate which side we close in on, so prefix-shaped bounds get exercised.
    if (i % 2 === 0) hi = mid;
    else lo = mid;
  }
});

test("cards that land on the same key still sort identically everywhere", () => {
  // Two clients dropping into one gap at the same instant compute the same key.
  // That is allowed; disagreeing about the resulting order is not.
  const a = between(null, null);
  const b = between(a, null);
  const key = between(a, b);
  assert.equal(between(a, b), key, "the same gap yields the same key");

  const one = [
    { id: "ffff", position: key, title: "typed by Dana" },
    { id: "0000", position: key, title: "typed by Sam" },
  ];
  const other = [...one].reverse();
  assert.deepEqual(
    [...one].sort(byPosition).map((c) => c.id),
    [...other].sort(byPosition).map((c) => c.id),
    "both clients agree on the order regardless of arrival sequence",
  );
});

test("dropping a card at each index within its own list lands it there", () => {
  const start = board(["A", "B", "C", "D"]);
  for (let target = 0; target < 4; target++) {
    const siblings = cardsInList(start, L1);
    const moving = siblings[0]!; // always drag "A"
    const position = positionForIndex(siblings, target, moving.id);
    const next = reduce(start, {
      kind: "card.move",
      cardId: moving.id,
      toListId: L1,
      position,
    }, META);
    const expected = ["B", "C", "D"];
    expected.splice(target, 0, "A");
    assert.deepEqual(order(next, L1), expected, `dropping A at index ${target}`);
  }
});

test("dropping a card into another list lands at the requested index", () => {
  let start = board(["A", "B", "C"]);
  // Seed the destination with two cards.
  start = reduce(start, {
    kind: "card.create",
    cardId: "x",
    listId: L2,
    title: "X",
    position: atEnd(null),
  }, META);
  start = reduce(start, {
    kind: "card.create",
    cardId: "y",
    listId: L2,
    title: "Y",
    position: atEnd(cardsInList(start, L2).at(-1)!.position),
  }, META);

  for (let target = 0; target < 3; target++) {
    const position = positionForIndex(cardsInList(start, L2), target, "card-1");
    const next = reduce(start, {
      kind: "card.move",
      cardId: "card-1", // "B"
      toListId: L2,
      position,
    }, META);
    const expected = ["X", "Y"];
    expected.splice(target, 0, "B");
    assert.deepEqual(order(next, L2), expected, `dropping B into list 2 at ${target}`);
    assert.deepEqual(order(next, L1), ["A", "C"], "and it leaves the source list");
  }
});

test("reduce is idempotent, so our own socket echo is a no-op", () => {
  const start = board(["A", "B"]);
  const move = {
    kind: "card.move",
    cardId: "card-0",
    toListId: L2,
    position: atEnd(null),
  } as const;
  const once = reduce(start, move, META);
  const twice = reduce(once, move, META);
  assert.deepEqual(order(twice, L1), order(once, L1));
  assert.deepEqual(order(twice, L2), order(once, L2));

  const create = {
    kind: "card.create",
    cardId: "card-0",
    listId: L1,
    title: "duplicate",
    position: "zz",
  } as const;
  assert.equal(reduce(once, create, META), once, "a replayed create returns the same object");
});
