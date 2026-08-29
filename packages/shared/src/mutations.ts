import { z } from "zod";

/**
 * Every write in Pergola is a mutation: a typed, named, serialisable intent.
 *
 * This file is the only definition of what a write looks like. The server
 * validates against it, the client builds against it, and the reducer in
 * `state.ts` switches on it exhaustively — so adding a kind without handling it
 * everywhere is a compile error, not a runtime surprise.
 */

const id = z.uuid();
const userId = z.string().min(1);
const position = z.string().min(1);
/** ISO-8601, or null to clear. Dates cross the wire as strings, never Dates. */
const instant = z.iso.datetime().nullable();

/* ------------------------------------------------------------------- lists */

export const ListCreate = z.object({
  kind: z.literal("list.create"),
  listId: id,
  title: z.string().min(1).max(200),
  position,
});
export const ListRename = z.object({
  kind: z.literal("list.rename"),
  listId: id,
  title: z.string().min(1).max(200),
});
export const ListMove = z.object({ kind: z.literal("list.move"), listId: id, position });
export const ListDelete = z.object({ kind: z.literal("list.delete"), listId: id });
export const ListSetWip = z.object({
  kind: z.literal("list.setWip"),
  listId: id,
  wipLimit: z.number().int().positive().max(999).nullable(),
});

/* ------------------------------------------------------------------- cards */

export const CardCreate = z.object({
  kind: z.literal("card.create"),
  cardId: id,
  listId: id,
  title: z.string().min(1).max(500),
  position,
});
export const CardMove = z.object({
  kind: z.literal("card.move"),
  cardId: id,
  toListId: id,
  position,
});
export const CardRename = z.object({
  kind: z.literal("card.rename"),
  cardId: id,
  title: z.string().min(1).max(500),
});
export const CardDescribe = z.object({
  kind: z.literal("card.describe"),
  cardId: id,
  descMd: z.string().max(20_000).nullable(),
});
export const CardSetDates = z.object({
  kind: z.literal("card.setDates"),
  cardId: id,
  startAt: instant,
  dueAt: instant,
});
export const CardSetCover = z.object({
  kind: z.literal("card.setCover"),
  cardId: id,
  coverColor: z.string().max(32).nullable(),
});
export const CardArchive = z.object({
  kind: z.literal("card.archive"),
  cardId: id,
  archived: z.boolean(),
});
export const CardDelete = z.object({ kind: z.literal("card.delete"), cardId: id });

/* ------------------------------------------------------------------ labels */

export const LabelCreate = z.object({
  kind: z.literal("label.create"),
  labelId: id,
  name: z.string().max(64).default(""),
  color: z.string().min(1).max(32),
  position,
});
export const LabelUpdate = z.object({
  kind: z.literal("label.update"),
  labelId: id,
  name: z.string().max(64),
  color: z.string().min(1).max(32),
});
export const LabelDelete = z.object({ kind: z.literal("label.delete"), labelId: id });

export const CardLabel = z.object({
  kind: z.literal("card.label"),
  cardId: id,
  labelId: id,
  on: z.boolean(),
});

/* --------------------------------------------------------------- assignees */

export const CardAssign = z.object({
  kind: z.literal("card.assign"),
  cardId: id,
  userId,
  on: z.boolean(),
});

/* -------------------------------------------------------------- checklists */

export const ChecklistCreate = z.object({
  kind: z.literal("checklist.create"),
  checklistId: id,
  cardId: id,
  title: z.string().min(1).max(200),
  position,
});
export const ChecklistRename = z.object({
  kind: z.literal("checklist.rename"),
  checklistId: id,
  title: z.string().min(1).max(200),
});
export const ChecklistDelete = z.object({
  kind: z.literal("checklist.delete"),
  checklistId: id,
});

export const ItemCreate = z.object({
  kind: z.literal("item.create"),
  itemId: id,
  checklistId: id,
  text: z.string().min(1).max(500),
  position,
});
export const ItemToggle = z.object({
  kind: z.literal("item.toggle"),
  itemId: id,
  done: z.boolean(),
});
export const ItemRename = z.object({
  kind: z.literal("item.rename"),
  itemId: id,
  text: z.string().min(1).max(500),
});
export const ItemSetDue = z.object({
  kind: z.literal("item.setDue"),
  itemId: id,
  dueAt: instant,
  assigneeId: z.string().nullable(),
});
export const ItemMove = z.object({ kind: z.literal("item.move"), itemId: id, position });
export const ItemDelete = z.object({ kind: z.literal("item.delete"), itemId: id });

/* ----------------------------------------------------------- custom fields */

export const FieldType = z.enum(["text", "number", "date", "select", "checkbox"]);

export const FieldCreate = z.object({
  kind: z.literal("field.create"),
  fieldId: id,
  name: z.string().min(1).max(64),
  type: FieldType,
  options: z.array(z.string().min(1).max(64)).max(24).default([]),
  position,
});
export const FieldUpdate = z.object({
  kind: z.literal("field.update"),
  fieldId: id,
  name: z.string().min(1).max(64),
  options: z.array(z.string().min(1).max(64)).max(24),
});
export const FieldDelete = z.object({ kind: z.literal("field.delete"), fieldId: id });
export const CardSetField = z.object({
  kind: z.literal("card.setField"),
  cardId: id,
  fieldId: id,
  /** null clears the value. Always text; the field's type decides how to read it. */
  value: z.string().max(500).nullable(),
});

/* ------------------------------------------------------------------- votes */

export const CardVote = z.object({
  kind: z.literal("card.vote"),
  cardId: id,
  on: z.boolean(),
});

/* ------------------------------------------------------------- attachments */

export const AttachmentAdd = z.object({
  kind: z.literal("attachment.add"),
  attachmentId: id,
  cardId: id,
  /**
   * Link attachments only. File upload needs a storage adapter (a local volume
   * by default, S3-compatible for Supabase Storage) and lands with that work.
   * http(s) only — a javascript: or data: URL on a card is an attack, not a link.
   */
  url: z.url().max(2000).refine((u) => /^https?:\/\//i.test(u), {
    message: "Only http and https links can be attached",
  }),
  name: z.string().min(1).max(200),
});
export const AttachmentRemove = z.object({
  kind: z.literal("attachment.remove"),
  attachmentId: id,
});

/* ---------------------------------------------------------------- comments */

export const CommentCreate = z.object({
  kind: z.literal("comment.create"),
  commentId: id,
  cardId: id,
  body: z.string().min(1).max(10_000),
});
export const CommentEdit = z.object({
  kind: z.literal("comment.edit"),
  commentId: id,
  body: z.string().min(1).max(10_000),
});
export const CommentDelete = z.object({
  kind: z.literal("comment.delete"),
  commentId: id,
});

/* ------------------------------------------------------------------- union */

export const MutationBody = z.discriminatedUnion("kind", [
  ListCreate, ListRename, ListMove, ListDelete, ListSetWip,
  CardCreate, CardMove, CardRename, CardDescribe, CardSetDates,
  CardSetCover, CardArchive, CardDelete,
  LabelCreate, LabelUpdate, LabelDelete, CardLabel,
  CardAssign,
  ChecklistCreate, ChecklistRename, ChecklistDelete,
  FieldCreate, FieldUpdate, FieldDelete, CardSetField,
  AttachmentAdd, AttachmentRemove, CardVote,
  ItemCreate, ItemToggle, ItemRename, ItemSetDue, ItemMove, ItemDelete,
  CommentCreate, CommentEdit, CommentDelete,
]);
export type MutationBody = z.infer<typeof MutationBody>;
export type MutationKind = MutationBody["kind"];

/**
 * What the client sends. `id` is generated client-side and is the idempotency
 * key: replaying an offline queue, or retrying after a timeout, inserts with
 * `on conflict (id) do nothing` and the second write is a no-op.
 */
export const MutationEnvelope = z.object({
  id,
  boardId: id,
  body: MutationBody,
});
export type MutationEnvelope = z.infer<typeof MutationEnvelope>;

/** One row of the log, as the server hands it back. */
export type MutationRecord = {
  id: string;
  boardId: string;
  seq: number;
  actorId: string | null;
  body: MutationBody;
  inverse: MutationBody | null;
  /** The automation rule that produced this, if a rule did. */
  ruleId: string | null;
  createdAt: string;
};

/** Frames pushed over the socket. The socket only ever carries log deltas. */
export type ServerFrame =
  | { type: "hello"; boardId: string; seq: number }
  | { type: "delta"; boardId: string; mutations: MutationRecord[] }
  | { type: "error"; message: string };

export type ClientFrame =
  | { type: "subscribe"; boardId: string; since: number }
  | { type: "ping" };

/** Human wording for the activity feed. One place, so the log reads consistently. */
export function describe(body: MutationBody): string {
  switch (body.kind) {
    case "list.create": return `added list “${body.title}”`;
    case "list.rename": return `renamed a list to “${body.title}”`;
    case "list.move": return "moved a list";
    case "list.delete": return "deleted a list";
    case "list.setWip":
      return body.wipLimit === null ? "removed a WIP limit" : `set a WIP limit of ${body.wipLimit}`;
    case "card.create": return `added card “${body.title}”`;
    case "card.move": return "moved a card";
    case "card.rename": return `renamed a card to “${body.title}”`;
    case "card.describe": return "edited a description";
    case "card.setDates": return body.dueAt ? "set a due date" : "cleared the dates";
    case "card.setCover": return body.coverColor ? "set a cover" : "removed a cover";
    case "card.archive": return body.archived ? "archived a card" : "restored a card";
    case "card.delete": return "deleted a card";
    case "label.create": return `created label “${body.name || body.color}”`;
    case "label.update": return "edited a label";
    case "label.delete": return "deleted a label";
    case "card.label": return body.on ? "added a label" : "removed a label";
    case "card.assign": return body.on ? "assigned someone" : "unassigned someone";
    case "checklist.create": return `added checklist “${body.title}”`;
    case "checklist.rename": return "renamed a checklist";
    case "checklist.delete": return "deleted a checklist";
    case "item.create": return `added “${body.text}”`;
    case "item.toggle": return body.done ? "ticked an item" : "unticked an item";
    case "item.rename": return "edited an item";
    case "item.setDue": return "changed an item's date";
    case "item.move": return "reordered an item";
    case "item.delete": return "deleted an item";
    case "field.create": return `added field “${body.name}”`;
    case "field.update": return "edited a field";
    case "field.delete": return "deleted a field";
    case "card.setField": return body.value === null ? "cleared a field" : "set a field";
    case "card.vote": return body.on ? "voted for this" : "took their vote back";
    case "attachment.add": return `attached “${body.name}”`;
    case "attachment.remove": return "removed an attachment";
    case "comment.create": return "commented";
    case "comment.edit": return "edited a comment";
    case "comment.delete": return "deleted a comment";
    default: {
      const never: never = body;
      return never;
    }
  }
}
