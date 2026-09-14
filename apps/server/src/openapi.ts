import { z } from "zod";
import {
  MAX_BATCH,
  MutationBody,
  MutationEnvelope,
  RuleInput,
  type BoardState,
  type MutationRecord,
} from "@pergola/shared";
import { PergolaExport, TrelloExport } from "./import/formats.js";

/**
 * The API, described.
 *
 * Generated from the same Zod schemas the routes validate with, so the document
 * cannot say one thing while the server checks another. A mutation kind added
 * to the union appears here on the next request; a request body the route
 * would refuse is one this document does not admit either.
 *
 * Responses are the one place a schema has to be written down twice, because
 * the server builds them from rows rather than parsing them. Each is declared
 * against the TypeScript type it describes, so leaving a field out — or
 * spelling one differently — is a compile error rather than a stale document.
 *
 * Only the surface meant for integrations is here: boards, the write endpoint,
 * search, import and export, tokens, webhooks, rules and files. Sign-in, the
 * admin console and notifications are the interface's own and deliberately
 * left out.
 */

/* ------------------------------------------------------------ responses -- */

const nullable = <T extends z.ZodType>(s: T) => s.nullable();
const iso = z.iso.datetime();

const Member = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: nullable(z.string()),
}) satisfies z.ZodType<BoardState["members"][number]>;

const Label = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  position: z.string(),
}) satisfies z.ZodType<BoardState["labels"][number]>;

const List = z.object({
  id: z.string(),
  position: z.string(),
  title: z.string(),
  wipLimit: nullable(z.number().int()),
}) satisfies z.ZodType<BoardState["lists"][number]>;

const Card = z.object({
  id: z.string(),
  listId: z.string(),
  position: z.string(),
  title: z.string(),
  number: z.number().int(),
  descMd: nullable(z.string()),
  startAt: nullable(iso),
  dueAt: nullable(iso),
  coverColor: nullable(z.string()),
  archivedAt: nullable(iso),
  labelIds: z.array(z.string()),
  assigneeIds: z.array(z.string()),
  fields: z.record(z.string(), z.string()),
  voterIds: z.array(z.string()),
  lastActivityAt: nullable(iso),
  createdBy: nullable(z.string()),
  createdByName: nullable(z.string()),
  createdAt: nullable(iso),
}) satisfies z.ZodType<BoardState["cards"][number]>;

const CustomField = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["text", "number", "date", "select", "checkbox"]),
  options: z.array(z.string()),
  position: z.string(),
}) satisfies z.ZodType<BoardState["fields"][number]>;

const Checklist = z.object({
  id: z.string(),
  cardId: z.string(),
  title: z.string(),
  position: z.string(),
}) satisfies z.ZodType<BoardState["checklists"][number]>;

const ChecklistItem = z.object({
  id: z.string(),
  checklistId: z.string(),
  text: z.string(),
  done: z.boolean(),
  dueAt: nullable(iso),
  assigneeId: nullable(z.string()),
  position: z.string(),
}) satisfies z.ZodType<BoardState["items"][number]>;

const Attachment = z.object({
  id: z.string(),
  cardId: z.string(),
  url: z.string(),
  name: z.string(),
  addedBy: nullable(z.string()),
  createdAt: iso,
}) satisfies z.ZodType<BoardState["attachments"][number]>;

const Comment = z.object({
  id: z.string(),
  cardId: z.string(),
  authorId: z.string(),
  body: z.string(),
  parentId: nullable(z.string()),
  createdAt: iso,
  editedAt: nullable(iso),
}) satisfies z.ZodType<BoardState["comments"][number]>;

const Board = z
  .object({
    id: z.string(),
    title: z.string(),
    seq: z.number().int().describe("The last mutation this snapshot reflects. Sync forward from here."),
    lists: z.array(List),
    cards: z.array(Card),
    labels: z.array(Label),
    fields: z.array(CustomField),
    checklists: z.array(Checklist),
    items: z.array(ChecklistItem),
    attachments: z.array(Attachment),
    comments: z.array(Comment),
    members: z.array(Member),
  })
  .describe("A board and everything on it, as of `seq`.") satisfies z.ZodType<BoardState>;

const Record_ = z
  .object({
    id: z.string(),
    boardId: z.string(),
    seq: z.number().int(),
    actorId: nullable(z.string()),
    body: MutationBody,
    inverse: nullable(MutationBody).describe(
      "The mutation that undoes this one. Null when the change cascades and cannot honestly be reversed.",
    ),
    ruleId: nullable(z.string()).describe("The automation rule that produced this, if a rule did."),
    createdAt: iso,
  })
  .describe("One row of the log: what changed, who did it, and how to undo it.") satisfies z.ZodType<MutationRecord>;

const BoardSummary = z.object({
  id: z.string(),
  title: z.string(),
  seq: z.number().int(),
  role: z.enum(["admin", "member", "observer"]),
  member: z.boolean().describe("False only for an instance admin looking at a board they are not on."),
  cardCount: z.number().int(),
  memberCount: z.number().int(),
  createdAt: iso,
});

const SearchHit = z.object({
  cardId: z.string(),
  number: z.number().int(),
  title: z.string(),
  archivedAt: nullable(iso),
  boardId: z.string(),
  boardTitle: z.string(),
  listTitle: z.string(),
  rank: z.number(),
});

const Activity = z.object({
  id: z.string(),
  seq: z.number().int(),
  body: MutationBody,
  actorId: nullable(z.string()),
  actorName: nullable(z.string()),
  ruleName: nullable(z.string()),
  createdAt: iso,
});

const Person = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: nullable(z.string()),
});

const Token = z.object({
  id: z.string(),
  name: z.string(),
  lastUsedAt: nullable(iso),
  expiresAt: nullable(iso),
  createdAt: iso,
});

const Webhook = z.object({
  id: z.string(),
  url: z.string(),
  active: z.boolean(),
  lastStatus: nullable(z.number().int()),
  lastError: nullable(z.string()),
  lastFiredAt: nullable(iso),
});

const Rule = RuleInput.extend({
  id: z.string(),
  boardId: z.string(),
  fireCount: z.number().int(),
  lastFiredAt: nullable(iso),
});

const Upload = z.object({
  id: z.string(),
  cardId: z.string(),
  url: z.string(),
  name: z.string(),
  size: z.number().int(),
  contentType: z.string(),
  createdAt: iso,
  mutation: Record_.describe("The change as the board will see it."),
});

const Problem = z.object({ message: z.string() });

/* ------------------------------------------------------------- requests -- */

const NewBoard = z.object({ title: z.string().min(1).max(200) });
const Duplicate = z.object({
  title: z.string().min(1).max(200),
  withCards: z.boolean().default(false),
});
const Membership = z.object({
  userId: z.string().min(1),
  role: z.enum(["admin", "member", "observer"]).default("member"),
});
const NewToken = z.object({
  name: z.string().min(1).max(80),
  expiresInDays: z.number().int().positive().max(3650).nullable().default(null),
});
const NewWebhook = z.object({ url: z.url().max(2000) });
const RuleToggle = z.object({ enabled: z.boolean() });
const PergolaImport = z.object({ title: z.string().max(200).optional(), data: PergolaExport });

/* ------------------------------------------------------------- document -- */

/** "card.rename" → "CardRename": a name a generated client can use. */
const componentName = (kind: string) =>
  kind
    .split(".")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

type Json = Record<string, unknown>;

const schema = (s: z.ZodType, io: "input" | "output" = "output"): Json =>
  z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" }) as Json;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (body: Json, description: string) => ({
  description,
  content: { "application/json": { schema: body } },
});

const problem = (description: string) => json(ref("Problem"), description);

const boardId = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "A board id.",
};

let cached: Json | null = null;

/** The OpenAPI 3.0 document. Built once; the schemas never change at runtime. */
export function openapi(): Json {
  if (cached) return cached;

  const components: Record<string, Json> = {};
  const kinds: string[] = [];
  for (const variant of MutationBody.options) {
    const kind = variant.shape.kind.value;
    kinds.push(kind);
    components[componentName(kind)] = schema(variant, "input");
  }
  components.MutationBody = {
    description: "One change to a board. `kind` says which; the rest is that kind's payload.",
    oneOf: kinds.map((k) => ref(componentName(k))),
    discriminator: {
      propertyName: "kind",
      mapping: Object.fromEntries(kinds.map((k) => [k, ref(componentName(k)).$ref])),
    },
  };
  components.MutationEnvelope = {
    ...schema(MutationEnvelope.omit({ body: true }), "input"),
    description:
      "A change and where it goes. `id` is an idempotency key you generate: sending the same envelope twice is a no-op, so a request that timed out can be retried without checking whether it landed.",
  };
  (components.MutationEnvelope.properties as Json).body = ref("MutationBody");
  (components.MutationEnvelope.required as string[]).push("body");

  const named = {
    MutationRecord: Record_,
    Board,
    BoardSummary,
    SearchHit,
    Activity,
    Person,
    Token,
    Webhook,
    Rule,
    Upload,
    Problem,
    NewBoard,
    Duplicate,
    Membership,
    NewToken,
    NewWebhook,
    RuleToggle,
    RuleInput,
    PergolaImport,
    PergolaExport,
    TrelloExport,
  };
  for (const [name, s] of Object.entries(named)) {
    const input = /^(New|Duplicate|Membership|RuleToggle|RuleInput|PergolaImport|TrelloExport)/.test(name);
    components[name] = schema(s, input ? "input" : "output");
  }
  // Records and activity carry a mutation body; point at the shared definition
  // rather than inlining thirty-odd variants three times over.
  for (const name of ["MutationRecord", "Activity"]) {
    const props = components[name]!.properties as Json;
    props.body = ref("MutationBody");
  }
  (components.MutationRecord!.properties as Json).inverse = {
    nullable: true,
    allOf: [ref("MutationBody")],
    description: (Record_.shape.inverse as z.ZodType).description,
  };
  ((components.Upload!.properties as Json).mutation as Json) = ref("MutationRecord");

  cached = {
    openapi: "3.0.3",
    info: {
      title: "Pergola",
      version: "1",
      description: [
        "Self-hosted kanban. Every change to a board's contents goes through `POST /api/mutations`",
        "as a typed mutation; everything else is ordinary REST. Reads return the board as it is,",
        "and `GET /api/boards/{id}/since/{seq}` returns only what changed after a cursor.",
        "",
        "Authenticate with `Authorization: Bearer prg_…` — mint a token under *Settings → Tokens*.",
        "The interface's own session cookie works on the same endpoints.",
      ].join("\n"),
    },
    servers: [{ url: "/api" }],
    security: [{ bearer: [] }],
    tags: [
      { name: "boards" },
      { name: "mutations", description: "The write endpoint." },
      { name: "search" },
      { name: "transfer", description: "Import and export." },
      { name: "tokens" },
      { name: "webhooks" },
      { name: "rules", description: "Automation." },
      { name: "files" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["boards"],
          security: [],
          summary: "Is the instance up?",
          responses: {
            200: json({ type: "object", properties: { ok: { type: "boolean" } } }, "Up."),
            503: json({ type: "object", properties: { ok: { type: "boolean" } } }, "Up, but the live listener has died."),
          },
        },
      },
      "/me": {
        get: {
          tags: ["boards"],
          summary: "Who am I?",
          responses: {
            200: json(
              {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  email: { type: "string" },
                  role: { type: "string", enum: ["owner", "admin", "member"] },
                  banned: { type: "boolean" },
                  banReason: { type: "string", nullable: true },
                },
              },
              "The account behind this token or session.",
            ),
            401: problem("Not signed in."),
          },
        },
      },
      "/boards": {
        get: {
          tags: ["boards"],
          summary: "The boards you can open",
          responses: { 200: json({ type: "array", items: ref("BoardSummary") }, "Boards, newest first.") },
        },
        post: {
          tags: ["boards"],
          summary: "Create a board",
          description: "You become its admin. It starts with three lists and six labels.",
          requestBody: { required: true, content: { "application/json": { schema: ref("NewBoard") } } },
          responses: {
            201: json(
              {
                type: "object",
                properties: { id: { type: "string" }, title: { type: "string" }, seq: { type: "integer" } },
              },
              "Created.",
            ),
          },
        },
      },
      "/boards/{id}": {
        parameters: [boardId],
        get: {
          tags: ["boards"],
          summary: "Read a board, including every card",
          responses: {
            200: json(ref("Board"), "The board as of `seq`."),
            403: problem("Not a member."),
            404: problem("No such board."),
          },
        },
      },
      "/boards/{id}/since/{seq}": {
        parameters: [
          boardId,
          {
            name: "seq",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "The last `seq` you have seen.",
          },
        ],
        get: {
          tags: ["boards"],
          summary: "Everything that changed after a cursor",
          description:
            "The whole sync protocol: read the board, remember its `seq`, then ask for what came after. At most 500 records; ask again from the last one if you got 500.",
          responses: { 200: json({ type: "array", items: ref("MutationRecord") }, "In order.") },
        },
      },
      "/boards/{id}/activity": {
        parameters: [
          boardId,
          { name: "cardId", in: "query", schema: { type: "string", format: "uuid" }, description: "Only this card." },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
        ],
        get: {
          tags: ["boards"],
          summary: "The activity feed",
          description: "The mutation log read backwards, with names attached.",
          responses: { 200: json({ type: "array", items: ref("Activity") }, "Newest first.") },
        },
      },
      "/boards/{id}/duplicate": {
        parameters: [boardId],
        post: {
          tags: ["boards"],
          summary: "Copy a board",
          description: "Lists, labels and fields always; cards only when asked. This is the template mechanism.",
          requestBody: { required: true, content: { "application/json": { schema: ref("Duplicate") } } },
          responses: {
            201: json(
              { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
              "The copy.",
            ),
          },
        },
      },
      "/boards/{id}/members": {
        parameters: [boardId],
        post: {
          tags: ["boards"],
          summary: "Add someone, or change their role",
          description: "Admins only. Find the person's id with `GET /people?email=`.",
          requestBody: { required: true, content: { "application/json": { schema: ref("Membership") } } },
          responses: {
            201: json(ref("Membership"), "On the board."),
            403: problem("Only an admin can invite people."),
            404: problem("No such person."),
            409: problem("A board needs at least one admin."),
          },
        },
      },
      "/boards/{id}/members/{userId}": {
        parameters: [boardId, { name: "userId", in: "path", required: true, schema: { type: "string" } }],
        delete: {
          tags: ["boards"],
          summary: "Remove someone",
          description: "Anyone may remove themselves; removing someone else needs admin.",
          responses: {
            204: { description: "Gone." },
            403: problem("Only an admin can remove people."),
            409: problem("A board needs at least one admin."),
          },
        },
      },
      "/mutations": {
        post: {
          tags: ["mutations"],
          summary: "Change a board",
          description: [
            "The only endpoint that changes a board's contents. Send one envelope, or an array of up to",
            `${MAX_BATCH} envelopes to be applied as a single atomic change: every one lands or none does,`,
            "under one sequence lock, and the response has the shape of the request.",
            "",
            "Mint `id`s yourself (UUIDs). For anything that creates something — a card, a list, a comment —",
            "you also mint the new thing's id, which is what lets a client show it before the server answers.",
            "`position` is a fractional-index string: read the board, and place the new item between its",
            "neighbours' positions, or after the last one.",
            "",
            "Every change is logged under your name, streamed to every open browser, and undoable.",
          ].join("\n"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    ref("MutationEnvelope"),
                    { type: "array", items: ref("MutationEnvelope"), minItems: 1, maxItems: MAX_BATCH },
                  ],
                },
                examples: {
                  rename: {
                    summary: "Rename a card",
                    value: {
                      id: "5f1c1a6e-3d4c-4f88-9b2e-0f0e0a1b2c3d",
                      boardId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                      body: { kind: "card.rename", cardId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b", title: "New title" },
                    },
                  },
                  batch: {
                    summary: "Rename and move, together",
                    value: [
                      {
                        id: "5f1c1a6e-3d4c-4f88-9b2e-0f0e0a1b2c3d",
                        boardId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                        body: { kind: "card.rename", cardId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b", title: "Ship it" },
                      },
                      {
                        id: "6a2d2b7f-4e5d-4a99-8c3f-1a1f1b2c3d4e",
                        boardId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                        body: {
                          kind: "card.move",
                          cardId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
                          toListId: "7c6b5a4f-3e2d-4c1b-8a0f-9e8d7c6b5a4f",
                          position: "a1",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          responses: {
            201: json(
              {
                oneOf: [ref("MutationRecord"), { type: "array", items: ref("MutationRecord") }],
              },
              "Applied. A record for an envelope, an array of records for an array. A replayed `id` returns the record that already exists.",
            ),
            400: problem("Malformed, or a batch that names more than one board."),
            403: problem("Your role on this board cannot do this."),
            409: problem("Something the mutation refers to no longer exists. An ordinary race, not a fault: re-read the board."),
          },
        },
      },
      "/search": {
        get: {
          tags: ["search"],
          summary: "Search cards across your boards",
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: json({ type: "array", items: ref("SearchHit") }, "Best matches first.") },
        },
      },
      "/people": {
        get: {
          tags: ["search"],
          summary: "Find a person by exact email",
          description: "Not a directory: an exact address returns at most one person.",
          parameters: [{ name: "email", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: json({ type: "array", items: ref("Person") }, "Zero or one.") },
        },
      },
      "/boards/{id}/export": {
        parameters: [boardId],
        get: {
          tags: ["transfer"],
          summary: "Export a board",
          description: "Everything except assignees, which belong to this instance's accounts. Re-imports anywhere.",
          responses: { 200: json(ref("PergolaExport"), "The board, as a file.") },
        },
      },
      "/import/pergola": {
        post: {
          tags: ["transfer"],
          summary: "Import a Pergola export",
          requestBody: { required: true, content: { "application/json": { schema: ref("PergolaImport") } } },
          responses: { 201: json({ type: "object" }, "The new board, and anything that could not be carried.") },
        },
      },
      "/import/trello": {
        post: {
          tags: ["transfer"],
          summary: "Import a Trello JSON export",
          description: "Send the file Trello gives you, verbatim.",
          requestBody: { required: true, content: { "application/json": { schema: ref("TrelloExport") } } },
          responses: { 201: json({ type: "object" }, "The new board, and anything that could not be carried.") },
        },
      },
      "/tokens": {
        get: {
          tags: ["tokens"],
          summary: "Your API tokens",
          responses: { 200: json({ type: "array", items: ref("Token") }, "Never the token itself.") },
        },
        post: {
          tags: ["tokens"],
          summary: "Mint a token",
          description: "The plaintext is in this response and nowhere else; only a hash is stored.",
          requestBody: { required: true, content: { "application/json": { schema: ref("NewToken") } } },
          responses: {
            201: json(
              {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  token: { type: "string", example: "prg_…" },
                  shownOnce: { type: "boolean", enum: [true] },
                },
              },
              "Copy it now.",
            ),
          },
        },
      },
      "/tokens/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: {
          tags: ["tokens"],
          summary: "Revoke a token",
          description: "Takes effect on the next request. An assistant connected with it is disconnected.",
          responses: { 204: { description: "Revoked." } },
        },
      },
      "/boards/{id}/webhooks": {
        parameters: [boardId],
        get: {
          tags: ["webhooks"],
          summary: "This board's webhooks",
          description: "Admins only: a webhook URL is often a credential.",
          responses: { 200: json({ type: "array", items: ref("Webhook") }, "Oldest first.") },
        },
        post: {
          tags: ["webhooks"],
          summary: "Add a webhook",
          description:
            "Every change on the board is POSTed to it, signed with HMAC-SHA256 over `{timestamp}.{body}` in `x-pergola-signature`. The URL must resolve to a public address.",
          requestBody: { required: true, content: { "application/json": { schema: ref("NewWebhook") } } },
          responses: {
            201: json(ref("Webhook"), "Listening."),
            400: problem("The URL resolves to a private address."),
          },
        },
      },
      "/boards/{id}/webhooks/{hookId}": {
        parameters: [boardId, { name: "hookId", in: "path", required: true, schema: { type: "string" } }],
        delete: {
          tags: ["webhooks"],
          summary: "Remove a webhook",
          responses: { 204: { description: "Removed." } },
        },
      },
      "/boards/{id}/rules": {
        parameters: [boardId],
        get: {
          tags: ["rules"],
          summary: "This board's automation rules",
          responses: { 200: json({ type: "array", items: ref("Rule") }, "Oldest first.") },
        },
        post: {
          tags: ["rules"],
          summary: "Add a rule",
          description: "A trigger and what to do. Whatever a rule does is an ordinary mutation: logged, streamed and undoable.",
          requestBody: { required: true, content: { "application/json": { schema: ref("RuleInput") } } },
          responses: { 201: json(ref("Rule"), "Armed.") },
        },
      },
      "/boards/{id}/rules/{ruleId}": {
        parameters: [boardId, { name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["rules"],
          summary: "Enable or disable a rule",
          requestBody: { required: true, content: { "application/json": { schema: ref("RuleToggle") } } },
          responses: { 204: { description: "Done." } },
        },
        delete: {
          tags: ["rules"],
          summary: "Delete a rule",
          responses: { 204: { description: "Gone." } },
        },
      },
      "/cards/{cardId}/files": {
        parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        post: {
          tags: ["files"],
          summary: "Attach a file to a card",
          description: "Up to 10 MB, as `multipart/form-data` with the file in the `file` field. The attachment is added through the mutation log like any other change.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { file: { type: "string", format: "binary" } },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            201: json(ref("Upload"), "Stored."),
            413: problem("Larger than 10 MB."),
            415: problem("A type that cannot be served safely."),
          },
        },
      },
      "/files/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: {
          tags: ["files"],
          summary: "Download an attachment",
          description: "Checks that you are on the board the file's card belongs to.",
          responses: {
            200: { description: "The bytes, with their content type.", content: { "*/*": { schema: { type: "string", format: "binary" } } } },
            404: problem("No such file."),
          },
        },
        delete: {
          tags: ["files"],
          summary: "Remove an attachment",
          responses: { 204: { description: "Removed." } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "An API token from *Settings → Tokens*. Shown once; stored as a hash.",
        },
      },
      schemas: components,
    },
  };
  return cached;
}
