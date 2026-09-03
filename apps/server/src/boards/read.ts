import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { BoardState } from "@pergola/shared";
import { runsInstance, type Actor } from "../auth/guard.js";
import { db } from "../db/index.js";
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
  mutation,
  user,
} from "../db/schema.js";

/**
 * A board, whole.
 *
 * The one place the full picture is assembled — the interface loads it, the
 * MCP tools read it — so the two can never disagree about what a board holds.
 * Null for a board that does not exist; authorization is the caller's job.
 */
export async function snapshot(id: string): Promise<BoardState | null> {
  const [b] = await db.select().from(board).where(eq(board.id, id)).limit(1);
  if (!b) return null;

  const [lists, cardRows, labels, fields, members] = await Promise.all([
    db
      .select({
        id: list.id,
        title: list.title,
        position: list.position,
        wipLimit: list.wipLimit,
      })
      .from(list)
      .where(eq(list.boardId, id))
      .orderBy(asc(list.position)),
    db.select().from(card).where(eq(card.boardId, id)).orderBy(asc(card.position)),
    db
      .select({
        id: label.id,
        name: label.name,
        color: label.color,
        position: label.position,
      })
      .from(label)
      .where(eq(label.boardId, id))
      .orderBy(asc(label.position)),
    db
      .select({
        id: customField.id,
        name: customField.name,
        type: customField.type,
        options: customField.options,
        position: customField.position,
      })
      .from(customField)
      .where(eq(customField.boardId, id))
      .orderBy(asc(customField.position)),
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: boardMember.role,
      })
      .from(boardMember)
      .innerJoin(user, eq(user.id, boardMember.userId))
      .where(eq(boardMember.boardId, id)),
  ]);

  const cardIds = cardRows.map((r) => r.id);
  const [labelLinks, assigneeLinks, voteLinks, activity, makers, fieldValues, checklists] =
    await Promise.all([
    cardIds.length
      ? db.select().from(cardLabel).where(inArray(cardLabel.cardId, cardIds))
      : [],
    cardIds.length
      ? db.select().from(cardAssignee).where(inArray(cardAssignee.cardId, cardIds))
      : [],
    cardIds.length ? db.select().from(cardVote).where(inArray(cardVote.cardId, cardIds)) : [],
    /*
     * Last activity per card, straight from the mutation log — no extra column
     * to keep in step, and no write on every touch. This is card aging's input.
     */
    db
      .select({
        cardId: sql<string>`${mutation.payload}->>'cardId'`,
        at: sql<string>`max(${mutation.createdAt})`,
      })
      .from(mutation)
      .where(
        and(eq(mutation.boardId, id), sql`${mutation.payload}->>'cardId' is not null`),
      )
      .groupBy(sql`${mutation.payload}->>'cardId'`),
    /*
     * Who made each card, from the same log: its card.create entry. The name
     * is joined here rather than looked up among the members, because the
     * person who made a card may have left the board since.
     */
    db
      .select({
        cardId: sql<string>`${mutation.payload}->>'cardId'`,
        actorId: mutation.actorId,
        actorName: user.name,
        at: mutation.createdAt,
      })
      .from(mutation)
      .leftJoin(user, eq(user.id, mutation.actorId))
      .where(and(eq(mutation.boardId, id), eq(mutation.kind, "card.create"))),
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
  ]);

  const checklistIds = checklists.map((cl) => cl.id);
  const [items, comments, attachments] = await Promise.all([
    checklistIds.length
      ? db
          .select()
          .from(checklistItem)
          .where(inArray(checklistItem.checklistId, checklistIds))
          .orderBy(asc(checklistItem.position))
      : [],
    cardIds.length
      ? db
          .select()
          .from(comment)
          .where(inArray(comment.cardId, cardIds))
          .orderBy(asc(comment.createdAt))
      : [],
    cardIds.length
      ? db
          .select()
          .from(attachment)
          .where(inArray(attachment.cardId, cardIds))
          .orderBy(asc(attachment.createdAt))
      : [],
  ]);

  const labelsByCard = group(labelLinks, (r) => r.cardId, (r) => r.labelId);
  const assigneesByCard = group(assigneeLinks, (r) => r.cardId, (r) => r.userId);
  const votersByCard = group(voteLinks, (r) => r.cardId, (r) => r.userId);
  const lastActivity = new Map(activity.map((a) => [a.cardId, a.at]));
  const makerOf = new Map(makers.map((m) => [m.cardId, m]));
  const fieldsByCard = new Map<string, Record<string, string>>();
  for (const v of fieldValues) {
    const bag = fieldsByCard.get(v.cardId) ?? {};
    bag[v.fieldId] = v.value;
    fieldsByCard.set(v.cardId, bag);
  }

  const state: BoardState = {
    id: b.id,
    title: b.title,
    seq: b.seq,
    lists,
    labels,
    fields,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      image: m.image,
    })),
    cards: cardRows.map((r) => ({
      id: r.id,
      listId: r.listId,
      position: r.position,
      title: r.title,
      number: r.number,
      descMd: r.descMd,
      startAt: r.startAt?.toISOString() ?? null,
      dueAt: r.dueAt?.toISOString() ?? null,
      coverColor: r.coverColor,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      labelIds: labelsByCard.get(r.id) ?? [],
      assigneeIds: assigneesByCard.get(r.id) ?? [],
      fields: fieldsByCard.get(r.id) ?? {},
      voterIds: votersByCard.get(r.id) ?? [],
      lastActivityAt: lastActivity.get(r.id) ?? r.createdAt.toISOString(),
      createdBy: makerOf.get(r.id)?.actorId ?? null,
      createdByName: makerOf.get(r.id)?.actorName ?? null,
      createdAt: (makerOf.get(r.id)?.at ?? r.createdAt).toISOString(),
    })),
    checklists: checklists.map((cl) => ({
      id: cl.id,
      cardId: cl.cardId,
      title: cl.title,
      position: cl.position,
    })),
    items: items.map((i) => ({
      id: i.id,
      checklistId: i.checklistId,
      text: i.text,
      done: i.done,
      dueAt: i.dueAt?.toISOString() ?? null,
      assigneeId: i.assigneeId,
      position: i.position,
    })),
    attachments: attachments.map((a) => ({
      id: a.id,
      cardId: a.cardId,
      url: a.url,
      name: a.name,
      addedBy: a.addedBy,
      createdAt: a.createdAt.toISOString(),
    })),
    comments: comments.map((m) => ({
      id: m.id,
      cardId: m.cardId,
      authorId: m.authorId,
      body: m.body,
      parentId: m.parentId,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
    })),
  };

  return state;
}

export function group<T, K, V>(rows: T[], key: (r: T) => K, val: (r: T) => V): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(val(r));
    else out.set(k, [val(r)]);
  }
  return out;
}

/** One row of the board list: what the home page and the MCP tools are built from. */
export type BoardSummary = {
  id: string;
  title: string;
  seq: number;
  /** Membership role, or admin by virtue of running the instance — see roleOn(). */
  role: string;
  /** False on a board this person can open only because they run the instance. */
  member: boolean;
  createdBy: string | null;
  createdAt: string;
  memberCount: number;
  cardCount: number;
};

/**
 * The boards this person can open.
 *
 * For a member, the boards they belong to. For whoever runs the instance,
 * every board on it — `member` says which of those they actually sit on.
 */
export async function boardsFor(actor: Actor): Promise<BoardSummary[]> {
  const maker = alias(user, "maker");
  const rows = await db
    .select({
      id: board.id,
      title: board.title,
      seq: board.seq,
      role: sql<string>`coalesce(${boardMember.role}, 'admin')`,
      member: sql<boolean>`(${boardMember.userId} is not null)`,
      // Who started it. A left join: a board can outlive the account that did.
      createdBy: maker.name,
      createdAt: board.createdAt,
      memberCount: sql<number>`(
        select count(*)::int from board_member bm where bm.board_id = ${board.id}
      )`,
      cardCount: sql<number>`(
        select count(*)::int from card ca
        where ca.board_id = ${board.id} and ca.archived_at is null
      )`,
    })
    .from(board)
    .leftJoin(
      boardMember,
      and(eq(boardMember.boardId, board.id), eq(boardMember.userId, actor.id)),
    )
    .leftJoin(maker, eq(maker.id, board.createdBy))
    .where(runsInstance(actor.role) ? undefined : isNotNull(boardMember.userId))
    .orderBy(asc(board.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export type SearchHit = {
  cardId: string;
  number: number;
  title: string;
  archived: boolean;
  boardId: string;
  boardTitle: string;
  listTitle: string;
  rank: number;
};

/**
 * Search every board this person belongs to.
 *
 * Postgres does the ranking against the generated tsvector column, so there is
 * no second search service to run, keep in sync, or explain to a self-hoster.
 *
 * Prefix matching, not whole-word: people type "ind" expecting "indexing", and
 * `websearch_to_tsquery` would find nothing until the word is complete.
 * Stripping to letters and digits also means the query can never carry
 * tsquery operators of its own.
 */
export async function searchCards(actor: Actor, q: string, boardId?: string): Promise<SearchHit[]> {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .slice(0, 8);
  if (q.trim().length < 2 || terms.length === 0) return [];
  const query = sql`to_tsquery('simple', ${terms.map((t) => `${t}:*`).join(" & ")})`;
  const rows = await db
    .select({
      cardId: card.id,
      number: card.number,
      title: card.title,
      archivedAt: card.archivedAt,
      boardId: board.id,
      boardTitle: board.title,
      listTitle: list.title,
      rank: sql<number>`ts_rank(${card.search}, ${query})`,
    })
    .from(card)
    .innerJoin(board, eq(board.id, card.boardId))
    .innerJoin(list, eq(list.id, card.listId))
    .innerJoin(boardMember, eq(boardMember.boardId, card.boardId))
    .where(
      and(
        eq(boardMember.userId, actor.id),
        sql`${card.search} @@ ${query}`,
        boardId ? eq(card.boardId, boardId) : undefined,
      ),
    )
    .orderBy(sql`ts_rank(${card.search}, ${query}) DESC`)
    .limit(30);
  return rows.map((r) => ({ ...r, archived: r.archivedAt !== null, archivedAt: undefined }));
}
