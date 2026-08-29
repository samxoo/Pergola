import { z } from "zod";

/**
 * Automation rules.
 *
 * Trello meters this and calls it Butler. It is a trigger, an optional
 * narrowing, and a list of things to do — which is small enough to define once
 * and share between the engine, the API and the editor.
 */

const id = z.uuid();

export const Trigger = z.discriminatedUnion("on", [
  z.object({
    on: z.literal("card.created"),
    /** Only when it lands in this list. Omit for any list. */
    listId: id.nullable().default(null),
  }),
  z.object({
    on: z.literal("card.moved"),
    toListId: id.nullable().default(null),
  }),
  z.object({
    on: z.literal("card.labeled"),
    labelId: id.nullable().default(null),
  }),
  z.object({
    on: z.literal("card.assigned"),
    userId: z.string().nullable().default(null),
  }),
  /** Fires when the last unticked item on a card's checklists gets ticked. */
  z.object({ on: z.literal("checklist.completed") }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Action = z.discriminatedUnion("do", [
  z.object({ do: z.literal("move"), toListId: id }),
  z.object({ do: z.literal("addLabel"), labelId: id }),
  z.object({ do: z.literal("removeLabel"), labelId: id }),
  z.object({ do: z.literal("assign"), userId: z.string() }),
  z.object({ do: z.literal("unassign"), userId: z.string() }),
  /** Relative, because "due in 3 days" is what people actually mean. */
  z.object({ do: z.literal("setDue"), inDays: z.number().int().min(-365).max(365) }),
  z.object({ do: z.literal("archive") }),
  z.object({ do: z.literal("comment"), body: z.string().min(1).max(2000) }),
]);
export type Action = z.infer<typeof Action>;

export const RuleInput = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: Trigger,
  actions: z.array(Action).min(1).max(10),
});
export type RuleInput = z.infer<typeof RuleInput>;

export type Rule = RuleInput & {
  id: string;
  boardId: string;
  lastFiredAt: string | null;
  fireCount: number;
};

/** One line describing what a rule does, for the rule list. */
export function describeRule(rule: Pick<RuleInput, "trigger" | "actions">): string {
  const when = (() => {
    switch (rule.trigger.on) {
      case "card.created":
        return rule.trigger.listId ? "When a card is added to that list" : "When a card is added";
      case "card.moved":
        return rule.trigger.toListId ? "When a card moves into that list" : "When a card moves";
      case "card.labeled":
        return rule.trigger.labelId ? "When that label is added" : "When any label is added";
      case "card.assigned":
        return rule.trigger.userId ? "When that person is assigned" : "When anyone is assigned";
      case "checklist.completed":
        return "When every checklist item is ticked";
    }
  })();

  const then = rule.actions.map((a) => {
    switch (a.do) {
      case "move": return "move it";
      case "addLabel": return "add a label";
      case "removeLabel": return "remove a label";
      case "assign": return "assign someone";
      case "unassign": return "unassign someone";
      case "setDue":
        return a.inDays === 0
          ? "make it due today"
          : `make it due in ${a.inDays} day${Math.abs(a.inDays) === 1 ? "" : "s"}`;
      case "archive": return "archive it";
      case "comment": return "post a comment";
    }
  });

  return `${when}, ${then.join(" and ")}.`;
}
