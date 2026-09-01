import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import { MutationEnvelope, atEnd, type BoardState } from "@pergola/shared";
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
  rule,
  user,
} from "../db/schema.js";
import { exportBoard, importPergola, PergolaExport } from "../import/pergola.js";
import { importTrello, TrelloExport } from "../import/trello.js";
import { commitAndDispatch } from "../automation/dispatch.js";
import { since } from "../mutations/commit.js";
import { Stale } from "../mutations/handlers.js";
import {
  actorOf,
  authorizeRead,
  authorizeWrite,
  Forbidden,
  requireUser,
  type Env,
} from "../auth/guard.js";

/** The six a board starts with, so labelling works before anyone configures it. */
const STARTER_LABELS = ["green", "yellow", "orange", "red", "purple", "blue"];

export const boards = new Hono<Env>()
  .use("*", requireUser)

  /*
   * Reject a malformed board id before it reaches Postgres.
   *
   * Otherwise every route taking :id turns a typo into a 500 and a stack trace,
   * which buries the real faults among the noise.
   */
  .use("/boards/:id/*", async (c, next) => {
    if (!z.uuid().safeParse(c.req.param("id")).success) {
      return c.json({ message: "Not a board id" }, 400);
    }
    await next();
  })

  /** Only boards this person belongs to. There is no "all boards" view. */
  .get("/boards", async (c) => {
    const maker = alias(user, "maker");
    const rows = await db
      .select({
        id: board.id,
        title: board.title,
        seq: board.seq,
        role: boardMember.role,
        // Who started it. A left join: a board can outlive the account that did.
        createdBy: maker.name,
        createdAt: board.createdAt,
      })
      .from(board)
      .innerJoin(boardMember, eq(boardMember.boardId, board.id))
      .leftJoin(maker, eq(maker.id, board.createdBy))
      .where(eq(boardMember.userId, actorOf(c).id))
      .orderBy(asc(board.createdAt));
    return c.json(
      rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    );
  })

  .post(
    "/boards",
    zValidator("json", z.object({ title: z.string().min(1).max(200) })),
    async (c) => {
      const { title } = c.req.valid("json");
      const actor = actorOf(c);

      const created = await db.transaction(async (tx) => {
        const [b] = await tx.insert(board).values({ title, createdBy: actor.id }).returning();
        // Whoever makes a board administers it.
        await tx.insert(boardMember).values({
          boardId: b!.id,
          userId: actor.id,
          role: "admin",
        });
        // A board with no lists is a dead end, so start it the way people expect.
        let pos: string | null = null;
        for (const name of ["To do", "Doing", "Done"]) {
          pos = atEnd(pos);
          await tx.insert(list).values({ boardId: b!.id, title: name, position: pos });
        }
        let lpos: string | null = null;
        for (const color of STARTER_LABELS) {
          lpos = atEnd(lpos);
          await tx.insert(label).values({ boardId: b!.id, name: "", color, position: lpos });
        }
        return b!;
      });

      return c.json({ id: created.id, title: created.title, seq: created.seq }, 201);
    },
  )

  /** Full snapshot plus the cursor it reflects. The client syncs forward from here. */
  .get("/boards/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json({ message: "Not a board id" }, 400);
    await authorizeRead(id, actorOf(c));

    const [b] = await db.select().from(board).where(eq(board.id, id)).limit(1);
    if (!b) return c.json({ message: "No such board" }, 404);

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
    const [labelLinks, assigneeLinks, voteLinks, activity, fieldValues, checklists] =
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

    return c.json(state);
  })

  /**
   * Duplicate a board — the template mechanism.
   *
   * A separate "template" entity would be a second thing to keep in sync with
   * boards forever. A board you can copy is the same feature with none of that:
   * make one, call it "Sprint template", copy it every fortnight.
   */
  .post(
    "/boards/:id/duplicate",
    zValidator("json", z.object({
      title: z.string().min(1).max(200),
      withCards: z.boolean().default(false),
    })),
    async (c) => {
      const sourceId = c.req.param("id");
      await authorizeRead(sourceId, actorOf(c));
      const { title, withCards } = c.req.valid("json");
      const actor = actorOf(c);

      const created = await db.transaction(async (tx) => {
        const [b] = await tx.insert(board).values({ title, createdBy: actor.id }).returning();
        const boardId = b!.id;
        await tx.insert(boardMember).values({ boardId, userId: actor.id, role: "admin" });

        const [srcLists, srcLabels, srcFields] = await Promise.all([
          tx.select().from(list).where(eq(list.boardId, sourceId)).orderBy(asc(list.position)),
          tx.select().from(label).where(eq(label.boardId, sourceId)).orderBy(asc(label.position)),
          tx
            .select()
            .from(customField)
            .where(eq(customField.boardId, sourceId))
            .orderBy(asc(customField.position)),
        ]);

        const labelMap = new Map<string, string>();
        for (const l of srcLabels) {
          const [row] = await tx
            .insert(label)
            .values({ boardId, name: l.name, color: l.color, position: l.position })
            .returning({ id: label.id });
          labelMap.set(l.id, row!.id);
        }
        for (const f of srcFields) {
          await tx.insert(customField).values({
            boardId,
            name: f.name,
            type: f.type,
            options: f.options,
            position: f.position,
          });
        }

        const listMap = new Map<string, string>();
        for (const l of srcLists) {
          const [row] = await tx
            .insert(list)
            .values({ boardId, title: l.title, position: l.position, wipLimit: l.wipLimit })
            .returning({ id: list.id });
          listMap.set(l.id, row!.id);
        }

        let cards = 0;
        if (withCards) {
          // Archived cards are history, not structure — a copy starts clean.
          const srcCards = await tx
            .select()
            .from(card)
            .where(and(eq(card.boardId, sourceId), isNull(card.archivedAt)))
            .orderBy(asc(card.position));
          const srcLabelLinks = srcCards.length
            ? await tx
                .select()
                .from(cardLabel)
                .where(inArray(cardLabel.cardId, srcCards.map((x) => x.id)))
            : [];
          const linksByCard = group(srcLabelLinks, (r) => r.cardId, (r) => r.labelId);

          for (const sc of srcCards) {
            const listId = listMap.get(sc.listId);
            if (!listId) continue;
            cards += 1;
            const [row] = await tx
              .insert(card)
              .values({
                boardId,
                listId,
                position: sc.position,
                number: cards,
                title: sc.title,
                descMd: sc.descMd,
                // Dates and people belong to the original run of work, not the copy.
              })
              .returning({ id: card.id });
            for (const oldLabelId of linksByCard.get(sc.id) ?? []) {
              const newLabelId = labelMap.get(oldLabelId);
              if (newLabelId) {
                await tx
                  .insert(cardLabel)
                  .values({ cardId: row!.id, labelId: newLabelId })
                  .onConflictDoNothing();
              }
            }
          }
          await tx.update(board).set({ cardSeq: cards }).where(eq(board.id, boardId));
        }

        return { id: boardId, title, lists: srcLists.length, labels: srcLabels.length, cards };
      });

      return c.json(created, 201);
    },
  )

  /** Who is on this board. Admins only — membership is not public. */
  .post(
    "/boards/:id/members",
    zValidator("json", z.object({
      userId: z.string().min(1),
      role: z.enum(["admin", "member", "observer"]).default("member"),
    })),
    async (c) => {
      const boardId = c.req.param("id");
      const role = await authorizeRead(boardId, actorOf(c));
      if (role !== "admin") return c.json({ message: "Only an admin can invite people" }, 403);

      const { userId, role: newRole } = c.req.valid("json");
      const [exists] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
      if (!exists) return c.json({ message: "No such person" }, 404);

      /*
       * The same last-admin rule the removal route enforces.
       *
       * This route can also demote, and an admin demoting themselves leaves a
       * board nobody can administer: no invites, no rules, no structural edits,
       * and no way back.
       */
      if (newRole !== "admin") {
        const admins = await db
          .select({ userId: boardMember.userId })
          .from(boardMember)
          .where(and(eq(boardMember.boardId, boardId), eq(boardMember.role, "admin")));
        if (admins.length === 1 && admins[0]?.userId === userId) {
          return c.json({ message: "A board needs at least one admin" }, 409);
        }
      }

      await db
        .insert(boardMember)
        .values({ boardId, userId, role: newRole })
        .onConflictDoUpdate({
          target: [boardMember.boardId, boardMember.userId],
          set: { role: newRole },
        });
      return c.json({ userId, role: newRole }, 201);
    },
  )

  .delete("/boards/:id/members/:userId", async (c) => {
    const boardId = c.req.param("id");
    const actor = actorOf(c);
    const role = await authorizeRead(boardId, actor);
    const target = c.req.param("userId");
    // Leaving is always allowed; removing someone else needs admin.
    if (role !== "admin" && target !== actor.id) {
      return c.json({ message: "Only an admin can remove people" }, 403);
    }
    const admins = await db
      .select({ userId: boardMember.userId })
      .from(boardMember)
      .where(and(eq(boardMember.boardId, boardId), eq(boardMember.role, "admin")));
    if (admins.length === 1 && admins[0]?.userId === target) {
      // A board nobody can administer is a board nobody can fix.
      return c.json({ message: "A board needs at least one admin" }, 409);
    }
    await db
      .delete(boardMember)
      .where(and(eq(boardMember.boardId, boardId), eq(boardMember.userId, target)));
    return c.body(null, 204);
  })

  /**
   * Import a Trello board export.
   *
   * Nobody migrates a tool they have to re-key by hand, so this accepts the JSON
   * Trello gives you verbatim and tells you plainly what it could not carry over.
   */
  .post("/import/trello", zValidator("json", TrelloExport), async (c) => {
    const result = await importTrello(c.req.valid("json"), actorOf(c).id);
    return c.json(result, 201);
  })

  /**
   * Take your data with you.
   *
   * An importer without an exporter is a one-way door, which is the opposite of
   * what self-hosting is for. The result re-imports into any Pergola instance.
   */
  .get("/boards/:id/export", async (c) => {
    const boardId = c.req.param("id");
    await authorizeRead(boardId, actorOf(c));
    const data = await exportBoard(boardId);
    const slug = data.board.title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    return c.json(data, 200, {
      "content-disposition": `attachment; filename="${slug || "board"}.pergola.json"`,
    });
  })

  .post(
    "/import/pergola",
    zValidator("json", z.object({ title: z.string().max(200).optional(), data: PergolaExport })),
    async (c) => {
      const { title, data } = c.req.valid("json");
      return c.json(await importPergola(data, actorOf(c).id, title), 201);
    },
  )

  /** Find someone to invite. Exact email only — this is not a user directory. */
  .get("/people", async (c) => {
    const email = (c.req.query("email") ?? "").trim().toLowerCase();
    if (!email) return c.json([]);
    const rows = await db
      .select({ id: user.id, name: user.name, email: user.email, image: user.image })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    return c.json(rows);
  })

  /**
   * Search every board this person belongs to.
   *
   * Postgres does the ranking against the generated tsvector column, so there is
   * no second search service to run, keep in sync, or explain to a self-hoster.
   */
  .get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json([]);

    /*
     * Prefix matching, not whole-word.
     *
     * People type into a palette the way they type into an address bar — "ind"
     * expecting "indexing" — and `websearch_to_tsquery` would find nothing until
     * the word is complete. Stripping to letters and digits also means the query
     * can never carry tsquery operators of its own.
     */
    const terms = q
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 8);
    if (terms.length === 0) return c.json([]);
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
          eq(boardMember.userId, actorOf(c).id),
          sql`${card.search} @@ ${query}`,
        ),
      )
      .orderBy(sql`ts_rank(${card.search}, ${query}) DESC`)
      .limit(30);

    return c.json(
      rows.map((r) => ({ ...r, archived: r.archivedAt !== null, archivedAt: undefined })),
    );
  })

  /**
   * The activity feed.
   *
   * Not a separate table that can disagree with reality — the same mutation log
   * that drives live sync and undo, read backwards and given names. Filtering by
   * card means matching on the payload, which is what the jsonb column is for.
   */
  .get("/boards/:id/activity", async (c) => {
    const boardId = c.req.param("id");
    await authorizeRead(boardId, actorOf(c));
    const cardId = c.req.query("cardId");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);

    const rows = await db
      .select({
        id: mutation.id,
        seq: mutation.seq,
        kind: mutation.kind,
        payload: mutation.payload,
        ruleId: mutation.ruleId,
        createdAt: mutation.createdAt,
        actorId: mutation.actorId,
        actorName: user.name,
        ruleName: rule.name,
      })
      .from(mutation)
      .leftJoin(user, eq(user.id, mutation.actorId))
      .leftJoin(rule, eq(rule.id, mutation.ruleId))
      .where(
        cardId
          ? and(
              eq(mutation.boardId, boardId),
              // Most card mutations name the card directly in the payload.
              sql`${mutation.payload}->>'cardId' = ${cardId}`,
            )
          : eq(mutation.boardId, boardId),
      )
      .orderBy(desc(mutation.seq))
      .limit(limit);

    return c.json(
      rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        body: r.payload,
        actorId: r.actorId,
        actorName: r.actorName,
        ruleName: r.ruleName,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  })

  /** Everything after a cursor. Used by clients that reconnect over plain HTTP. */
  .get("/boards/:id/since/:seq", async (c) => {
    const id = c.req.param("id");
    const seq = Number(c.req.param("seq"));
    if (!Number.isFinite(seq)) return c.json({ message: "Not a sequence number" }, 400);
    await authorizeRead(id, actorOf(c));
    return c.json(await since(id, seq));
  })

  /** The only write endpoint in the application. */
  .post("/mutations", zValidator("json", MutationEnvelope), async (c) => {
    const envelope = c.req.valid("json");
    const actor = actorOf(c);
    try {
      await authorizeWrite(envelope.boardId, actor, envelope.body.kind);
      const record = await commitAndDispatch(envelope, actor.id);
      return c.json(record, 201);
    } catch (err) {
      if (err instanceof Forbidden) return c.json({ message: err.message }, 403);
      // A stale reference means someone else already moved or removed the thing.
      // That is an ordinary race, not a server fault — say so plainly.
      if (err instanceof Stale) return c.json({ message: err.message }, 409);
      throw err;
    }
  });

function group<T, K, V>(rows: T[], key: (r: T) => K, val: (r: T) => V): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(val(r));
    else out.set(k, [val(r)]);
  }
  return out;
}

export type BoardsRoutes = typeof boards;
