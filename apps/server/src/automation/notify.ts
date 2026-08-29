import { and, eq, ne } from "drizzle-orm";
import type { MutationRecord } from "@pergola/shared";
import { db } from "../db/index.js";
import { boardMember, card, notification, user, watch } from "../db/schema.js";

/**
 * In-app notifications.
 *
 * Two rules keep this from becoming noise, which is the only way a notification
 * feature ever fails: you are never told about your own actions, and you only
 * hear about cards you have some stake in — ones you were assigned, commented
 * on, or were named in.
 */

/** @mentions, matched against display names and the local part of an email. */
const MENTION = /@([\w][\w.-]{1,63})/g;

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
    kind: "mention" | "assigned" | "commented" | "moved" | "due";
    body: string;
    actorId: string | null;
  },
): Promise<void> {
  const unique = [...new Set(userIds)].filter((id) => id !== row.actorId);
  if (unique.length === 0) return;
  await db.insert(notification).values(unique.map((userId) => ({ userId, ...row })));
}

/**
 * Resolve @names to accounts on THIS board.
 *
 * Scoped to the board's membership, not the instance. Matching against every
 * account meant "@alice" on a private board notified any Alice anywhere, handing
 * a stranger the card's title — and doubling as a way to test whether a given
 * name or address has an account here.
 */
async function resolveMentions(body: string, boardId: string): Promise<string[]> {
  const handles = [...body.matchAll(MENTION)].map((m) => m[1]!.toLowerCase());
  if (handles.length === 0) return [];
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .innerJoin(boardMember, eq(boardMember.userId, user.id))
    .where(eq(boardMember.boardId, boardId));
  return people
    .filter((p) => {
      const local = p.email.split("@")[0]?.toLowerCase() ?? "";
      const handle = p.name.replace(/\s+/g, "").toLowerCase();
      return handles.includes(local) || handles.includes(handle);
    })
    .map((p) => p.id);
}

const titleOf = async (cardId: string): Promise<string> => {
  const [row] = await db.select({ title: card.title }).from(card).where(eq(card.id, cardId)).limit(1);
  return row?.title ?? "a card";
};

/** Called after a mutation commits. Never throws into the caller's path. */
export async function notifyFor(record: MutationRecord): Promise<void> {
  const b = record.body;
  const actor = record.actorId;

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
