import { CollisionPriority } from "@dnd-kit/abstract";
import { useSortable } from "@dnd-kit/react/sortable";
import { useState } from "react";
import type { BoardState, Card as CardModel, List } from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
import { InlineEdit } from "../lib/InlineEdit.js";
import { useT } from "../lib/i18n.js";
import { Card } from "./Card.js";

type Props = {
  state: BoardState;
  /** Droppable id. Differs from list.id when swimlanes split a list per lane. */
  dndId: string;
  /** False for the repeated views of a list in lower swimlanes. */
  structural: boolean;
  list: List;
  index: number;
  cards: CardModel[];
  /** True while a dragged card is destined for this bay. See Board.tsx. */
  lit: boolean;
  onAdd: (listId: string, title: string) => void;
  onRenameList: (id: string, title: string) => void;
  onDeleteList: (id: string, cardCount: number) => void;
  /** Cards this cell holds but is not rendering, to keep the board responsive. */
  hidden: number;
  onShowMore: () => void;
  onSetWip: (id: string, wipLimit: number | null) => void;
  onOpenCard: (id: string) => void;
};

export function Column({
  state,
  dndId,
  structural,
  list,
  index,
  cards,
  lit,
  hidden,
  onShowMore,
  onAdd,
  onRenameList,
  onDeleteList,
  onSetWip,
  onOpenCard,
}: Props) {
  const t = useT();
  const { ask } = useDialogs();
  // Kanban's actual central idea, which Trello never shipped without a Power-Up.
  const overWip = list.wipLimit !== null && cards.length > list.wipLimit;
  const { ref, isDragging, isDropTarget } = useSortable({
    id: dndId,
    index,
    type: "column",
    accept: structural ? ["column", "item"] : ["item"],
    disabled: !structural,
    // Without this a card dragged over a column makes the *column* the drop
    // target and the card never sorts into place — the single most common bug
    // in every kanban clone.
    collisionPriority: CollisionPriority.Low,
  });

  return (
    <section
      ref={ref}
      className={`column${lit || isDropTarget ? " is-over" : ""}${overWip ? " over-wip" : ""}`}
      data-dragging={isDragging}
    >
      <header className="column-head" style={structural ? undefined : { cursor: "default" }}>
        <InlineEdit
          value={list.title}
          onCommit={(title) => onRenameList(list.id, title)}
          className="column-edit"
          ariaLabel={t("Rename {title}", { title: list.title })}
        >
          {(open) => (
            <span className="column-title" onDoubleClick={open} title={t("Double-click to rename")}>
              {list.title}
            </span>
          )}
        </InlineEdit>
        <button
          className={`count mono${overWip ? " over" : ""}`}
          type="button"
          title={
            list.wipLimit === null
              ? t("Set a work-in-progress limit")
              : t("{count} of {limit} — click to change", { count: cards.length, limit: list.wipLimit })
          }
          onPointerDown={(e) => e.stopPropagation()}
          onClick={async () => {
            const answer = await ask({
              title: t("Work-in-progress limit"),
              description: t(
                "How many cards “{title}” should hold at once. The column turns red above it. Leave blank for no limit.",
                { title: list.title },
              ),
              fields: [
                {
                  name: "limit",
                  label: t("Limit"),
                  type: "number",
                  required: false,
                  defaultValue: list.wipLimit === null ? "" : String(list.wipLimit),
                  placeholder: t("No limit"),
                },
              ],
              confirmLabel: t("Set limit"),
            });
            if (!answer) return;
            const raw = (answer.limit ?? "").trim();
            if (!raw) return onSetWip(list.id, null);
            const n = Number(raw);
            if (Number.isInteger(n) && n > 0) onSetWip(list.id, n);
          }}
        >
          {cards.length}
          {list.wipLimit !== null && `/${list.wipLimit}`}
        </button>
        {structural && (
        <button
          className="list-del"
          type="button"
          aria-label={t("Delete list {title}", { title: list.title })}
          title={t("Delete this list")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDeleteList(list.id, cards.length)}
        >
          ×
        </button>
        )}
      </header>

      <div className="cards">
        {cards.map((card, i) => (
          <Card
            key={card.id}
            state={state}
            card={card}
            index={i}
            columnId={list.id}
            onOpen={onOpenCard}
          />
        ))}
      </div>

      {hidden > 0 && (
        <button className="show-more" type="button" onClick={onShowMore}>
          {t("Show {count} more", { count: Math.min(hidden, 60) })}
          <span className="muted mono"> · {t("{count} hidden", { count: hidden })}</span>
        </button>
      )}

      <Composer onAdd={(title) => onAdd(list.id, title)} />
    </section>
  );
}

function Composer({ onAdd }: { onAdd: (title: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const submit = () => {
    const title = text.trim();
    if (!title) return setOpen(false);
    onAdd(title);
    setText(""); // stay open: adding several cards in a row is the common case
  };

  if (!open) {
    return (
      <div className="composer">
        <button type="button" onClick={() => setOpen(true)}>
          {t("Add a card")}
        </button>
      </div>
    );
  }

  return (
    <div className="composer">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder={t("What needs doing?")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            setText("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
      />
      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> {t("to add")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("to close")}
        </span>
      </div>
    </div>
  );
}
