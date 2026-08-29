import { and, eq, sql } from "drizzle-orm";
import type { MutationBody, MutationKind } from "@pergola/shared";
import type { Tx } from "../db/index.js";
import {
  attachment,
  board,
  boardMember,
  card,
  cardAssignee,
  cardLabel,
  cardVote,
  checklist,
  checklistItem,
  comment,
  customField,
  customFieldValue,
  label,
  list,
} from "../db/schema.js";

/** Thrown when a mutation refers to something that is not there any more. */
export class Stale extends Error {
  constructor(what: string) {
    super(`${what} no longer exists`);
    this.name = "Stale";
  }
}

/**
 * A handler applies one mutation and returns the mutation that undoes it, or
 * null when the change is not undoable.
 *
 * Every handler reads the previous value *before* writing, because that read is
 * what makes undo possible. This is the only place in the server that mutates
 * board content.
 *
 * On undoability: a delete that cascades cannot be honestly reversed by a single
 * inverse — restoring a card would not bring back its comments. So cascading
 * deletes return null, and `card.archive` is the safe, fully reversible action
 * the interface actually offers.
 */
type Handler<K extends MutationKind> = (
  tx: Tx,
  boardId: string,
  body: Extract<MutationBody, { kind: K }>,
  actorId: string | null,
) => Promise<MutationBody | null>;

type Handlers = { [K in MutationKind]: Handler<K> };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);

export const handlers: Handlers = {
  /* --------------------------------------------------------------- lists */
  "list.create": async (tx, boardId, b) => {
    await tx.insert(list).values({
      id: b.listId,
      boardId,
      title: b.title,
      position: b.position,
    });
    return { kind: "list.delete", listId: b.listId };
  },

  "list.rename": async (tx, boardId, b) => {
    const prev = await getList(tx, boardId, b.listId);
    await tx.update(list).set({ title: b.title }).where(eq(list.id, b.listId));
    return { kind: "list.rename", listId: b.listId, title: prev.title };
  },

  "list.move": async (tx, boardId, b) => {
    const prev = await getList(tx, boardId, b.listId);
    await tx.update(list).set({ position: b.position }).where(eq(list.id, b.listId));
    return { kind: "list.move", listId: b.listId, position: prev.position };
  },

  "list.setWip": async (tx, boardId, b) => {
    const prev = await getList(tx, boardId, b.listId);
    await tx.update(list).set({ wipLimit: b.wipLimit }).where(eq(list.id, b.listId));
    return { kind: "list.setWip", listId: b.listId, wipLimit: prev.wipLimit };
  },

  "list.delete": async (tx, boardId, b) => {
    await getList(tx, boardId, b.listId);
    await tx.delete(list).where(eq(list.id, b.listId));
    return null; // cascades to its cards
  },

  /* --------------------------------------------------------------- cards */
  "card.create": async (tx, boardId, b) => {
    // The list has to belong to this board. Without it a card can be parked on
    // another board's list — public boards hand their list ids out to anyone.
    await getList(tx, boardId, b.listId);
    // The board row is already locked by the seq bump in commit(), so this
    // second update never contends with anything new.
    const [row] = await tx
      .update(board)
      .set({ cardSeq: sql`${board.cardSeq} + 1` })
      .where(eq(board.id, boardId))
      .returning({ number: board.cardSeq });

    await tx.insert(card).values({
      id: b.cardId,
      boardId,
      listId: b.listId,
      title: b.title,
      position: b.position,
      number: row!.number,
    });
    return { kind: "card.delete", cardId: b.cardId };
  },

  "card.move": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await getList(tx, boardId, b.toListId);
    await tx
      .update(card)
      .set({ listId: b.toListId, position: b.position })
      .where(eq(card.id, b.cardId));
    return {
      kind: "card.move",
      cardId: b.cardId,
      toListId: prev.listId,
      position: prev.position,
    };
  },

  "card.rename": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await tx.update(card).set({ title: b.title }).where(eq(card.id, b.cardId));
    return { kind: "card.rename", cardId: b.cardId, title: prev.title };
  },

  "card.describe": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await tx.update(card).set({ descMd: b.descMd }).where(eq(card.id, b.cardId));
    return { kind: "card.describe", cardId: b.cardId, descMd: prev.descMd };
  },

  "card.setDates": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await tx
      .update(card)
      .set({ startAt: date(b.startAt), dueAt: date(b.dueAt) })
      .where(eq(card.id, b.cardId));
    return {
      kind: "card.setDates",
      cardId: b.cardId,
      startAt: iso(prev.startAt),
      dueAt: iso(prev.dueAt),
    };
  },

  "card.setCover": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await tx.update(card).set({ coverColor: b.coverColor }).where(eq(card.id, b.cardId));
    return { kind: "card.setCover", cardId: b.cardId, coverColor: prev.coverColor };
  },

  "card.archive": async (tx, boardId, b) => {
    const prev = await getCard(tx, boardId, b.cardId);
    await tx
      .update(card)
      .set({ archivedAt: b.archived ? new Date() : null })
      .where(eq(card.id, b.cardId));
    return { kind: "card.archive", cardId: b.cardId, archived: prev.archivedAt !== null };
  },

  "card.delete": async (tx, boardId, b) => {
    await getCard(tx, boardId, b.cardId);
    await tx.delete(card).where(eq(card.id, b.cardId));
    return null; // cascades to checklists, items, comments and attachments
  },

  /* -------------------------------------------------------------- labels */
  "label.create": async (tx, boardId, b) => {
    await tx.insert(label).values({
      id: b.labelId,
      boardId,
      name: b.name,
      color: b.color,
      position: b.position,
    });
    return { kind: "label.delete", labelId: b.labelId };
  },

  "label.update": async (tx, boardId, b) => {
    const prev = await getLabel(tx, boardId, b.labelId);
    await tx
      .update(label)
      .set({ name: b.name, color: b.color })
      .where(eq(label.id, b.labelId));
    return { kind: "label.update", labelId: b.labelId, name: prev.name, color: prev.color };
  },

  "label.delete": async (tx, boardId, b) => {
    await getLabel(tx, boardId, b.labelId);
    await tx.delete(label).where(eq(label.id, b.labelId));
    return null; // cascades off every card that wore it
  },

  "card.label": async (tx, boardId, b) => {
    await getCard(tx, boardId, b.cardId);
    await getLabel(tx, boardId, b.labelId);
    if (b.on) {
      await tx
        .insert(cardLabel)
        .values({ cardId: b.cardId, labelId: b.labelId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(cardLabel)
        .where(and(eq(cardLabel.cardId, b.cardId), eq(cardLabel.labelId, b.labelId)));
    }
    return { kind: "card.label", cardId: b.cardId, labelId: b.labelId, on: !b.on };
  },

  /* ----------------------------------------------------------- assignees */
  "card.assign": async (tx, boardId, b) => {
    await getCard(tx, boardId, b.cardId);
    /*
     * Only people on the board can be assigned to its cards.
     *
     * The user id arrives from the client and used to be taken on trust, which
     * meant anyone could assign a stranger to a private card — and the
     * notification that followed carried the card's title to someone who could
     * not open the board, then kept doing so on every later change.
     */
    if (b.on) await requireMember(tx, boardId, b.userId);
    if (b.on) {
      await tx
        .insert(cardAssignee)
        .values({ cardId: b.cardId, userId: b.userId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(cardAssignee)
        .where(and(eq(cardAssignee.cardId, b.cardId), eq(cardAssignee.userId, b.userId)));
    }
    return { kind: "card.assign", cardId: b.cardId, userId: b.userId, on: !b.on };
  },

  /* ---------------------------------------------------------- checklists */
  "checklist.create": async (tx, boardId, b) => {
    await getCard(tx, boardId, b.cardId);
    await tx.insert(checklist).values({
      id: b.checklistId,
      cardId: b.cardId,
      title: b.title,
      position: b.position,
    });
    return { kind: "checklist.delete", checklistId: b.checklistId };
  },

  "checklist.rename": async (tx, boardId, b) => {
    const prev = await getChecklist(tx, boardId, b.checklistId);
    await tx
      .update(checklist)
      .set({ title: b.title })
      .where(eq(checklist.id, b.checklistId));
    return { kind: "checklist.rename", checklistId: b.checklistId, title: prev.title };
  },

  "checklist.delete": async (tx, boardId, b) => {
    await getChecklist(tx, boardId, b.checklistId);
    await tx.delete(checklist).where(eq(checklist.id, b.checklistId));
    return null; // cascades to its items
  },

  "item.create": async (tx, boardId, b) => {
    await getChecklist(tx, boardId, b.checklistId);
    await tx.insert(checklistItem).values({
      id: b.itemId,
      checklistId: b.checklistId,
      text: b.text,
      position: b.position,
    });
    return { kind: "item.delete", itemId: b.itemId };
  },

  "item.toggle": async (tx, boardId, b) => {
    const prev = await getItem(tx, boardId, b.itemId);
    await tx.update(checklistItem).set({ done: b.done }).where(eq(checklistItem.id, b.itemId));
    return { kind: "item.toggle", itemId: b.itemId, done: prev.done };
  },

  "item.rename": async (tx, boardId, b) => {
    const prev = await getItem(tx, boardId, b.itemId);
    await tx.update(checklistItem).set({ text: b.text }).where(eq(checklistItem.id, b.itemId));
    return { kind: "item.rename", itemId: b.itemId, text: prev.text };
  },

  "item.setDue": async (tx, boardId, b) => {
    const prev = await getItem(tx, boardId, b.itemId);
    if (b.assigneeId) await requireMember(tx, boardId, b.assigneeId);
    await tx
      .update(checklistItem)
      .set({ dueAt: date(b.dueAt), assigneeId: b.assigneeId })
      .where(eq(checklistItem.id, b.itemId));
    return {
      kind: "item.setDue",
      itemId: b.itemId,
      dueAt: iso(prev.dueAt),
      assigneeId: prev.assigneeId,
    };
  },

  "item.move": async (tx, boardId, b) => {
    const prev = await getItem(tx, boardId, b.itemId);
    await tx
      .update(checklistItem)
      .set({ position: b.position })
      .where(eq(checklistItem.id, b.itemId));
    return { kind: "item.move", itemId: b.itemId, position: prev.position };
  },

  "item.delete": async (tx, boardId, b) => {
    const prev = await getItem(tx, boardId, b.itemId);
    await tx.delete(checklistItem).where(eq(checklistItem.id, b.itemId));
    return {
      kind: "item.create",
      itemId: prev.id,
      checklistId: prev.checklistId,
      text: prev.text,
      position: prev.position,
    };
  },

  /* ------------------------------------------------------- custom fields */
  "field.create": async (tx, boardId, b) => {
    await tx.insert(customField).values({
      id: b.fieldId,
      boardId,
      name: b.name,
      type: b.type,
      options: b.options,
      position: b.position,
    });
    return { kind: "field.delete", fieldId: b.fieldId };
  },

  "field.update": async (tx, boardId, b) => {
    const prev = await getField(tx, boardId, b.fieldId);
    await tx
      .update(customField)
      .set({ name: b.name, options: b.options })
      .where(eq(customField.id, b.fieldId));
    return {
      kind: "field.update",
      fieldId: b.fieldId,
      name: prev.name,
      options: prev.options,
    };
  },

  "field.delete": async (tx, boardId, b) => {
    await getField(tx, boardId, b.fieldId);
    await tx.delete(customField).where(eq(customField.id, b.fieldId));
    return null; // cascades off every card that carried a value
  },

  "card.setField": async (tx, boardId, b) => {
    await getCard(tx, boardId, b.cardId);
    await getField(tx, boardId, b.fieldId);
    const [prev] = await tx
      .select({ value: customFieldValue.value })
      .from(customFieldValue)
      .where(
        and(eq(customFieldValue.cardId, b.cardId), eq(customFieldValue.fieldId, b.fieldId)),
      )
      .limit(1);

    if (b.value === null) {
      await tx
        .delete(customFieldValue)
        .where(
          and(eq(customFieldValue.cardId, b.cardId), eq(customFieldValue.fieldId, b.fieldId)),
        );
    } else {
      await tx
        .insert(customFieldValue)
        .values({ cardId: b.cardId, fieldId: b.fieldId, value: b.value })
        .onConflictDoUpdate({
          target: [customFieldValue.cardId, customFieldValue.fieldId],
          set: { value: b.value },
        });
    }
    return {
      kind: "card.setField",
      cardId: b.cardId,
      fieldId: b.fieldId,
      value: prev?.value ?? null,
    };
  },

  /* --------------------------------------------------------------- votes */
  "card.vote": async (tx, boardId, b, actorId) => {
    await getCard(tx, boardId, b.cardId);
    if (!actorId) throw new Stale("Your session");
    if (b.on) {
      await tx
        .insert(cardVote)
        .values({ cardId: b.cardId, userId: actorId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(cardVote)
        .where(and(eq(cardVote.cardId, b.cardId), eq(cardVote.userId, actorId)));
    }
    return { kind: "card.vote", cardId: b.cardId, on: !b.on };
  },

  /* --------------------------------------------------------- attachments */
  "attachment.add": async (tx, boardId, b, actorId) => {
    await getCard(tx, boardId, b.cardId);
    await tx.insert(attachment).values({
      id: b.attachmentId,
      cardId: b.cardId,
      url: b.url,
      name: b.name,
      addedBy: actorId,
    });
    return { kind: "attachment.remove", attachmentId: b.attachmentId };
  },

  "attachment.remove": async (tx, boardId, b) => {
    const [row] = await tx
      .select({ a: attachment })
      .from(attachment)
      .innerJoin(card, eq(attachment.cardId, card.id))
      .where(and(eq(attachment.id, b.attachmentId), eq(card.boardId, boardId)))
      .limit(1);
    if (!row) throw new Stale("That attachment");
    await tx.delete(attachment).where(eq(attachment.id, b.attachmentId));
    return {
      kind: "attachment.add",
      attachmentId: row.a.id,
      cardId: row.a.cardId,
      url: row.a.url,
      name: row.a.name,
    };
  },

  /* ------------------------------------------------------------ comments */
  "comment.create": async (tx, boardId, b, actorId) => {
    await getCard(tx, boardId, b.cardId);
    if (!actorId) throw new Stale("Your session");
    await tx.insert(comment).values({
      id: b.commentId,
      cardId: b.cardId,
      authorId: actorId,
      body: b.body,
    });
    return { kind: "comment.delete", commentId: b.commentId };
  },

  "comment.edit": async (tx, boardId, b) => {
    const prev = await getComment(tx, boardId, b.commentId);
    await tx
      .update(comment)
      .set({ body: b.body, editedAt: new Date() })
      .where(eq(comment.id, b.commentId));
    return { kind: "comment.edit", commentId: b.commentId, body: prev.body };
  },

  "comment.delete": async (tx, boardId, b) => {
    const prev = await getComment(tx, boardId, b.commentId);
    await tx.delete(comment).where(eq(comment.id, b.commentId));
    // Undo re-posts the text, but attributes it to whoever pressed undo. Naming
    // that here rather than pretending authorship survives a delete.
    return {
      kind: "comment.create",
      commentId: prev.id,
      cardId: prev.cardId,
      body: prev.body,
    };
  },
};

/* ------------------------------------------------------------------ lookups
 * Every lookup is scoped to the board. A mutation that names a card on someone
 * else's board must fail here, not slip through to an UPDATE by primary key.
 */

/** Someone must be on the board before they can be attached to its work. */
async function requireMember(tx: Tx, boardId: string, userId: string) {
  const [row] = await tx
    .select({ userId: boardMember.userId })
    .from(boardMember)
    .where(and(eq(boardMember.boardId, boardId), eq(boardMember.userId, userId)))
    .limit(1);
  if (!row) throw new Stale("That person is not on this board, so they");
}

async function getList(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select()
    .from(list)
    .where(and(eq(list.id, id), eq(list.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That list");
  return row;
}

async function getCard(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select()
    .from(card)
    .where(and(eq(card.id, id), eq(card.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That card");
  return row;
}

async function getLabel(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select()
    .from(label)
    .where(and(eq(label.id, id), eq(label.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That label");
  return row;
}

async function getField(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select()
    .from(customField)
    .where(and(eq(customField.id, id), eq(customField.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That field");
  return row;
}

async function getChecklist(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select({ c: checklist })
    .from(checklist)
    .innerJoin(card, eq(checklist.cardId, card.id))
    .where(and(eq(checklist.id, id), eq(card.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That checklist");
  return row.c;
}

async function getItem(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select({ i: checklistItem })
    .from(checklistItem)
    .innerJoin(checklist, eq(checklistItem.checklistId, checklist.id))
    .innerJoin(card, eq(checklist.cardId, card.id))
    .where(and(eq(checklistItem.id, id), eq(card.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That item");
  return row.i;
}

async function getComment(tx: Tx, boardId: string, id: string) {
  const [row] = await tx
    .select({ m: comment })
    .from(comment)
    .innerJoin(card, eq(comment.cardId, card.id))
    .where(and(eq(comment.id, id), eq(card.boardId, boardId)))
    .limit(1);
  if (!row) throw new Stale("That comment");
  return row.m;
}
