import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  atEnd,
  byPosition,
  cardsInList,
  checklistProgress,
  orderedLists,
  positionForIndex,
  type BoardState,
  type Card,
  type MutationBody,
} from "@pergola/shared";
import { commitAndDispatch } from "../automation/dispatch.js";
import {
  authorizeRead,
  authorizeWrite,
  Forbidden,
  runsInstance,
  type Actor,
} from "../auth/guard.js";
import { boardsFor, searchCards, snapshot } from "../boards/read.js";
import { db } from "../db/index.js";
import { board, boardMember, card, cardAssignee, list } from "../db/schema.js";
import { Stale } from "../mutations/handlers.js";

/**
 * Pergola as tools.
 *
 * The rules that shaped this set, from the MCP spec and Anthropic's guidance on
 * tools for agents:
 *
 *   - Few tools, each doing a whole job. `create_card` takes labels, people
 *     and dates in one call rather than making the model chain five.
 *   - Handles people already use. A card is "PRG-12" as readily as an id, a
 *     list is "Done" as readily as an id, a person is "me" or an email.
 *   - Answers carry names, not ids, wherever a name will do; ids ride along
 *     for the next call.
 *   - Every write is one or more ordinary mutations through commit(): logged
 *     under the token owner's name, streamed live, undoable — an assistant's
 *     change is indistinguishable from the person's own.
 *   - Errors say what to do instead, and never leak past the tool result.
 */

const INSTRUCTIONS = `Pergola is a kanban tool: boards hold lists (columns such as "To do", "Doing", "Done") and lists hold cards (tasks). Moving a card between lists is how work progresses.

Start with my_cards for what is assigned to you, or list_boards then get_board. Refer to a card by its key (PRG-12) or its id, to a list by its title or id, and to a person by "me", their email or their name.

You act as the person whose token this is: you see what they see, and every change is recorded under their name, shown to everyone live, and undoable by them. Prefer small, explained changes — leave a comment when you finish something, or when you are blocked.`;

/** A refusal the model can act on. Never thrown past the tool boundary. */
class ToolError extends Error {}

const CARD_KEY = /^(?:PRG-)?(\d{1,9})$/i;

/* --------------------------------------------------------------- shaping -- */

function memberName(state: BoardState, id: string): string {
  const m = state.members.find((x) => x.id === id);
  return m ? m.name || m.email : "someone who has left";
}

function labelName(state: BoardState, id: string): string {
  const l = state.labels.find((x) => x.id === id);
  return l ? l.name || l.color : "?";
}

/** The card as a line in a list: enough to pick it, not the whole thing. */
function summary(state: BoardState, c: Card) {
  const progress = checklistProgress(state, c.id);
  const comments = state.comments.filter((m) => m.cardId === c.id).length;
  return {
    id: c.id,
    key: `PRG-${c.number}`,
    title: c.title,
    list: state.lists.find((l) => l.id === c.listId)?.title ?? null,
    labels: c.labelIds.map((id) => labelName(state, id)),
    assignees: c.assigneeIds.map((id) => memberName(state, id)),
    start: c.startAt,
    due: c.dueAt,
    ...(progress.total > 0 ? { checklist: `${progress.done}/${progress.total}` } : {}),
    ...(comments > 0 ? { comments } : {}),
    ...(c.archivedAt ? { archived: true } : {}),
    last_activity: c.lastActivityAt,
  };
}

/** The whole card, for working on it. */
function detail(state: BoardState, c: Card) {
  const fieldName = (id: string) => state.fields.find((f) => f.id === id)?.name ?? id;
  return {
    ...summary(state, c),
    board: { id: state.id, title: state.title },
    description: c.descMd,
    created_by: c.createdByName,
    created_at: c.createdAt,
    checklists: state.checklists
      .filter((cl) => cl.cardId === c.id)
      .sort(byPosition)
      .map((cl) => ({
        id: cl.id,
        title: cl.title,
        items: state.items
          .filter((i) => i.checklistId === cl.id)
          .sort(byPosition)
          .map((i) => ({ id: i.id, text: i.text, done: i.done, ...(i.dueAt ? { due: i.dueAt } : {}) })),
      })),
    comments: state.comments
      .filter((m) => m.cardId === c.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({
        id: m.id,
        author: memberName(state, m.authorId),
        at: m.createdAt,
        body: m.body,
        ...(m.parentId ? { reply_to: m.parentId } : {}),
      })),
    attachments: state.attachments
      .filter((a) => a.cardId === c.id)
      .map((a) => ({ id: a.id, name: a.name, url: a.url })),
    fields: Object.entries(c.fields).map(([id, value]) => ({ field: fieldName(id), value })),
  };
}

/* ------------------------------------------------------------- resolving -- */

type Found = { boardId: string; cardId: string };

/** A card by id or key. The key is per board, so a board narrows it. */
async function findCard(actor: Actor, ref: string, boardId?: string): Promise<Found> {
  const key = ref.trim();
  if (z.uuid().safeParse(key).success) {
    const [row] = await db
      .select({ id: card.id, boardId: card.boardId })
      .from(card)
      .where(eq(card.id, key))
      .limit(1);
    if (!row) throw new ToolError(`No card has the id ${key}.`);
    await authorizeRead(row.boardId, actor);
    return { boardId: row.boardId, cardId: row.id };
  }

  const m = CARD_KEY.exec(key);
  if (!m) {
    throw new ToolError(`"${ref}" is not a card. Pass its key, such as PRG-12, or its id.`);
  }
  const number = Number(m[1]);
  const where = and(
    eq(card.number, number),
    boardId ? eq(card.boardId, boardId) : undefined,
    runsInstance(actor.role) ? undefined : eq(boardMember.userId, actor.id),
  );
  const rows = runsInstance(actor.role)
    ? await db
        .select({ id: card.id, boardId: card.boardId, boardTitle: board.title })
        .from(card)
        .innerJoin(board, eq(board.id, card.boardId))
        .where(where)
    : await db
        .select({ id: card.id, boardId: card.boardId, boardTitle: board.title })
        .from(card)
        .innerJoin(board, eq(board.id, card.boardId))
        .innerJoin(boardMember, eq(boardMember.boardId, card.boardId))
        .where(where);

  if (rows.length === 0) throw new ToolError(`There is no PRG-${number} on any board you can open.`);
  if (rows.length > 1) {
    const names = rows.map((r) => `"${r.boardTitle}" (${r.boardId})`).join(", ");
    throw new ToolError(
      `PRG-${number} exists on ${rows.length} boards: ${names}. Pass board_id as well, or use the card id.`,
    );
  }
  return { boardId: rows[0]!.boardId, cardId: rows[0]!.id };
}

function findList(state: BoardState, ref: string) {
  const key = ref.trim().toLowerCase();
  const byId = state.lists.find((l) => l.id === key);
  if (byId) return byId;
  const hits = state.lists.filter((l) => l.title.toLowerCase() === key);
  if (hits.length === 1) return hits[0]!;
  const names = orderedLists(state).map((l) => `"${l.title}"`).join(", ");
  if (hits.length > 1) {
    throw new ToolError(`More than one list is called "${ref}". Pass the list id instead; get_board shows them.`);
  }
  throw new ToolError(`No list called "${ref}" on this board. The lists are: ${names}.`);
}

function findMember(state: BoardState, actor: Actor, ref: string) {
  const key = ref.trim().toLowerCase();
  if (key === "me") {
    const me = state.members.find((m) => m.id === actor.id);
    if (!me) throw new ToolError("You are not a member of this board, so you cannot be assigned on it.");
    return me;
  }
  const hit =
    state.members.find((m) => m.id === ref.trim()) ??
    state.members.find((m) => m.email.toLowerCase() === key) ??
    state.members.filter((m) => m.name.toLowerCase() === key)[0];
  if (!hit) {
    const names = state.members.map((m) => `${m.name} <${m.email}>`).join(", ");
    throw new ToolError(`Nobody called "${ref}" is on this board. Members: ${names}.`);
  }
  return hit;
}

function findLabel(state: BoardState, ref: string) {
  const key = ref.trim().toLowerCase();
  const hit =
    state.labels.find((l) => l.id === ref.trim()) ??
    state.labels.find((l) => l.name.toLowerCase() === key) ??
    state.labels.find((l) => !l.name && l.color.toLowerCase() === key);
  if (!hit) {
    const names = state.labels.map((l) => `"${l.name || l.color}"`).join(", ");
    throw new ToolError(`No label "${ref}" on this board. Labels: ${names}.`);
  }
  return hit;
}

/** ISO-8601 with a time, which is what the mutation log stores. "2026-09-30" is taken as midnight UTC. */
function instant(raw: string | null | undefined, what: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim() === "") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ToolError(`"${raw}" is not a date for ${what}. Use ISO-8601, such as 2026-09-30 or 2026-09-30T17:00:00Z.`);
  }
  return d.toISOString();
}

/* --------------------------------------------------------------- writing -- */

/** One change, through the same door as every other. */
async function write(actor: Actor, boardId: string, body: MutationBody) {
  await authorizeWrite(boardId, actor, body.kind);
  return commitAndDispatch({ id: randomUUID(), boardId, body }, actor.id);
}

/* --------------------------------------------------------------- results -- */

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Run a tool, turning anything it throws into feedback the model can use. */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message =
      err instanceof ToolError || err instanceof Forbidden || err instanceof Stale
        ? err.message
        : err instanceof z.ZodError
          ? `Invalid input: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
          : "Something went wrong on the server. Try again, or tell the person you work for.";
    if (!(err instanceof ToolError || err instanceof Forbidden || err instanceof Stale)) {
      console.error("[mcp tool]", err);
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/* ---------------------------------------------------------------- server -- */

const cardRef = z.string().min(1).describe('The card: its key such as "PRG-12", or its id.');
const boardRef = z.uuid().describe("The board id, from list_boards.");
const boardHint = z
  .uuid()
  .optional()
  .describe("Only needed when the same key exists on several of your boards.");
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildServer(actor: Actor): McpServer {
  const server = new McpServer(
    { name: "pergola", title: "Pergola", version: "1.0.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );

  /** A board the actor may read, or a refusal. */
  const open = async (boardId: string): Promise<BoardState> => {
    await authorizeRead(boardId, actor);
    const state = await snapshot(boardId);
    if (!state) throw new ToolError("That board no longer exists.");
    return state;
  };

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description:
        "Every board you can open, with your role on each, and who you are. Start here, or with my_cards.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    () =>
      guarded(async () => {
        const boards = await boardsFor(actor);
        return ok({
          me: { name: actor.name, email: actor.email, instance_role: actor.role },
          boards: boards.map((b) => ({
            id: b.id,
            title: b.title,
            role: b.role,
            ...(b.member ? {} : { note: "not a member; opened by admin right" }),
            cards: b.cardCount,
            members: b.memberCount,
            created_by: b.createdBy,
          })),
        });
      }),
  );

  server.registerTool(
    "my_cards",
    {
      title: "My cards",
      description:
        "Open cards assigned to you, across every board, soonest due first. The place to find out what you are meant to be doing.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    () =>
      guarded(async () => {
        const rows = await db
          .select({
            id: card.id,
            number: card.number,
            title: card.title,
            due: card.dueAt,
            start: card.startAt,
            boardId: board.id,
            board: board.title,
            list: list.title,
          })
          .from(cardAssignee)
          .innerJoin(card, eq(card.id, cardAssignee.cardId))
          .innerJoin(board, eq(board.id, card.boardId))
          .innerJoin(list, eq(list.id, card.listId))
          .where(and(eq(cardAssignee.userId, actor.id), isNull(card.archivedAt)))
          .orderBy(sql`${card.dueAt} asc nulls last`, asc(board.title), asc(card.number));
        return ok({
          cards: rows.map((r) => ({
            id: r.id,
            key: `PRG-${r.number}`,
            title: r.title,
            board: r.board,
            board_id: r.boardId,
            list: r.list,
            due: r.due?.toISOString() ?? null,
            start: r.start?.toISOString() ?? null,
          })),
        });
      }),
  );

  server.registerTool(
    "get_board",
    {
      title: "Read a board",
      description:
        "A board's lists, in order, with the cards in each; plus its labels, members and custom fields. Cards come as one-line summaries — call get_card for the full one. Narrow with `list` on a busy board.",
      inputSchema: z.object({
        board_id: boardRef,
        list: z.string().optional().describe("Only this list, by title or id."),
        assigned_to: z
          .string()
          .optional()
          .describe('Only cards assigned to this person: "me", an email, or a name.'),
        include_archived: z.boolean().default(false),
      }),
      annotations: READ,
    },
    ({ board_id, list: listRef, assigned_to, include_archived }) =>
      guarded(async () => {
        const state = await open(board_id);
        const only = listRef ? findList(state, listRef) : null;
        const person = assigned_to ? findMember(state, actor, assigned_to) : null;
        const lists = orderedLists(state)
          .filter((l) => !only || l.id === only.id)
          .map((l) => {
            const cards = cardsInList(state, l.id)
              .filter((c) => include_archived || !c.archivedAt)
              .filter((c) => !person || c.assigneeIds.includes(person.id));
            return {
              id: l.id,
              title: l.title,
              ...(l.wipLimit !== null ? { wip_limit: l.wipLimit } : {}),
              cards: cards.slice(0, 200).map((c) => summary(state, c)),
              ...(cards.length > 200 ? { truncated: `${cards.length - 200} more; narrow with assigned_to` } : {}),
            };
          });
        return ok({
          board: { id: state.id, title: state.title },
          lists,
          labels: state.labels.map((l) => ({ id: l.id, name: l.name || l.color, color: l.color })),
          members: state.members.map((m) => ({ id: m.id, name: m.name, email: m.email })),
          fields: state.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options })),
        });
      }),
  );

  server.registerTool(
    "get_card",
    {
      title: "Read a card",
      description:
        "Everything on one card: description, checklists with item ids, comments, attachments, fields, who made it.",
      inputSchema: z.object({ card: cardRef, board_id: boardHint }),
      annotations: READ,
    },
    ({ card: ref, board_id }) =>
      guarded(async () => {
        const found = await findCard(actor, ref, board_id);
        const state = await open(found.boardId);
        const c = state.cards.find((x) => x.id === found.cardId)!;
        return ok(detail(state, c));
      }),
  );

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description:
        "Full-text search of card titles and descriptions across the boards you belong to. Words match by prefix.",
      inputSchema: z.object({
        query: z.string().min(2),
        board_id: z.uuid().optional().describe("Restrict to one board."),
      }),
      annotations: READ,
    },
    ({ query, board_id }) =>
      guarded(async () => {
        const hits = await searchCards(actor, query, board_id);
        return ok({
          hits: hits.map((h) => ({
            id: h.cardId,
            key: `PRG-${h.number}`,
            title: h.title,
            board: h.boardTitle,
            board_id: h.boardId,
            list: h.listTitle,
            ...(h.archived ? { archived: true } : {}),
          })),
        });
      }),
  );

  server.registerTool(
    "create_card",
    {
      title: "Create a card",
      description:
        "Add a card to a list, at the bottom. Labels, people and dates can be set in the same call.",
      inputSchema: z.object({
        board_id: boardRef,
        list: z.string().describe("The list to add it to, by title or id."),
        title: z.string().min(1).max(500),
        description: z.string().max(20_000).optional().describe("Markdown."),
        labels: z.array(z.string()).optional().describe("Label names."),
        assignees: z.array(z.string()).optional().describe('"me", emails, or names.'),
        start: z.string().optional().describe("ISO-8601 date or date-time."),
        due: z.string().optional().describe("ISO-8601 date or date-time."),
      }),
      annotations: WRITE,
    },
    (input) =>
      guarded(async () => {
        const state = await open(input.board_id);
        const target = findList(state, input.list);
        const labels = (input.labels ?? []).map((l) => findLabel(state, l));
        const people = (input.assignees ?? []).map((p) => findMember(state, actor, p));
        const start = instant(input.start, "start");
        const due = instant(input.due, "due");

        const cardId = randomUUID();
        await write(actor, state.id, {
          kind: "card.create",
          cardId,
          listId: target.id,
          title: input.title,
          position: atEnd(cardsInList(state, target.id).at(-1)?.position ?? null),
        });
        if (input.description) {
          await write(actor, state.id, { kind: "card.describe", cardId, descMd: input.description });
        }
        for (const l of labels) {
          await write(actor, state.id, { kind: "card.label", cardId, labelId: l.id, on: true });
        }
        for (const p of people) {
          await write(actor, state.id, { kind: "card.assign", cardId, userId: p.id, on: true });
        }
        if (start !== undefined || due !== undefined) {
          await write(actor, state.id, {
            kind: "card.setDates",
            cardId,
            startAt: start ?? null,
            dueAt: due ?? null,
          });
        }
        const after = await open(state.id);
        const c = after.cards.find((x) => x.id === cardId)!;
        return ok(summary(after, c), `Created ${`PRG-${c.number}`} "${c.title}" in "${target.title}".`);
      }),
  );

  server.registerTool(
    "update_card",
    {
      title: "Update a card",
      description:
        "Change a card's title, description, dates, labels or people. Only the fields you pass change. To move it between lists use move_card.",
      inputSchema: z.object({
        card: cardRef,
        board_id: boardHint,
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(20_000).nullable().optional().describe("Markdown; null clears it."),
        start: z.string().nullable().optional().describe("ISO-8601; null clears it."),
        due: z.string().nullable().optional().describe("ISO-8601; null clears it."),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        assign: z.array(z.string()).optional().describe('"me", emails, or names.'),
        unassign: z.array(z.string()).optional(),
      }),
      annotations: WRITE,
    },
    (input) =>
      guarded(async () => {
        const found = await findCard(actor, input.card, input.board_id);
        const state = await open(found.boardId);
        const c = state.cards.find((x) => x.id === found.cardId)!;
        const cardId = c.id;
        let changes = 0;

        if (input.title !== undefined && input.title !== c.title) {
          await write(actor, state.id, { kind: "card.rename", cardId, title: input.title });
          changes++;
        }
        if (input.description !== undefined && input.description !== c.descMd) {
          await write(actor, state.id, { kind: "card.describe", cardId, descMd: input.description });
          changes++;
        }
        const start = instant(input.start, "start");
        const due = instant(input.due, "due");
        if (start !== undefined || due !== undefined) {
          await write(actor, state.id, {
            kind: "card.setDates",
            cardId,
            startAt: start === undefined ? c.startAt : start,
            dueAt: due === undefined ? c.dueAt : due,
          });
          changes++;
        }
        for (const ref of input.add_labels ?? []) {
          const l = findLabel(state, ref);
          if (c.labelIds.includes(l.id)) continue;
          await write(actor, state.id, { kind: "card.label", cardId, labelId: l.id, on: true });
          changes++;
        }
        for (const ref of input.remove_labels ?? []) {
          const l = findLabel(state, ref);
          if (!c.labelIds.includes(l.id)) continue;
          await write(actor, state.id, { kind: "card.label", cardId, labelId: l.id, on: false });
          changes++;
        }
        for (const ref of input.assign ?? []) {
          const p = findMember(state, actor, ref);
          if (c.assigneeIds.includes(p.id)) continue;
          await write(actor, state.id, { kind: "card.assign", cardId, userId: p.id, on: true });
          changes++;
        }
        for (const ref of input.unassign ?? []) {
          const p = findMember(state, actor, ref);
          if (!c.assigneeIds.includes(p.id)) continue;
          await write(actor, state.id, { kind: "card.assign", cardId, userId: p.id, on: false });
          changes++;
        }

        const after = await open(state.id);
        const now = after.cards.find((x) => x.id === cardId)!;
        return ok(
          summary(after, now),
          changes === 0 ? `Nothing to change on PRG-${now.number}.` : `Updated PRG-${now.number} (${changes} change${changes === 1 ? "" : "s"}).`,
        );
      }),
  );

  server.registerTool(
    "move_card",
    {
      title: "Move a card",
      description:
        'Move a card to another list — "Doing" when you start, "Done" when you finish — or reorder it within one. Goes to the bottom unless told otherwise.',
      inputSchema: z.object({
        card: cardRef,
        board_id: boardHint,
        to_list: z.string().describe("The destination list, by title or id."),
        position: z.enum(["top", "bottom"]).default("bottom"),
        after_card: z.string().optional().describe("Place it right after this card (key or id) instead."),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const found = await findCard(actor, input.card, input.board_id);
        const state = await open(found.boardId);
        const c = state.cards.find((x) => x.id === found.cardId)!;
        const target = findList(state, input.to_list);
        const siblings = cardsInList(state, target.id).filter((x) => x.id !== c.id && !x.archivedAt);

        let index = siblings.length;
        if (input.after_card) {
          const anchor = await findCard(actor, input.after_card, state.id);
          const at = siblings.findIndex((x) => x.id === anchor.cardId);
          if (at < 0) throw new ToolError(`The after_card is not in "${target.title}".`);
          index = at + 1;
        } else if (input.position === "top") {
          index = 0;
        }
        const position = positionForIndex(siblings, index, c.id);

        const already =
          c.listId === target.id &&
          cardsInList(state, target.id).filter((x) => !x.archivedAt).findIndex((x) => x.id === c.id) === index;
        if (!already) {
          await write(actor, state.id, { kind: "card.move", cardId: c.id, toListId: target.id, position });
        }
        return ok(
          { id: c.id, key: `PRG-${c.number}`, title: c.title, list: target.title, moved: !already },
          already
            ? `PRG-${c.number} is already there.`
            : `Moved PRG-${c.number} "${c.title}" to "${target.title}".`,
        );
      }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a card",
      description:
        "Post a comment on a card, as the person whose token this is. Say what you did, or what is blocking you.",
      inputSchema: z.object({
        card: cardRef,
        board_id: boardHint,
        body: z.string().min(1).max(10_000).describe("Markdown."),
        reply_to: z.string().uuid().optional().describe("A comment id from get_card, to answer in its thread."),
      }),
      annotations: WRITE,
    },
    (input) =>
      guarded(async () => {
        const found = await findCard(actor, input.card, input.board_id);
        const commentId = randomUUID();
        await write(actor, found.boardId, {
          kind: "comment.create",
          commentId,
          cardId: found.cardId,
          body: input.body,
          parentId: input.reply_to ?? null,
        });
        return ok({ comment_id: commentId, card_id: found.cardId }, "Comment posted.");
      }),
  );

  server.registerTool(
    "add_checklist",
    {
      title: "Add a checklist",
      description: "Add a checklist to a card, with its items. Tick them off later with check_item.",
      inputSchema: z.object({
        card: cardRef,
        board_id: boardHint,
        title: z.string().min(1).max(200).default("Checklist"),
        items: z.array(z.string().min(1).max(500)).default([]),
      }),
      annotations: WRITE,
    },
    (input) =>
      guarded(async () => {
        const found = await findCard(actor, input.card, input.board_id);
        const state = await open(found.boardId);
        const checklistId = randomUUID();
        const last = state.checklists.filter((cl) => cl.cardId === found.cardId).sort(byPosition).at(-1);
        await write(actor, state.id, {
          kind: "checklist.create",
          checklistId,
          cardId: found.cardId,
          title: input.title,
          position: atEnd(last?.position ?? null),
        });
        const items: { id: string; text: string }[] = [];
        let pos: string | null = null;
        for (const text of input.items) {
          const itemId = randomUUID();
          pos = atEnd(pos);
          await write(actor, state.id, { kind: "item.create", itemId, checklistId, text, position: pos });
          items.push({ id: itemId, text });
        }
        return ok(
          { checklist_id: checklistId, title: input.title, items },
          `Added checklist "${input.title}" with ${items.length} item${items.length === 1 ? "" : "s"}.`,
        );
      }),
  );

  server.registerTool(
    "check_item",
    {
      title: "Tick a checklist item",
      description: "Mark a checklist item done, or not done. Item ids come from get_card.",
      inputSchema: z.object({
        item_id: z.uuid(),
        done: z.boolean().default(true),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ item_id, done }) =>
      guarded(async () => {
        const [row] = await db
          .select({ boardId: card.boardId, cardId: card.id, text: sql<string>`ci.text` })
          .from(sql`checklist_item ci`)
          .innerJoin(sql`checklist cl`, sql`cl.id = ci.checklist_id`)
          .innerJoin(card, sql`${card.id} = cl.card_id`)
          .where(sql`ci.id = ${item_id}`)
          .limit(1);
        if (!row) throw new ToolError("No checklist item has that id. Item ids come from get_card.");
        await authorizeRead(row.boardId, actor);
        await write(actor, row.boardId, { kind: "item.toggle", itemId: item_id, done });
        return ok({ item_id, done, card_id: row.cardId }, `${done ? "Ticked" : "Unticked"} "${row.text}".`);
      }),
  );

  server.registerTool(
    "archive_card",
    {
      title: "Archive a card",
      description:
        "Archive a card (or restore one with archived: false). Archived cards leave the board but keep everything; nothing is deleted.",
      inputSchema: z.object({
        card: cardRef,
        board_id: boardHint,
        archived: z.boolean().default(true),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const found = await findCard(actor, input.card, input.board_id);
        await write(actor, found.boardId, { kind: "card.archive", cardId: found.cardId, archived: input.archived });
        return ok({ card_id: found.cardId, archived: input.archived }, input.archived ? "Archived." : "Restored.");
      }),
  );

  return server;
}
