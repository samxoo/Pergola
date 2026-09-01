import type { MutationBody } from "./mutations.js";
import { byPosition } from "./order.js";

export type Member = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type Label = {
  id: string;
  name: string;
  color: string;
  position: string;
};

export type List = {
  id: string;
  position: string;
  title: string;
  wipLimit: number | null;
};

export type Card = {
  id: string;
  listId: string;
  position: string;
  title: string;
  number: number;
  descMd: string | null;
  startAt: string | null;
  dueAt: string | null;
  coverColor: string | null;
  archivedAt: string | null;
  labelIds: string[];
  assigneeIds: string[];
  /** fieldId -> value. Always text; the field's type decides how to read it. */
  fields: Record<string, string>;
  /** Who has voted for this card. */
  voterIds: string[];
  /**
   * When anything last happened to this card, from the mutation log.
   *
   * Card aging reads this: a card nobody has touched in weeks fades, which is
   * the point of the feature — stale work should look stale.
   */
  lastActivityAt: string | null;
};

export type CustomField = {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  options: string[];
  position: string;
};

export type Checklist = {
  id: string;
  cardId: string;
  title: string;
  position: string;
};

export type ChecklistItem = {
  id: string;
  checklistId: string;
  text: string;
  done: boolean;
  dueAt: string | null;
  assigneeId: string | null;
  position: string;
};

export type Attachment = {
  id: string;
  cardId: string;
  url: string;
  name: string;
  addedBy: string | null;
  createdAt: string;
};

export type Comment = {
  id: string;
  cardId: string;
  authorId: string;
  body: string;
  /** The comment this answers, or null for one that starts a thread. */
  parentId: string | null;
  createdAt: string;
  editedAt: string | null;
};

export type BoardState = {
  id: string;
  title: string;
  /** Last mutation sequence this snapshot reflects. The client's sync cursor. */
  seq: number;
  lists: List[];
  cards: Card[];
  labels: Label[];
  fields: CustomField[];
  checklists: Checklist[];
  items: ChecklistItem[];
  attachments: Attachment[];
  comments: Comment[];
  members: Member[];
};

/**
 * Who did it and when.
 *
 * The socket path passes the server's authoritative values; the optimistic path
 * passes the current user and the local clock, and the echo corrects it. Keeping
 * this out of the mutation body means the client cannot claim to be someone else.
 */
export type Meta = { actorId: string | null; at: string };

/**
 * The single reducer.
 *
 * It serves three call sites — the optimistic path in the UI, the socket delta
 * path, and offline replay — which is the point: if it is correct once it is
 * correct three times. It is pure and total, so it is also the easiest thing in
 * the codebase to test.
 *
 * Unknown or already-applied work is returned unchanged rather than throwing. A
 * reducer that threw mid-replay would leave a client wedged with no way back.
 */
export function reduce(state: BoardState, body: MutationBody, meta: Meta): BoardState {
  switch (body.kind) {
    /* ------------------------------------------------------------- lists */
    case "list.create": {
      if (has(state.lists, body.listId)) return state;
      return {
        ...state,
        lists: [
          ...state.lists,
          { id: body.listId, title: body.title, position: body.position, wipLimit: null },
        ].sort(byPosition),
      };
    }
    case "list.rename":
      return mapIn(state, "lists", body.listId, (l) => ({ ...l, title: body.title }));
    case "list.move": {
      const next = mapIn(state, "lists", body.listId, (l) => ({ ...l, position: body.position }));
      return next === state ? state : { ...next, lists: [...next.lists].sort(byPosition) };
    }
    case "list.setWip":
      return mapIn(state, "lists", body.listId, (l) => ({ ...l, wipLimit: body.wipLimit }));
    case "list.delete": {
      if (!has(state.lists, body.listId)) return state;
      const gone = new Set(state.cards.filter((c) => c.listId === body.listId).map((c) => c.id));
      return {
        ...state,
        lists: state.lists.filter((l) => l.id !== body.listId),
        ...withoutCards(state, gone),
      };
    }

    /* ------------------------------------------------------------- cards */
    case "card.create": {
      if (has(state.cards, body.cardId)) return state;
      // The real number is assigned by the database; show the next one until the
      // echo arrives, which overwrites it.
      const number = state.cards.reduce((m, c) => Math.max(m, c.number), 0) + 1;
      return {
        ...state,
        cards: [
          ...state.cards,
          {
            id: body.cardId,
            listId: body.listId,
            title: body.title,
            position: body.position,
            number,
            descMd: null,
            startAt: null,
            dueAt: null,
            coverColor: null,
            archivedAt: null,
            labelIds: [],
            assigneeIds: [],
            fields: {},
            voterIds: [],
            lastActivityAt: meta.at,
          },
        ],
      };
    }
    case "card.move":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        listId: body.toListId,
        position: body.position,
      }));
    case "card.rename":
      return mapIn(state, "cards", body.cardId, (c) => ({ ...c, title: body.title }));
    case "card.describe":
      return mapIn(state, "cards", body.cardId, (c) => ({ ...c, descMd: body.descMd }));
    case "card.setDates":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        startAt: body.startAt,
        dueAt: body.dueAt,
      }));
    case "card.setCover":
      return mapIn(state, "cards", body.cardId, (c) => ({ ...c, coverColor: body.coverColor }));
    case "card.archive":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        archivedAt: body.archived ? meta.at : null,
      }));
    case "card.delete": {
      if (!has(state.cards, body.cardId)) return state;
      return { ...state, ...withoutCards(state, new Set([body.cardId])) };
    }

    /* ------------------------------------------------------------ labels */
    case "label.create": {
      if (has(state.labels, body.labelId)) return state;
      return {
        ...state,
        labels: [
          ...state.labels,
          { id: body.labelId, name: body.name, color: body.color, position: body.position },
        ].sort(byPosition),
      };
    }
    case "label.update":
      return mapIn(state, "labels", body.labelId, (l) => ({
        ...l,
        name: body.name,
        color: body.color,
      }));
    case "label.delete": {
      if (!has(state.labels, body.labelId)) return state;
      return {
        ...state,
        labels: state.labels.filter((l) => l.id !== body.labelId),
        // A deleted label must not linger on the cards that wore it.
        cards: state.cards.map((c) =>
          c.labelIds.includes(body.labelId)
            ? { ...c, labelIds: c.labelIds.filter((id) => id !== body.labelId) }
            : c,
        ),
      };
    }
    case "card.label":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        labelIds: toggle(c.labelIds, body.labelId, body.on),
      }));

    /* --------------------------------------------------------- assignees */
    case "card.assign":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        assigneeIds: toggle(c.assigneeIds, body.userId, body.on),
      }));

    /* ------------------------------------------------------ custom fields */
    case "field.create": {
      if (has(state.fields, body.fieldId)) return state;
      return {
        ...state,
        fields: [
          ...state.fields,
          {
            id: body.fieldId,
            name: body.name,
            type: body.type,
            options: body.options,
            position: body.position,
          },
        ].sort(byPosition),
      };
    }
    case "field.update":
      return mapIn(state, "fields", body.fieldId, (f) => ({
        ...f,
        name: body.name,
        options: body.options,
      }));
    case "field.delete": {
      if (!has(state.fields, body.fieldId)) return state;
      return {
        ...state,
        fields: state.fields.filter((f) => f.id !== body.fieldId),
        // A deleted field must not leave orphaned values on the cards.
        cards: state.cards.map((c) => {
          if (!(body.fieldId in c.fields)) return c;
          const { [body.fieldId]: _gone, ...rest } = c.fields;
          return { ...c, fields: rest };
        }),
      };
    }
    case "card.setField":
      return mapIn(state, "cards", body.cardId, (c) => {
        if (body.value === null) {
          const { [body.fieldId]: _cleared, ...rest } = c.fields;
          return { ...c, fields: rest };
        }
        return { ...c, fields: { ...c.fields, [body.fieldId]: body.value } };
      });

    /* -------------------------------------------------------- checklists */
    case "checklist.create": {
      if (has(state.checklists, body.checklistId)) return state;
      return {
        ...state,
        checklists: [
          ...state.checklists,
          {
            id: body.checklistId,
            cardId: body.cardId,
            title: body.title,
            position: body.position,
          },
        ].sort(byPosition),
      };
    }
    case "checklist.rename":
      return mapIn(state, "checklists", body.checklistId, (c) => ({ ...c, title: body.title }));
    case "checklist.delete": {
      if (!has(state.checklists, body.checklistId)) return state;
      return {
        ...state,
        checklists: state.checklists.filter((c) => c.id !== body.checklistId),
        items: state.items.filter((i) => i.checklistId !== body.checklistId),
      };
    }

    case "item.create": {
      if (has(state.items, body.itemId)) return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: body.itemId,
            checklistId: body.checklistId,
            text: body.text,
            done: false,
            dueAt: null,
            assigneeId: null,
            position: body.position,
          },
        ].sort(byPosition),
      };
    }
    case "item.toggle":
      return mapIn(state, "items", body.itemId, (i) => ({ ...i, done: body.done }));
    case "item.rename":
      return mapIn(state, "items", body.itemId, (i) => ({ ...i, text: body.text }));
    case "item.setDue":
      return mapIn(state, "items", body.itemId, (i) => ({
        ...i,
        dueAt: body.dueAt,
        assigneeId: body.assigneeId,
      }));
    case "item.move": {
      const next = mapIn(state, "items", body.itemId, (i) => ({ ...i, position: body.position }));
      return next === state ? state : { ...next, items: [...next.items].sort(byPosition) };
    }
    case "item.delete": {
      if (!has(state.items, body.itemId)) return state;
      return { ...state, items: state.items.filter((i) => i.id !== body.itemId) };
    }

    /* ------------------------------------------------------------- votes */
    case "card.vote":
      return mapIn(state, "cards", body.cardId, (c) => ({
        ...c,
        voterIds: toggle(c.voterIds, meta.actorId ?? "", body.on),
      }));

    /* ------------------------------------------------------- attachments */
    case "attachment.add": {
      if (has(state.attachments, body.attachmentId)) return state;
      return {
        ...state,
        attachments: [
          ...state.attachments,
          {
            id: body.attachmentId,
            cardId: body.cardId,
            url: body.url,
            name: body.name,
            addedBy: meta.actorId,
            createdAt: meta.at,
          },
        ],
      };
    }
    case "attachment.remove": {
      if (!has(state.attachments, body.attachmentId)) return state;
      return {
        ...state,
        attachments: state.attachments.filter((a) => a.id !== body.attachmentId),
      };
    }

    /* ---------------------------------------------------------- comments */
    case "comment.create": {
      const existing = state.comments.find((c) => c.id === body.commentId);
      if (existing) {
        // The echo carries the server's author and timestamp; adopt them without
        // creating a second entry, so this stays idempotent under replay.
        return mapIn(state, "comments", body.commentId, (c) => ({
          ...c,
          authorId: meta.actorId ?? c.authorId,
          createdAt: meta.at,
        }));
      }
      return {
        ...state,
        comments: [
          ...state.comments,
          {
            id: body.commentId,
            cardId: body.cardId,
            authorId: meta.actorId ?? "",
            body: body.body,
            parentId: body.parentId ?? null,
            createdAt: meta.at,
            editedAt: null,
          },
        ],
      };
    }
    case "comment.edit":
      return mapIn(state, "comments", body.commentId, (c) => ({
        ...c,
        body: body.body,
        editedAt: meta.at,
      }));
    case "comment.delete": {
      if (!has(state.comments, body.commentId)) return state;
      return { ...state, comments: state.comments.filter((c) => c.id !== body.commentId) };
    }

    default: {
      const never: never = body;
      return never;
    }
  }
}

/* ------------------------------------------------------------------ helpers */

type Collections =
  | "lists" | "cards" | "labels" | "fields"
  | "checklists" | "items" | "attachments" | "comments";

const has = (rows: readonly { id: string }[], id: string) => rows.some((r) => r.id === id);

function mapIn<K extends Collections>(
  state: BoardState,
  key: K,
  id: string,
  f: (row: BoardState[K][number]) => BoardState[K][number],
): BoardState {
  const rows = state[key] as { id: string }[];
  if (!rows.some((r) => r.id === id)) return state;
  return {
    ...state,
    [key]: (rows as BoardState[K]).map((r) => (r.id === id ? f(r) : r)),
  } as BoardState;
}

const toggle = (xs: string[], x: string, on: boolean) =>
  on ? (xs.includes(x) ? xs : [...xs, x]) : xs.filter((v) => v !== x);

/** Removing cards has to take their checklists, items and comments with them. */
function withoutCards(state: BoardState, ids: ReadonlySet<string>) {
  const lists = state.checklists.filter((c) => ids.has(c.cardId)).map((c) => c.id);
  const dropped = new Set(lists);
  return {
    cards: state.cards.filter((c) => !ids.has(c.id)),
    checklists: state.checklists.filter((c) => !ids.has(c.cardId)),
    items: state.items.filter((i) => !dropped.has(i.checklistId)),
    attachments: state.attachments.filter((a) => !ids.has(a.cardId)),
    comments: state.comments.filter((c) => !ids.has(c.cardId)),
  };
}

/* ---------------------------------------------------------------- selectors */

/** Cards of one list, in order, excluding anything archived. */
export function cardsInList(state: BoardState, listId: string): Card[] {
  return state.cards
    .filter((c) => c.listId === listId && !c.archivedAt)
    .sort(byPosition);
}

export function orderedLists(state: BoardState): List[] {
  return [...state.lists].sort(byPosition);
}

export function checklistsFor(state: BoardState, cardId: string): Checklist[] {
  return state.checklists.filter((c) => c.cardId === cardId).sort(byPosition);
}

export function itemsFor(state: BoardState, checklistId: string): ChecklistItem[] {
  return state.items.filter((i) => i.checklistId === checklistId).sort(byPosition);
}

export function attachmentsFor(state: BoardState, cardId: string): Attachment[] {
  return state.attachments.filter((a) => a.cardId === cardId);
}

/**
 * Uploads keep their real name, so the extension is a good-enough hint. Nothing
 * is decoded here: the worst a wrong guess costs is an <img> that does not load.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name.trim());
}

/**
 * The picture that stands for a card.
 *
 * The first image attached to it, and no separate setting to keep in step: on a
 * card whose point is a screenshot, that is the screenshot, and on a card
 * without one there is nothing to show. Used by the board, where it is the
 * preview, and by the card itself, where it is the banner along the top.
 */
export function coverImageFor(state: BoardState, cardId: string): Attachment | null {
  return state.attachments.find((a) => a.cardId === cardId && isImageName(a.name)) ?? null;
}

export function commentsFor(state: BoardState, cardId: string): Comment[] {
  return state.comments
    .filter((c) => c.cardId === cardId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
}

/** A comment and the replies under it. */
export type CommentThread = { comment: Comment; replies: Comment[] };

/**
 * A card's comments as threads.
 *
 * Threads newest first, the way the flat list has always read, but the replies
 * inside one oldest first — a conversation is read downwards even when the
 * conversations themselves are stacked newest at the top.
 *
 * Nesting is one deep on purpose. A reply to a reply joins the same thread
 * rather than indenting again, so no conversation can walk off the right-hand
 * edge, and a reply whose parent has been deleted resurfaces as its own thread
 * instead of vanishing with it.
 */
export function commentThreads(state: BoardState, cardId: string): CommentThread[] {
  const mine = state.comments.filter((c) => c.cardId === cardId);
  const byId = new Map(mine.map((c) => [c.id, c]));

  /** Walk up to the comment that starts the thread, guarding against a cycle. */
  const rootOf = (c: Comment): Comment => {
    const seen = new Set<string>([c.id]);
    let at = c;
    while (at.parentId) {
      const up = byId.get(at.parentId);
      if (!up || seen.has(up.id)) break;
      seen.add(up.id);
      at = up;
    }
    return at;
  };

  const replies = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of mine) {
    const root = rootOf(c);
    if (root.id === c.id) roots.push(c);
    else replies.set(root.id, [...(replies.get(root.id) ?? []), c]);
  }

  const oldestFirst = (a: Comment, b: Comment) => (a.createdAt < b.createdAt ? -1 : 1);
  return roots
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((comment) => ({ comment, replies: (replies.get(comment.id) ?? []).sort(oldestFirst) }));
}

/** Ticked / total across a card's checklists — what the badge shows. */
export function checklistProgress(state: BoardState, cardId: string) {
  const ids = new Set(checklistsFor(state, cardId).map((c) => c.id));
  const items = state.items.filter((i) => ids.has(i.checklistId));
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/**
 * How stale a card looks, 0 (fresh) to 1 (forgotten).
 *
 * Trello calls this card aging and hides it behind a Power-Up. Two weeks of
 * silence is the point where a card stops being current, and eight weeks is
 * where it may as well be archived.
 */
export function staleness(card: Card, now = Date.now()): number {
  if (!card.lastActivityAt) return 0;
  const days = (now - new Date(card.lastActivityAt).getTime()) / 86_400_000;
  if (days < 14) return 0;
  return Math.min((days - 14) / 42, 1);
}

/** True when a list is over the limit its owner set for it. */
export function isOverWip(state: BoardState, list: List): boolean {
  return list.wipLimit !== null && cardsInList(state, list.id).length > list.wipLimit;
}
