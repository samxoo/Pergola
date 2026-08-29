import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  attachment,
  board,
  boardMember,
  card,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  customField,
  customFieldValue,
  label,
  list,
  user,
} from "../db/schema.js";

/**
 * Export and re-import, in Pergola's own shape.
 *
 * A self-hosted tool that promises "your data" has to mean it, and an importer
 * without an exporter is a one-way door. This is deliberately lossless enough to
 * round-trip: export a board, import it, and you have the same board.
 *
 * What is *not* carried, and why:
 *   - people          Accounts belong to an instance. Comments keep the author's
 *                     name as text so the record survives; assignees do not,
 *                     because inventing a mapping would attribute work wrongly.
 *   - the mutation log History belongs to the instance that lived it. A copy
 *                     starts its own log rather than claiming someone else's.
 */
export const FORMAT = "pergola.board/1";

const Id = z.string().min(1);

export const PergolaExport = z.object({
  format: z.literal(FORMAT),
  exportedAt: z.string(),
  board: z.object({ title: z.string().min(1).max(200) }),
  labels: z
    .array(z.object({ id: Id, name: z.string(), color: z.string(), position: z.string() }))
    .max(200),
  fields: z.array(
    z.object({
      id: Id,
      name: z.string(),
      type: z.enum(["text", "number", "date", "select", "checkbox"]),
      options: z.array(z.string()),
      position: z.string(),
    }),
  ).max(200),
  lists: z.array(
    z.object({
      id: Id,
      title: z.string(),
      position: z.string(),
      wipLimit: z.number().int().nullable(),
    }),
  ),
  cards: z.array(
    z.object({
      id: Id,
      listId: Id,
      position: z.string(),
      number: z.number().int(),
      title: z.string(),
      descMd: z.string().nullable(),
      startAt: z.string().nullable(),
      dueAt: z.string().nullable(),
      coverColor: z.string().nullable(),
      archived: z.boolean(),
      labelIds: z.array(Id),
      fields: z.record(Id, z.string()),
    }),
  ),
  checklists: z
    .array(z.object({ id: Id, cardId: Id, title: z.string(), position: z.string() }))
    .max(20_000),
  items: z.array(
    z.object({
      id: Id,
      checklistId: Id,
      text: z.string(),
      done: z.boolean(),
      position: z.string(),
    }),
  ),
  attachments: z
    .array(
      z.object({
        id: Id,
        cardId: Id,
        // The same check the mutation path applies. An imported file is no more
        // trusted than a typed one, and this ends up in an href.
        url: z
          .string()
          .max(2000)
          .refine((u) => /^https?:\/\//i.test(u), "Only http and https links can be attached"),
        name: z.string(),
      }),
    )
    .max(20_000),
  comments: z.array(
    z.object({
      id: Id,
      cardId: Id,
      /** The author's display name at export time, not an account reference. */
      authorName: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type PergolaExport = z.infer<typeof PergolaExport>;

/* ------------------------------------------------------------------ export */

export async function exportBoard(boardId: string): Promise<PergolaExport> {
  const [b] = await db.select().from(board).where(eq(board.id, boardId)).limit(1);
  if (!b) throw new Error("No such board");

  const [lists, cards, labels, fields] = await Promise.all([
    db.select().from(list).where(eq(list.boardId, boardId)).orderBy(asc(list.position)),
    db.select().from(card).where(eq(card.boardId, boardId)).orderBy(asc(card.position)),
    db.select().from(label).where(eq(label.boardId, boardId)).orderBy(asc(label.position)),
    db
      .select()
      .from(customField)
      .where(eq(customField.boardId, boardId))
      .orderBy(asc(customField.position)),
  ]);

  const cardIds = cards.map((c) => c.id);
  const [labelLinks, fieldValues, checklists, attachments] = await Promise.all([
    cardIds.length ? db.select().from(cardLabel).where(inArray(cardLabel.cardId, cardIds)) : [],
    cardIds.length
      ? db.select().from(customFieldValue).where(inArray(customFieldValue.cardId, cardIds))
      : [],
    cardIds.length
      ? db
          .select()
          .from(checklist)
          .where(inArray(checklist.cardId, cardIds))
          .orderBy(asc(checklist.position))
      : [],
    cardIds.length
      ? db.select().from(attachment).where(inArray(attachment.cardId, cardIds))
      : [],
  ]);

  const checklistIds = checklists.map((c) => c.id);
  const [items, comments] = await Promise.all([
    checklistIds.length
      ? db
          .select()
          .from(checklistItem)
          .where(inArray(checklistItem.checklistId, checklistIds))
          .orderBy(asc(checklistItem.position))
      : [],
    cardIds.length
      ? db
          .select({
            id: comment.id,
            cardId: comment.cardId,
            body: comment.body,
            createdAt: comment.createdAt,
            // The name, not the id: an account reference means nothing on
            // whatever instance this export is opened on.
            authorName: user.name,
          })
          .from(comment)
          .innerJoin(user, eq(user.id, comment.authorId))
          .where(inArray(comment.cardId, cardIds))
          .orderBy(asc(comment.createdAt))
      : [],
  ]);

  const labelsFor = new Map<string, string[]>();
  for (const l of labelLinks) {
    labelsFor.set(l.cardId, [...(labelsFor.get(l.cardId) ?? []), l.labelId]);
  }
  const fieldsFor = new Map<string, Record<string, string>>();
  for (const v of fieldValues) {
    fieldsFor.set(v.cardId, { ...(fieldsFor.get(v.cardId) ?? {}), [v.fieldId]: v.value });
  }

  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    board: { title: b.title },
    labels: labels.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      position: l.position,
    })),
    fields: fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      options: f.options,
      position: f.position,
    })),
    lists: lists.map((l) => ({
      id: l.id,
      title: l.title,
      position: l.position,
      wipLimit: l.wipLimit,
    })),
    cards: cards.map((c) => ({
      id: c.id,
      listId: c.listId,
      position: c.position,
      number: c.number,
      title: c.title,
      descMd: c.descMd,
      startAt: c.startAt?.toISOString() ?? null,
      dueAt: c.dueAt?.toISOString() ?? null,
      coverColor: c.coverColor,
      archived: c.archivedAt !== null,
      labelIds: labelsFor.get(c.id) ?? [],
      fields: fieldsFor.get(c.id) ?? {},
    })),
    checklists: checklists.map((c) => ({
      id: c.id,
      cardId: c.cardId,
      title: c.title,
      position: c.position,
    })),
    items: items.map((i) => ({
      id: i.id,
      checklistId: i.checklistId,
      text: i.text,
      done: i.done,
      position: i.position,
    })),
    attachments: attachments.map((a) => ({
      id: a.id,
      cardId: a.cardId,
      url: a.url,
      name: a.name,
    })),
    comments: comments.map((m) => ({
      id: m.id,
      cardId: m.cardId,
      authorName: m.authorName,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ import */

export type ImportResult = {
  boardId: string;
  title: string;
  counts: Record<string, number>;
};

/**
 * Rebuild a board from an export.
 *
 * Ids are regenerated rather than reused: the same board can be imported twice
 * into one instance, and an id from somewhere else must never collide with one
 * already here. The export's ids are used only to rejoin its own rows.
 */
export async function importPergola(
  data: PergolaExport,
  ownerId: string,
  title?: string,
): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const [b] = await tx
      .insert(board)
      .values({ title: title?.trim() || data.board.title })
      .returning();
    const boardId = b!.id;
    await tx.insert(boardMember).values({ boardId, userId: ownerId, role: "admin" });

    const labelMap = new Map<string, string>();
    for (const l of data.labels) {
      const [row] = await tx
        .insert(label)
        .values({ boardId, name: l.name, color: l.color, position: l.position })
        .returning({ id: label.id });
      labelMap.set(l.id, row!.id);
    }

    const fieldMap = new Map<string, string>();
    for (const f of data.fields) {
      const [row] = await tx
        .insert(customField)
        .values({
          boardId,
          name: f.name,
          type: f.type,
          options: f.options,
          position: f.position,
        })
        .returning({ id: customField.id });
      fieldMap.set(f.id, row!.id);
    }

    const listMap = new Map<string, string>();
    for (const l of data.lists) {
      const [row] = await tx
        .insert(list)
        .values({ boardId, title: l.title, position: l.position, wipLimit: l.wipLimit })
        .returning({ id: list.id });
      listMap.set(l.id, row!.id);
    }

    const cardMap = new Map<string, string>();
    let highest = 0;
    for (const c of data.cards) {
      const listId = listMap.get(c.listId);
      if (!listId) continue;
      highest = Math.max(highest, c.number);
      const [row] = await tx
        .insert(card)
        .values({
          boardId,
          listId,
          position: c.position,
          number: c.number,
          title: c.title,
          descMd: c.descMd,
          startAt: c.startAt ? new Date(c.startAt) : null,
          dueAt: c.dueAt ? new Date(c.dueAt) : null,
          coverColor: c.coverColor,
          archivedAt: c.archived ? new Date() : null,
        })
        .returning({ id: card.id });
      cardMap.set(c.id, row!.id);

      for (const oldId of c.labelIds) {
        const labelId = labelMap.get(oldId);
        if (labelId) {
          await tx.insert(cardLabel).values({ cardId: row!.id, labelId }).onConflictDoNothing();
        }
      }
      for (const [oldFieldId, value] of Object.entries(c.fields)) {
        const fieldId = fieldMap.get(oldFieldId);
        if (fieldId) {
          await tx
            .insert(customFieldValue)
            .values({ cardId: row!.id, fieldId, value })
            .onConflictDoNothing();
        }
      }
    }
    // Card numbers are preserved, so the counter has to resume above them.
    await tx.update(board).set({ cardSeq: highest }).where(eq(board.id, boardId));

    const checklistMap = new Map<string, string>();
    for (const cl of data.checklists) {
      const cardId = cardMap.get(cl.cardId);
      if (!cardId) continue;
      const [row] = await tx
        .insert(checklist)
        .values({ cardId, title: cl.title, position: cl.position })
        .returning({ id: checklist.id });
      checklistMap.set(cl.id, row!.id);
    }

    for (const it of data.items) {
      const checklistId = checklistMap.get(it.checklistId);
      if (!checklistId) continue;
      await tx
        .insert(checklistItem)
        .values({ checklistId, text: it.text, done: it.done, position: it.position });
    }

    for (const a of data.attachments) {
      const cardId = cardMap.get(a.cardId);
      if (!cardId) continue;
      await tx.insert(attachment).values({ cardId, url: a.url, name: a.name, addedBy: ownerId });
    }

    for (const m of data.comments) {
      const cardId = cardMap.get(m.cardId);
      if (!cardId) continue;
      // The original author has no account here, so their name is kept in the
      // text rather than the comment being quietly reattributed to the importer.
      await tx.insert(comment).values({
        cardId,
        authorId: ownerId,
        body: `**${m.authorName}** wrote:\n\n${m.body}`,
        createdAt: new Date(m.createdAt),
      });
    }

    return {
      boardId,
      title: title?.trim() || data.board.title,
      counts: {
        lists: data.lists.length,
        cards: data.cards.filter((c) => !c.archived).length,
        archived: data.cards.filter((c) => c.archived).length,
        labels: data.labels.length,
        fields: data.fields.length,
        checklists: data.checklists.length,
        items: data.items.length,
        attachments: data.attachments.length,
        comments: data.comments.length,
      },
    };
  });
}
