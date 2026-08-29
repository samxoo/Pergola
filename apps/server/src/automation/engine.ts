import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  atEnd,
  type Action,
  type MutationBody,
  type MutationRecord,
  type Trigger,
} from "@pergola/shared";
import { db } from "../db/index.js";
import { card, checklist, checklistItem, comment, list, rule } from "../db/schema.js";

/**
 * The automation engine.
 *
 * A rule turns one mutation into more mutations, and they go through exactly the
 * same write path as a human's — so a rule's work is logged, undoable, streamed
 * to everyone watching, and subject to the same constraints. There is still only
 * one door.
 */

/**
 * Rule-generated mutations do not themselves trigger rules.
 *
 * This is the whole loop-prevention strategy, and it is deliberately blunt: two
 * rules that move a card back and forth would otherwise run until the process
 * died. One hop is enough for every automation anyone actually writes, and
 * "rules react to people, not to each other" is a sentence a user can hold.
 *
 * The mark lives in its own column rather than in actor_id, which is a real
 * foreign key to a real person — the rule still acts *on behalf of* whoever set
 * it off, and the feed can say so.
 */
export function isRuleWork(record: { ruleId: string | null }): boolean {
  return record.ruleId !== null;
}

type Ctx = { boardId: string; cardId: string };

/**
 * Which card a mutation is about.
 *
 * Most carry a `cardId`, but the ones that matter most to automation do not:
 * ticking a checklist item names the *item*, and the rule needs the card two
 * joins away. Getting this wrong is silent — the rule simply never fires.
 */
async function subjectOf(body: MutationBody): Promise<string | null> {
  if ("cardId" in body) return body.cardId;

  if (body.kind === "item.toggle" || body.kind === "item.rename" ||
      body.kind === "item.setDue" || body.kind === "item.move" ||
      body.kind === "item.delete") {
    const [row] = await db
      .select({ cardId: checklist.cardId })
      .from(checklistItem)
      .innerJoin(checklist, eq(checklist.id, checklistItem.checklistId))
      .where(eq(checklistItem.id, body.itemId))
      .limit(1);
    return row?.cardId ?? null;
  }

  if (body.kind === "checklist.rename" || body.kind === "checklist.delete") {
    const [row] = await db
      .select({ cardId: checklist.cardId })
      .from(checklist)
      .where(eq(checklist.id, body.checklistId))
      .limit(1);
    return row?.cardId ?? null;
  }

  if (body.kind === "comment.edit" || body.kind === "comment.delete") {
    const [row] = await db
      .select({ cardId: comment.cardId })
      .from(comment)
      .where(eq(comment.id, body.commentId))
      .limit(1);
    return row?.cardId ?? null;
  }

  // list.*, label.* and field.* are not about one card, so no card rule applies.
  return null;
}

async function fires(trigger: Trigger, record: MutationRecord, ctx: Ctx): Promise<boolean> {
  const b = record.body;
  switch (trigger.on) {
    case "card.created":
      return b.kind === "card.create" && (!trigger.listId || b.listId === trigger.listId);
    case "card.moved":
      return b.kind === "card.move" && (!trigger.toListId || b.toListId === trigger.toListId);
    case "card.labeled":
      return b.kind === "card.label" && b.on && (!trigger.labelId || b.labelId === trigger.labelId);
    case "card.assigned":
      return b.kind === "card.assign" && b.on && (!trigger.userId || b.userId === trigger.userId);
    case "checklist.completed": {
      // Only interesting on the tick that completes it, not on every tick.
      if (b.kind !== "item.toggle" || !b.done) return false;
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${checklistItem.done})::int`,
        })
        .from(checklistItem)
        .innerJoin(checklist, eq(checklist.id, checklistItem.checklistId))
        .where(eq(checklist.cardId, ctx.cardId));
      return !!row && row.total > 0 && row.total === row.done;
    }
  }
}

/** Turn one action into the mutation that performs it. */
async function toMutation(action: Action, ctx: Ctx): Promise<MutationBody | null> {
  switch (action.do) {
    case "move": {
      // Land it at the end of the target list, where a person would drop it.
      const [last] = await db
        .select({ position: card.position })
        .from(card)
        .where(and(eq(card.listId, action.toListId), sql`${card.archivedAt} is null`))
        .orderBy(sql`${card.position} desc`)
        .limit(1);
      const [exists] = await db
        .select({ id: list.id })
        .from(list)
        .where(and(eq(list.id, action.toListId), eq(list.boardId, ctx.boardId)))
        .limit(1);
      if (!exists) return null; // the list was deleted after the rule was written
      return {
        kind: "card.move",
        cardId: ctx.cardId,
        toListId: action.toListId,
        position: atEnd(last?.position ?? null),
      };
    }
    case "addLabel":
      return { kind: "card.label", cardId: ctx.cardId, labelId: action.labelId, on: true };
    case "removeLabel":
      return { kind: "card.label", cardId: ctx.cardId, labelId: action.labelId, on: false };
    case "assign":
      return { kind: "card.assign", cardId: ctx.cardId, userId: action.userId, on: true };
    case "unassign":
      return { kind: "card.assign", cardId: ctx.cardId, userId: action.userId, on: false };
    case "setDue": {
      const due = new Date();
      due.setDate(due.getDate() + action.inDays);
      const [current] = await db
        .select({ startAt: card.startAt })
        .from(card)
        .where(eq(card.id, ctx.cardId))
        .limit(1);
      return {
        kind: "card.setDates",
        cardId: ctx.cardId,
        startAt: current?.startAt?.toISOString() ?? null,
        dueAt: due.toISOString(),
      };
    }
    case "archive":
      return { kind: "card.archive", cardId: ctx.cardId, archived: true };
    case "comment":
      return {
        kind: "comment.create",
        commentId: randomUUID(),
        cardId: ctx.cardId,
        body: action.body,
      };
  }
}

/**
 * Run every rule that this mutation satisfies.
 *
 * Called after the triggering mutation has committed, so a rule always sees the
 * state its trigger describes. Failures are logged and swallowed: a broken rule
 * must not roll back the human action that set it off.
 */
export async function runRules(
  record: MutationRecord,
  commit: (body: MutationBody, actorId: string | null, ruleId: string) => Promise<unknown>,
): Promise<number> {
  if (isRuleWork(record)) return 0;

  const cardId = await subjectOf(record.body);
  if (!cardId) return 0;

  const rules = await db
    .select()
    .from(rule)
    .where(and(eq(rule.boardId, record.boardId), eq(rule.enabled, true)));
  if (rules.length === 0) return 0;

  const ctx: Ctx = { boardId: record.boardId, cardId };
  let fired = 0;

  for (const r of rules) {
    let trigger: Trigger;
    try {
      trigger = r.trigger as Trigger;
      if (!(await fires(trigger, record, ctx))) continue;
    } catch (err) {
      console.error(`[rules] "${r.name}" has an unreadable trigger:`, err);
      continue;
    }

    for (const action of r.actions as Action[]) {
      try {
        const body = await toMutation(action, ctx);
        if (body) await commit(body, record.actorId, r.id);
      } catch (err) {
        // One bad action should not stop the rest of the rule, nor the mutation
        // that triggered it. Say which rule, so it can be found and fixed.
        console.error(`[rules] "${r.name}" could not ${action.do}:`, err);
      }
    }

    fired += 1;
    await db
      .update(rule)
      .set({ lastFiredAt: new Date(), fireCount: sql`${rule.fireCount} + 1` })
      .where(eq(rule.id, r.id));
  }

  return fired;
}
