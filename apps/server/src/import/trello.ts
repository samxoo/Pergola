import { eq } from "drizzle-orm";
import { atEnd } from "@pergola/shared";
import { db } from "../db/index.js";
import {
  board,
  boardMember,
  card,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list,
} from "../db/schema.js";

export { TrelloExport } from "./formats.js";
import { TrelloExport } from "./formats.js";

/** Trello has ten label colours and shades of them; we have six. */
const COLOR_MAP: Record<string, string> = {
  green: "green", green_dark: "green", green_light: "green", lime: "green", lime_dark: "green",
  yellow: "yellow", yellow_dark: "yellow", yellow_light: "yellow",
  orange: "orange", orange_dark: "orange", orange_light: "orange",
  red: "red", red_dark: "red", red_light: "red", pink: "red", pink_dark: "red",
  purple: "purple", purple_dark: "purple", purple_light: "purple",
  blue: "blue", blue_dark: "blue", blue_light: "blue",
  sky: "blue", sky_dark: "blue", navy: "blue", black: "purple",
};
const mapColor = (c: string | null) => (c ? (COLOR_MAP[c] ?? "blue") : "blue");

const byPos = <T extends { pos: number }>(a: T, b: T) => a.pos - b.pos;
const date = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

export type ImportResult = {
  boardId: string;
  title: string;
  counts: {
    lists: number;
    /** Cards placed on the board. */
    cards: number;
    /** Cards Trello had closed, imported straight into the archive. */
    archived: number;
    labels: number;
    checklists: number;
    comments: number;
  };
  skipped: string[];
};

/**
 * Build a whole board in one transaction.
 *
 * This is the one write that does not go through the mutation log, for the same
 * reason board creation does not: the board does not exist yet, so there is no
 * sequence to advance and nobody subscribed to notify. Every change *after* the
 * import goes through the log as normal, and the board's history starts here.
 */
export async function importTrello(
  data: TrelloExport,
  ownerId: string,
): Promise<ImportResult> {
  const skipped: string[] = [];

  const openLists = data.lists.filter((l) => !l.closed).sort(byPos);
  const closedLists = data.lists.filter((l) => l.closed);
  if (closedLists.length) {
    skipped.push(`${closedLists.length} archived list(s) and their cards`);
  }
  const keptListIds = new Set(openLists.map((l) => l.id));

  return db.transaction(async (tx) => {
    const [b] = await tx.insert(board).values({ title: data.name, createdBy: ownerId }).returning();
    const boardId = b!.id;
    await tx.insert(boardMember).values({ boardId, userId: ownerId, role: "admin" });

    // ---- labels ----
    const labelIdByTrello = new Map<string, string>();
    let lpos: string | null = null;
    for (const tl of data.labels) {
      lpos = atEnd(lpos);
      const [row] = await tx
        .insert(label)
        .values({ boardId, name: tl.name, color: mapColor(tl.color), position: lpos })
        .returning({ id: label.id });
      labelIdByTrello.set(tl.id, row!.id);
    }

    // ---- lists ----
    const listIdByTrello = new Map<string, string>();
    let listPos: string | null = null;
    for (const tl of openLists) {
      listPos = atEnd(listPos);
      const [row] = await tx
        .insert(list)
        .values({ boardId, title: tl.name, position: listPos })
        .returning({ id: list.id });
      listIdByTrello.set(tl.id, row!.id);
    }

    // ---- cards ----
    const cardIdByTrello = new Map<string, string>();
    const posByList = new Map<string, string | null>();
    let number = 0;
    const cards = data.cards.filter((c) => keptListIds.has(c.idList)).sort(byPos);

    for (const tc of cards) {
      const listId = listIdByTrello.get(tc.idList);
      if (!listId) continue;
      const prev = posByList.get(listId) ?? null;
      const position = atEnd(prev);
      posByList.set(listId, position);
      number += 1;

      const [row] = await tx
        .insert(card)
        .values({
          boardId,
          listId,
          position,
          number,
          title: tc.name,
          descMd: tc.desc || null,
          dueAt: date(tc.due),
          startAt: date(tc.start),
          // A card Trello calls "closed" is archived here, not deleted.
          archivedAt: tc.closed ? new Date() : null,
        })
        .returning({ id: card.id });
      cardIdByTrello.set(tc.id, row!.id);

      for (const tlId of tc.idLabels) {
        const labelId = labelIdByTrello.get(tlId);
        if (labelId) {
          await tx.insert(cardLabel).values({ cardId: row!.id, labelId }).onConflictDoNothing();
        }
      }
    }

    await tx.update(board).set({ cardSeq: number }).where(eq(board.id, boardId));

    // ---- checklists ----
    let checklistCount = 0;
    const posByCard = new Map<string, string | null>();
    for (const tcl of data.checklists.sort(byPos)) {
      const cardId = cardIdByTrello.get(tcl.idCard);
      if (!cardId) continue;
      const prev = posByCard.get(cardId) ?? null;
      const position = atEnd(prev);
      posByCard.set(cardId, position);

      const [row] = await tx
        .insert(checklist)
        .values({ cardId, title: tcl.name, position })
        .returning({ id: checklist.id });
      checklistCount += 1;

      let ipos: string | null = null;
      for (const ci of tcl.checkItems.sort(byPos)) {
        ipos = atEnd(ipos);
        await tx.insert(checklistItem).values({
          checklistId: row!.id,
          text: ci.name,
          done: ci.state === "complete",
          position: ipos,
        });
      }
    }

    // ---- comments ----
    let commentCount = 0;
    for (const action of data.actions) {
      if (action.type !== "commentCard") continue;
      const trelloCardId = action.data?.card?.id;
      const text = action.data?.text;
      if (!trelloCardId || !text) continue;
      const cardId = cardIdByTrello.get(trelloCardId);
      if (!cardId) continue;

      // Their Trello teammates have no account here, so authorship cannot be
      // preserved. Saying who wrote it in the text is honest; silently
      // reattributing it to the importer is not.
      const who = action.memberCreator?.fullName;
      await tx.insert(comment).values({
        cardId,
        authorId: ownerId,
        body: who ? `**${who}** wrote on Trello:\n\n${text}` : text,
        createdAt: date(action.date ?? null) ?? new Date(),
      });
      commentCount += 1;
    }

    if (data.actions.some((a) => a.type === "commentCard")) {
      skipped.push("comment authorship — Trello members have no account here");
    }
    if (cards.some((c) => c.closed)) {
      skipped.push("archived cards were imported into the archive, not the board");
    }

    return {
      boardId,
      title: data.name,
      counts: {
        lists: openLists.length,
        cards: cards.filter((c) => !c.closed).length,
        archived: cards.filter((c) => c.closed).length,
        labels: data.labels.length,
        checklists: checklistCount,
        comments: commentCount,
      },
      skipped,
    };
  });
}
