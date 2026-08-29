import { asc, eq, inArray, isNull, and } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { board, card, cardLabel, checklist, checklistItem, label, list } from "../db/schema.js";

/**
 * Public, read-only boards.
 *
 * Deliberately a narrower snapshot than the member view rather than the same one
 * with a flag: a public link must not carry members' names and email addresses,
 * or the comment thread, just because those happen to be on the board. What a
 * visitor gets is the work, not the people doing it.
 *
 * No authentication, so nothing here may consult the caller's identity.
 */
export const publicBoards = new Hono().get("/boards/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.uuid().safeParse(id).success) return c.json({ message: "Not a board id" }, 400);

  const [b] = await db
    .select({ id: board.id, title: board.title, visibility: board.visibility })
    .from(board)
    .where(eq(board.id, id))
    .limit(1);

  // A private board and a board that does not exist answer identically, so the
  // endpoint cannot be used to discover which boards are real.
  if (!b || b.visibility !== "public") {
    return c.json({ message: "No public board at that link" }, 404);
  }

  const [lists, cards, labels] = await Promise.all([
    db
      .select({ id: list.id, title: list.title, position: list.position })
      .from(list)
      .where(eq(list.boardId, id))
      .orderBy(asc(list.position)),
    db
      .select({
        id: card.id,
        listId: card.listId,
        position: card.position,
        number: card.number,
        title: card.title,
        descMd: card.descMd,
        dueAt: card.dueAt,
        coverColor: card.coverColor,
      })
      .from(card)
      .where(and(eq(card.boardId, id), isNull(card.archivedAt)))
      .orderBy(asc(card.position)),
    db
      .select({ id: label.id, name: label.name, color: label.color })
      .from(label)
      .where(eq(label.boardId, id))
      .orderBy(asc(label.position)),
  ]);

  const cardIds = cards.map((r) => r.id);
  const [links, checklists] = await Promise.all([
    cardIds.length ? db.select().from(cardLabel).where(inArray(cardLabel.cardId, cardIds)) : [],
    cardIds.length
      ? db.select().from(checklist).where(inArray(checklist.cardId, cardIds))
      : [],
  ]);
  const checklistIds = checklists.map((cl) => cl.id);
  const items = checklistIds.length
    ? await db
        .select({ checklistId: checklistItem.checklistId, done: checklistItem.done })
        .from(checklistItem)
        .where(inArray(checklistItem.checklistId, checklistIds))
    : [];

  const labelsByCard = new Map<string, string[]>();
  for (const l of links) {
    labelsByCard.set(l.cardId, [...(labelsByCard.get(l.cardId) ?? []), l.labelId]);
  }
  const cardOfChecklist = new Map(checklists.map((cl) => [cl.id, cl.cardId]));
  const progress = new Map<string, { done: number; total: number }>();
  for (const it of items) {
    const cardId = cardOfChecklist.get(it.checklistId);
    if (!cardId) continue;
    const p = progress.get(cardId) ?? { done: 0, total: 0 };
    p.total += 1;
    if (it.done) p.done += 1;
    progress.set(cardId, p);
  }

  return c.json({
    id: b.id,
    title: b.title,
    lists,
    labels,
    cards: cards.map((r) => ({
      ...r,
      dueAt: r.dueAt?.toISOString() ?? null,
      labelIds: labelsByCard.get(r.id) ?? [],
      checklist: progress.get(r.id) ?? null,
    })),
  });
});
