import { move } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useMemo, useState } from "react";
import {
  atEnd,
  cardsInList,
  orderedLists,
  positionForIndex,
  type BoardState,
  type Card,
  type MutationBody,
  type MutationRecord,
} from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
import { hexFor, avatarColor, initials } from "../lib/labels.js";
import { matches, type Filter } from "../lib/filters.js";
import { useT, usePlural } from "../lib/i18n.js";
import { uploadToCard } from "../lib/upload.js";
import { Column } from "./Column.js";

export type GroupBy = "none" | "label" | "assignee";

type Props = {
  state: BoardState;
  filter: Filter;
  groupBy: GroupBy;
  /** Resolves once the server has confirmed the change, or refused it. */
  apply: (body: MutationBody) => Promise<void>;
  /** Take in a change the server committed for us — an upload, say. */
  ingest: (rec: MutationRecord) => void;
  onOpenCard: (id: string) => void;
};

type Lane = {
  key: string;
  title: string;
  /** null for the "none of them" lane, which cannot be assigned into. */
  value: string | null;
  colour: string | null;
};

/**
 * How many cards one cell renders before asking.
 *
 * Every rendered card registers a sortable with dnd-kit, and collision detection
 * is not free: a list of 400 locks the renderer for tens of seconds. A bay shows
 * about eight at a time, so sixty is well past anything anyone scrolls before
 * they reach for the filter — and the cap is per cell, so it never hides the
 * whole board.
 */
const PAGE = 60;

/** Composite droppable id, so the same list in two lanes is two drop targets. */
const cellId = (laneKey: string, listId: string) => `${laneKey}␟${listId}`;
const splitCell = (id: string) => {
  const [laneKey = "", listId = ""] = id.split("␟");
  return { laneKey, listId };
};

export function Board({ state, filter, groupBy, apply, ingest, onOpenCard }: Props) {
  const t = useT();
  const pl = usePlural();
  const { ask, confirm, tell } = useDialogs();
  const lists = useMemo(() => orderedLists(state), [state]);
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const cardById = useMemo(() => new Map(state.cards.map((c) => [c.id, c])), [state.cards]);

  /**
   * Swimlanes.
   *
   * A card belongs to exactly one lane — its *first* label or assignee — so it
   * appears once and its drag id stays unique. The alternative, showing a
   * two-label card in two lanes, makes dragging ambiguous and the counts wrong.
   */
  const lanes: Lane[] = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", title: "", value: null, colour: null }];
    if (groupBy === "label") {
      return [
        ...state.labels.map((l) => ({
          key: `l:${l.id}`,
          title: l.name || l.color,
          value: l.id,
          colour: hexFor(l.color),
        })),
        { key: "l:none", title: t("No label"), value: null, colour: null },
      ];
    }
    return [
      ...state.members.map((m) => ({
        key: `m:${m.id}`,
        title: m.name || m.email,
        value: m.id,
        colour: avatarColor(m.id),
      })),
      { key: "m:none", title: t("Unassigned"), value: null, colour: null },
    ];
  }, [groupBy, state.labels, state.members, t]);

  const laneOf = useMemo(() => {
    return (card: Card): string => {
      if (groupBy === "none") return "all";
      if (groupBy === "label") return card.labelIds[0] ? `l:${card.labelIds[0]}` : "l:none";
      return card.assigneeIds[0] ? `m:${card.assigneeIds[0]}` : "m:none";
    };
  }, [groupBy]);

  /** cellId -> how many cards that cell has been asked to reveal. */
  const [revealed, setRevealed] = useState<Record<string, number>>({});

  /** What each cell holds in full, before the render cap. */
  const fullCards = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const lane of lanes) {
      for (const l of lists) {
        out[cellId(lane.key, l.id)] = cardsInList(state, l.id)
          .filter((c) => matches(state, c, filter) && laneOf(c) === lane.key)
          .map((c) => c.id);
      }
    }
    return out;
  }, [state, lists, lanes, filter, laneOf]);

  /*
   * { cellId: cardId[] } — the shape @dnd-kit's `move` helper operates on, and
   * deliberately the *capped* set. dnd-kit must only know about cards that are
   * actually on screen, or it computes collisions against elements that are not
   * there and a drop lands in the wrong place.
   */
  const committedCards = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, ids] of Object.entries(fullCards)) {
      out[id] = ids.slice(0, revealed[id] ?? PAGE);
    }
    return out;
  }, [fullCards, revealed]);

  const committedOrder = useMemo(() => lists.map((l) => l.id), [lists]);

  /*
   * Cards reflow against local state while the pointer moves, and exactly one
   * mutation is committed on drop. Dragging a card across six columns writes one
   * row, not six.
   */
  const [dragCards, setDragCards] = useState<Record<string, string[]> | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const cardsByCell = dragCards ?? committedCards;
  const order = dragOrder ?? committedOrder;

  const clearDrag = () => {
    setDragCards(null);
    setDragOrder(null);
    setDraggingCardId(null);
  };

  /*
   * Which bay lights up.
   *
   * A column's own `isDropTarget` is only true when the *column* wins the
   * collision — which, because cards deliberately outrank columns, happens only
   * when the column is empty. Hovering a card would leave its bay dark. The
   * destination is really "the cell that currently holds the dragged card", so
   * derive it from the drag state instead.
   */
  const litCell =
    draggingCardId === null
      ? null
      : (Object.keys(cardsByCell).find((id) => cardsByCell[id]?.includes(draggingCardId)) ?? null);

  const firstLaneKey = lanes[0]!.key;

  return (
    <DragDropProvider
      onDragStart={(event) => {
        const { source } = event.operation;
        if (source?.type === "item") setDraggingCardId(String(source.id));
      }}
      onDragOver={(event) => {
        const { source } = event.operation;
        if (!source) return;
        if (source.type === "column") {
          setDragOrder((prev) => move(prev ?? committedOrder, event));
        } else {
          setDragCards((prev) => move(prev ?? committedCards, event));
        }
      }}
      onDragEnd={(event) => {
        const { source } = event.operation;
        if (!source || event.canceled) return clearDrag();

        if (source.type === "column") {
          const next = move(dragOrder ?? committedOrder, event);
          const index = next.indexOf(String(source.id));
          if (index >= 0) {
            apply({
              kind: "list.move",
              listId: String(source.id),
              position: positionForIndex(lists, index, String(source.id)),
            });
          }
          return clearDrag();
        }

        const next = move(dragCards ?? committedCards, event);
        const cardId = String(source.id);
        const cell = Object.keys(next).find((id) => next[id]?.includes(cardId));
        if (!cell) return clearDrag();

        const { laneKey, listId } = splitCell(cell);
        const index = next[cell]!.indexOf(cardId);
        const current = cardById.get(cardId);

        /*
         * Position is computed against the cards that were actually *visible*,
         * not the whole list. Under a filter or a grouping the two differ, and
         * bracketing by the real positions of the visible neighbours is what
         * makes a drop land where the person aimed it.
         */
        const siblings = next[cell]!
          .map((id) => cardById.get(id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        const position = positionForIndex(siblings, index, cardId);

        const stayedPut =
          current && current.listId === listId && siblings[index]?.id === cardId;
        if (!stayedPut) {
          apply({ kind: "card.move", cardId, toListId: listId, position });
        }

        /*
         * Dropping into a different lane means what it looks like: the card takes
         * on that lane's label or assignee. This is what makes swimlanes worth
         * having rather than just a filter — and Trello never shipped either.
         */
        if (current && groupBy !== "none" && laneOf(current) !== laneKey) {
          const lane = lanes.find((l) => l.key === laneKey);
          const old = groupBy === "label" ? current.labelIds[0] : current.assigneeIds[0];
          if (groupBy === "label") {
            if (old) apply({ kind: "card.label", cardId, labelId: old, on: false });
            if (lane?.value) apply({ kind: "card.label", cardId, labelId: lane.value, on: true });
          } else {
            if (old) apply({ kind: "card.assign", cardId, userId: old, on: false });
            if (lane?.value) apply({ kind: "card.assign", cardId, userId: lane.value, on: true });
          }
        }

        clearDrag();
      }}
    >
      <div className="boardscroll">
        {lanes.map((lane) => {
          const laneCount = lists.reduce(
            (n, l) => n + (cardsByCell[cellId(lane.key, l.id)]?.length ?? 0),
            0,
          );
          // An empty lane is noise when grouping by a dimension with many values.
          if (groupBy !== "none" && laneCount === 0) return null;

          return (
            <section key={lane.key} className={groupBy === "none" ? "lane bare" : "lane"}>
              {groupBy !== "none" && (
                <header className="lane-head">
                  {lane.colour && <i className="lane-dot" style={{ background: lane.colour }} />}
                  <strong>{lane.title}</strong>
                  <span className="mono muted">{laneCount}</span>
                </header>
              )}

              <div className="board">
                {order.map((listId, index) => {
                  const list = listById.get(listId);
                  if (!list) return null;
                  const id = cellId(lane.key, listId);
                  const cards = (cardsByCell[id] ?? [])
                    .map((cid) => cardById.get(cid))
                    .filter((c): c is NonNullable<typeof c> => Boolean(c));
                  const hidden = (fullCards[id]?.length ?? 0) - cards.length;

                  return (
                    <Column
                      key={id}
                      dndId={id}
                      // Only the top lane owns the list itself; the others are
                      // views of it, so they do not repeat its controls.
                      structural={lane.key === firstLaneKey}
                      state={state}
                      list={list}
                      index={index}
                      cards={cards}
                      lit={litCell === id}
                      hidden={hidden}
                      onShowMore={() =>
                        setRevealed((r) => ({ ...r, [id]: (r[id] ?? PAGE) + PAGE }))
                      }
                      onAdd={async (lid, title) => {
                        const cardId = crypto.randomUUID();
                        /*
                         * Awaited, because a composer that drops a file on a
                         * new card uploads to it next — and the upload is a
                         * separate request that needs the card to exist by the
                         * time it lands. Fired together they race, and on a
                         * host that runs each request as its own function the
                         * upload wins often enough that the picture just
                         * silently never appears.
                         */
                        await apply({
                          kind: "card.create",
                          cardId,
                          listId: lid,
                          title,
                          position: atEnd(cardsInList(state, lid).at(-1)?.position ?? null),
                        });
                        return cardId;
                      }}
                      onAttach={async (cardId, files) => {
                        const refused: string[] = [];
                        for (const file of files) {
                          const outcome = await uploadToCard(cardId, file);
                          if (outcome.ok) ingest(outcome.record);
                          else refused.push(`${file.name}: ${outcome.message}`);
                        }
                        // A file that was quietly dropped is worse than a dialog.
                        if (refused.length > 0) {
                          await tell({
                            title: t("That file was not accepted"),
                            description: refused.join("\n"),
                          });
                        }
                      }}
                      onRenameList={(lid, title) =>
                        apply({ kind: "list.rename", listId: lid, title })
                      }
                      onDeleteList={async (lid, count) => {
                        const name = listById.get(lid)?.title ?? t("this list");
                        const ok = await confirm({
                          title: t("Delete “{name}”?", { name }),
                          description:
                            count > 0
                              ? pl(
                                  count,
                                  "Its {count} card goes with it, and this cannot be undone. Archive the cards first if you might want them back.",
                                  "Its {count} cards go with it, and this cannot be undone. Archive the cards first if you might want them back.",
                                )
                              : t("This cannot be undone."),
                          confirmLabel: t("Delete list"),
                          danger: true,
                        });
                        if (ok) apply({ kind: "list.delete", listId: lid });
                      }}
                      onSetWip={(lid, wipLimit) =>
                        apply({ kind: "list.setWip", listId: lid, wipLimit })
                      }
                      onOpenCard={onOpenCard}
                    />
                  );
                })}

                {lane.key === firstLaneKey && (
                  <div className="composer addlist">
                    <button
                      type="button"
                      onClick={async () => {
                        const answer = await ask({
                          title: t("Add a list"),
                          fields: [
                            { name: "title", label: t("List name"), placeholder: "In review" },
                          ],
                          confirmLabel: t("Add list"),
                        });
                        const title = answer?.title?.trim();
                        if (!title) return;
                        apply({
                          kind: "list.create",
                          listId: crypto.randomUUID(),
                          title,
                          position: atEnd(lists.at(-1)?.position ?? null),
                        });
                      }}
                    >
                      {t("Add a list")}
                    </button>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </DragDropProvider>
  );
}
