import { useSortable } from "@dnd-kit/react/sortable";
import {
  checklistProgress,
  staleness,
  type BoardState,
  type Card as CardModel,
} from "@pergola/shared";
import { avatarColor, hexFor, initials } from "../lib/labels.js";
import { useT, useDateLocale } from "../lib/i18n.js";

type Props = {
  state: BoardState;
  card: CardModel;
  index: number;
  columnId: string;
  onOpen: (id: string) => void;
};

export function Card({ state, card, index, columnId, onOpen }: Props) {
  const t = useT();
  const { ref, isDragging } = useSortable({
    id: card.id,
    index,
    type: "item",
    accept: "item",
    // `group` scopes the card to its column so dnd-kit knows which list it left.
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
      {card.coverColor && (
        <div className="cover" style={{ background: hexFor(card.coverColor) }} />
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
        <span className="card-no mono">PRG-{card.number}</span>

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
