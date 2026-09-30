import { useSortable } from "@dnd-kit/react/sortable";
import {
  attachmentsFor,
  checklistProgress,
  coverImageFor,
  staleness,
  type BoardState,
  type Card as CardModel,
} from "@pergola/shared";
import { avatarColor, hexFor, initials } from "../lib/labels.js";
import { useT, useDateLocale } from "../lib/i18n.js";
import { formatExact, formatWhen } from "../lib/time.js";
import { displayName, usePeople } from "../lib/people.js";

type Props = {
  state: BoardState;
  card: CardModel;
  index: number;
  /** The droppable id of the cell this card is rendered in — see Board.tsx. */
  columnId: string;
  onOpen: (id: string) => void;
};

export function Card({ state, card, index, columnId, onOpen }: Props) {
  const t = useT();
  const locale = useDateLocale();
  const people = usePeople();
  const { ref, isDragging } = useSortable({
    id: card.id,
    index,
    type: "item",
    accept: "item",
    /*
     * `group` scopes the card to its cell so dnd-kit knows which list it left.
     * It must be the cell's droppable id — the one Board.tsx keys its state by
     * — because the sortable plugin compares the two to tell "dropped into a
     * bay" from "dropped onto a card".
     */
    group: columnId,
  });

  const progress = checklistProgress(state, card.id);
  /*
   * Card aging. Stale work should look stale — a card nobody has touched in
   * weeks fades rather than sitting there looking as current as everything else.
   */
  const stale = staleness(card);
  const labels = card.labelIds
    .map((id) => state.labels.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => Boolean(l));
  const memberById = new Map(state.members.map((m) => [m.id, m]));
  /* A picture is the fastest thing to recognise in a list of cards. */
  const preview = coverImageFor(state, card.id);
  const attachments = attachmentsFor(state, card.id);
  // Anyone the board can name — a member, an admin who never joined, someone
  // who left — and the name recorded at creation for anyone else.
  const makerName = displayName(people(card.createdBy)) ?? card.createdByName;

  return (
    <article
      ref={ref}
      className="card"
      data-dragging={isDragging}
      style={stale > 0 ? { opacity: 1 - stale * 0.55 } : undefined}
      title={stale > 0.5 ? t("Nothing has happened here in a while") : undefined}
      tabIndex={0}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(card.id);
        }
      }}
    >
      {preview ? (
        <img
          className="card-preview"
          src={preview.url}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : (
        card.coverColor && (
          <div className="cover" style={{ background: hexFor(card.coverColor) }} />
        )
      )}

      {labels.length > 0 && (
        <div className="card-labels">
          {labels.map((l) => (
            <span
              key={l.id}
              className="label-dash"
              style={{ background: hexFor(l.color) }}
              title={l.name || l.color}
            />
          ))}
        </div>
      )}

      <div className="card-title">{card.title}</div>

      <div className="card-meta">
        {/*
          * Who put the card here and when, to the minute — the question a list
          * of cards actually gets asked. The PRG number is a reference, and it
          * stays in the card itself, the table and search; on the face it is
          * shown only for a card old enough to have no record of its making.
          */}
        {card.createdAt ? (
          <span
            className="card-by"
            title={`${makerName ? t("Created by {name}", { name: makerName }) : t("Created by someone no longer here")} · ${formatExact(card.createdAt, locale)}`}
          >
            <span
              className="chip avatar small"
              style={{ background: card.createdBy ? avatarColor(card.createdBy) : "var(--muted)" }}
              aria-hidden="true"
            >
              {initials(makerName ?? "?")}
            </span>
            <time dateTime={card.createdAt}>
              {formatWhen(card.createdAt, t, locale)}
            </time>
          </span>
        ) : (
          <span className="card-no mono">PRG-{card.number}</span>
        )}

        {card.dueAt && <Due dueAt={card.dueAt} />}

        {progress.total > 0 && (
          <span
            className={`badge mono${progress.done === progress.total ? " complete" : ""}`}
            title={t("Checklist items")}
          >
            ✓ {progress.done}/{progress.total}
          </span>
        )}

        {card.voterIds.length > 0 && (
          <span className="badge mono" title={t("{count} vote(s)", { count: card.voterIds.length })}>
            ▲ {card.voterIds.length}
          </span>
        )}

        {card.descMd && (
          <span className="badge" title={t("Has a description")} aria-label={t("Has a description")}>
            ≡
          </span>
        )}

        {attachments.length > 0 && (
          <span
            className="badge mono"
            title={t("{count} attachment(s)", { count: attachments.length })}
          >
            🔗 {attachments.length}
          </span>
        )}

        <span className="grow" />

        {card.assigneeIds.slice(0, 3).map((id) => {
          const m = memberById.get(id);
          return (
            <span
              key={id}
              className="chip avatar small"
              style={{ background: avatarColor(id) }}
              title={m?.name ?? id}
            >
              {initials(m?.name ?? m?.email ?? "?")}
            </span>
          );
        })}
      </div>
    </article>
  );
}

function Due({ dueAt }: { dueAt: string }) {
  const locale = useDateLocale();
  const due = new Date(dueAt);
  const ms = due.getTime() - Date.now();
  const overdue = ms < 0;
  // "Soon" is the next 48 hours: long enough to act on, short enough to mean it.
  const soon = !overdue && ms < 48 * 3600_000;
  return (
    <span
      className={`badge due${overdue ? " overdue" : soon ? " soon" : ""}`}
      title={due.toLocaleString(locale)}
    >
      {due.toLocaleDateString(locale, { month: "short", day: "numeric" })}
    </span>
  );
}
