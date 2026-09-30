import { and, eq, ne } from "drizzle-orm";
import { handleNames, mentionedHandles, type MutationRecord } from "@pergola/shared";
import { db } from "../db/index.js";
import { board, boardMember, card, notification, user, watch } from "../db/schema.js";
import { background } from "../runtime.js";
import { pushTo } from "./webpush.js";

/**
 * Notifications: the bell in the app, and a push to any device that asked.
 *
 * Two rules keep this from becoming noise, which is the only way a notification
 * feature ever fails: you are never told about your own actions, and what you
 * hear about is either your board growing — a new card on a board you are on —
 * or a card you have some stake in: one you were assigned, commented on, or
 * were named in.
 */

/** Assigning someone, or commenting, subscribes them to the card. */
async function subscribe(userId: string, cardId: string): Promise<void> {
  await db.insert(watch).values({ userId, cardId }).onConflictDoNothing();
}

async function watchersOf(cardId: string, except: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: watch.userId })
    .from(watch)
    .where(
      except
        ? and(eq(watch.cardId, cardId), ne(watch.userId, except))
        : eq(watch.cardId, cardId),
    );
  return rows.map((r) => r.userId);
}

async function push(
  userIds: string[],
  row: {
    boardId: string;
    cardId: string | null;
    kind: "mention" | "assigned" | "commented" | "moved" | "due" | "added";
    body: string;
    actorId: string | null;
  },
): Promise<void> {
  const unique = [...new Set(userIds)].filter((id) => id !== row.actorId);
  if (unique.length === 0) return;
  await db.insert(notification).values(unique.map((userId) => ({ userId, ...row })));

  /*
   * The same words on the lock screen, under the board's name. Sent in the
   * background: a push service taking its time must not hold up the change.
   */
  await background(
    pushTo(unique, async () => {
      const [who] = row.actorId
        ? await db.select({ name: user.name }).from(user).where(eq(user.id, row.actorId)).limit(1)
        : [];
      const [where] = await db
        .select({ title: board.title })
        .from(board)
        .where(eq(board.id, row.boardId))
        .limit(1);
      return {
        title: where?.title ?? "Pergola",
        body: `${who?.name || "Someone"} ${row.body}`,
        url: `/b/${row.boardId}${row.cardId ? `?card=${row.cardId}` : ""}`,
        // A burst of new cards is one notification that keeps updating, not a
        // stack of them; anything about a particular card replaces its own last.
        tag: row.kind === "added" ? `added:${row.boardId}` : `card:${row.cardId ?? row.boardId}`,
      };
    }),
    "notify: web push",
  );
}

/**
 * Resolve @names to accounts on THIS board.
 *
 * Scoped to the board's membership, not the instance. Matching against every
 * account meant "@alice" on a private board notified any Alice anywhere, handing
 * a stranger the card's title — and doubling as a way to test whether a given
 * name or address has an account here.
 *
 * What counts as a handle, and how one names a person, is shared with the web
 * composer so the picker only ever inserts something this will find.
 */
async function resolveMentions(body: string, boardId: string): Promise<string[]> {
  const handles = mentionedHandles(body);
  if (handles.length === 0) return [];
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .innerJoin(boardMember, eq(boardMember.userId, user.id))
    .where(eq(boardMember.boardId, boardId));
  return people.filter((p) => handles.some((h) => handleNames(h, p))).map((p) => p.id);
}

const titleOf = async (cardId: string): Promise<string> => {
  const [row] = await db.select({ title: card.title }).from(card).where(eq(card.id, cardId)).limit(1);
  return row?.title ?? "a card";
};

/** Called after a mutation commits. Never throws into the caller's path. */
export async function notifyFor(record: MutationRecord): Promise<void> {
  const b = record.body;
  const actor = record.actorId;

  // Everyone on the board hears that it grew. Imports do not come through here.
  if (b.kind === "card.create") {
    const members = await db
      .select({ userId: boardMember.userId })
      .from(boardMember)
      .where(eq(boardMember.boardId, record.boardId));
    await push(
      members.map((m) => m.userId),
      {
        boardId: record.boardId,
        cardId: b.cardId,
        kind: "added",
        body: `added “${b.title}”`,
        actorId: actor,
      },
    );
    return;
  }

  if (b.kind === "card.assign" && b.on) {
    await subscribe(b.userId, b.cardId);
    await push([b.userId], {
      boardId: record.boardId,
      cardId: b.cardId,
      kind: "assigned",
      body: `assigned you to “${await titleOf(b.cardId)}”`,
      actorId: actor,
    });
    return;
  }

  if (b.kind === "comment.create") {
    if (actor) await subscribe(actor, b.cardId);
    const title = await titleOf(b.cardId);
    const mentioned = await resolveMentions(b.body, record.boardId);

    if (mentioned.length > 0) {
      await push(mentioned, {
        boardId: record.boardId,
        cardId: b.cardId,
        kind: "mention",
        body: `mentioned you on “${title}”`,
        actorId: actor,
      });
    }
    // Someone named directly gets one notification, not two.
    const others = (await watchersOf(b.cardId, actor)).filter((id) => !mentioned.includes(id));
    await push(others, {
      boardId: record.boardId,
      cardId: b.cardId,
      kind: "commented",
      body: `commented on “${title}”`,
      actorId: actor,
    });
    return;
  }

  if (b.kind === "card.move") {
    const watchers = await watchersOf(b.cardId, actor);
    if (watchers.length === 0) return;
    await push(watchers, {
      boardId: record.boardId,
      cardId: b.cardId,
      kind: "moved",
      body: `moved “${await titleOf(b.cardId)}”`,
      actorId: actor,
    });
  }
}
