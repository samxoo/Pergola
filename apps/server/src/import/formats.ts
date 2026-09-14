import { z } from "zod";

/**
 * The two file formats the importers read, and nothing else.
 *
 * Kept apart from the importers because those write to the database, and the
 * shapes are wanted where no database is: the OpenAPI document, and the test
 * that checks it.
 */

/* ----------------------------------------------------------------- pergola */

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

/* ------------------------------------------------------------------ trello */

/**
 * Trello JSON import.
 *
 * Deliberately lenient: Trello adds and renames fields, and an importer that
 * rejects an export because of one unexpected key is worthless. Everything not
 * named here is ignored, and everything named here is optional wherever Trello
 * might omit it.
 */
const TrelloLabel = z.object({
  id: z.string(),
  name: z.string().default(""),
  color: z.string().nullable().default(null),
});

const TrelloList = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean().default(false),
  pos: z.number().default(0),
});

const TrelloCard = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(""),
  closed: z.boolean().default(false),
  idList: z.string(),
  pos: z.number().default(0),
  due: z.string().nullable().default(null),
  start: z.string().nullable().default(null),
  idLabels: z.array(z.string()).default([]),
});

const TrelloCheckItem = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().default("incomplete"),
  pos: z.number().default(0),
});

const TrelloChecklist = z.object({
  id: z.string(),
  name: z.string().default("Checklist"),
  idCard: z.string(),
  pos: z.number().default(0),
  checkItems: z.array(TrelloCheckItem).default([]),
});

const TrelloAction = z.object({
  type: z.string(),
  date: z.string().optional(),
  data: z
    .object({
      text: z.string().optional(),
      card: z.object({ id: z.string() }).partial().optional(),
    })
    .optional(),
  memberCreator: z.object({ fullName: z.string().optional() }).partial().optional(),
});

export const TrelloExport = z.object({
  name: z.string().default("Imported board"),
  // Bounded, so a crafted export cannot be used to exhaust the instance.
  labels: z.array(TrelloLabel).max(200).default([]),
  lists: z.array(TrelloList).max(500).default([]),
  cards: z.array(TrelloCard).max(50_000).default([]),
  checklists: z.array(TrelloChecklist).max(20_000).default([]),
  actions: z.array(TrelloAction).max(100_000).default([]),
});
export type TrelloExport = z.infer<typeof TrelloExport>;
