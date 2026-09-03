# Pergola

Self-hosted kanban for teams. Boards, cards, drag and drop and live
collaboration, running on your own server with your data in your own Postgres.

![A Pergola board](docs/img/board.jpg)

```bash
git clone https://github.com/samxoo/Pergola && cd Pergola
docker compose -f docker/compose.yaml up -d
# http://localhost:3000
```

Postgres is bundled, the schema migrates itself on first boot, and there is no
configuration file to edit before you sign in. The first account created owns
the instance.

---

## Contents

- [Why another kanban tool](#why-another-kanban-tool)
- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running it for a team](#running-it-for-a-team)
- [Migrating from Trello](#migrating-from-trello)
- [Exporting your data](#exporting-your-data)
- [API](#api)
- [Webhooks](#webhooks)
- [Architecture](#architecture)
- [Development](#development)
- [Project status](#project-status)
- [Licence](#licence)

---

## Why another kanban tool

Most self-hosted kanban tools implement an ordinary CRUD layer and then add
real-time sync on top of it, as a second way to write data. That second path is
usually where they become slow and inconsistent.

Pergola works the other way round. Every change to a board — creating a card,
dragging it two columns over, ticking a checklist item — is recorded as one row
in an append-only log. Six capabilities then follow from that single table
instead of being built separately:

| Capability | Where it comes from |
| --- | --- |
| Live sync between browsers | Stream the rows after a client's cursor |
| Reconnecting after a dropped link | Send the cursor, receive only the delta |
| Undo and redo | Each row stores the change that reverses it |
| Activity feed | The log, read backwards |
| Audit trail | The same rows, queried differently |
| Offline editing | Queue locally, replay on reconnect |

Because every write goes through one path, a change made by an automation rule
is logged, undoable and streamed exactly like one made by a person.

## Features

**Boards.** Lists, cards, drag and drop, labels, assignees, start and due dates,
checklists, comments, attachments, custom fields, card covers, and
work-in-progress limits per list.

**Four views.** Board, table, calendar, and a timeline with draggable date
ranges. Swimlanes group a board by label or assignee; dragging a card into
another lane reassigns it.

**Collaboration.** Changes appear on every open browser within milliseconds.
Undo works across the whole board with <kbd>Cmd</kbd>+<kbd>Z</kbd>, and is
replicated, so teammates see it too.

**Finding things.** Full-text search across every board you belong to, filters
by text, label, member and due state, and a command palette.

**Automation.** Rules that react to what happens on a board: when a checklist is
finished, move the card and post a comment. Unmetered.

**Integrations.** API tokens, a REST API over the same endpoints the interface
uses, and signed outbound webhooks.

**Administration.** Instance roles, invitations, a people directory, and
immediate revocation when someone leaves.

**Offline.** Changes made without a connection are kept locally and replayed
when it returns.

<p align="center">
  <img src="docs/img/timeline.jpg" width="49%" alt="Timeline view">
  <img src="docs/img/swimlanes.jpg" width="49%" alt="Swimlanes grouped by label">
</p>

## Installation

### Docker Compose

```bash
git clone https://github.com/samxoo/Pergola && cd Pergola
docker compose -f docker/compose.yaml up -d
```

This starts Postgres alongside the application on port 3000. Images build for
`linux/amd64` and `linux/arm64`, so a Raspberry Pi or an ARM VPS works.

### With an external Postgres

Point `DATABASE_URL` at Supabase, Neon, RDS or your own server, and start only
the application:

```bash
echo 'DATABASE_URL=postgresql://user:pass@host:5432/pergola' >> .env
docker compose -f docker/compose.yaml up -d app
```

> **Connection poolers.**
> If `DATABASE_URL` points at a transaction-mode pooler — Supabase's port 6543,
> or pgBouncer — also set `DATABASE_DIRECT_URL` to the direct port 5432
> connection. `LISTEN`/`NOTIFY` does not survive a pooler, so reads and writes
> would keep working while live updates silently stopped. Pergola detects this
> at startup, warns, and falls back to polling rather than appearing to be live.

### Vercel and Supabase

The same codebase also deploys without a server to run it: the client as static
files on Vercel's CDN, the API as one function, with Postgres and file storage
on Supabase. Nothing is kept on the instance itself, which is what lets it
survive having no disk and no process between requests.

1. **Supabase.** Create a project. Under *Storage*, create a **private** bucket
   named `attachments`. You will need three things from *Project Settings*: the
   **pooled** connection string (Database → Connection pooling, port 6543), the
   project URL, and the service key.

2. **Vercel.** Import the repository and leave *Root Directory* as the
   repository root — `vercel.json` there builds the client, the server and the
   function together. Do not set it to `apps/server`: that directory builds a
   long-lived server, which is the other deployment.

3. **Environment variables**, in the Vercel project:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | the pooled Supabase string, port 6543 |
   | `BETTER_AUTH_SECRET` | a fresh secret, generated as above |
   | `STORAGE_DRIVER` | `supabase` |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SECRET_KEY` | the service key |
   | `SUPABASE_STORAGE_BUCKET` | `attachments`, unless you named it something else |

   `BETTER_AUTH_URL` is filled in from the deployment's own domain, so it only
   needs setting once a custom domain is in front. Leave `DATABASE_DIRECT_URL`
   unset: it exists for the `LISTEN`/`NOTIFY` listener, which a function cannot
   hold open anyway.

4. **Deploy.** The production build applies migrations before the function goes
   live. Preview builds deliberately do not — they usually point at the same
   database, and a half-finished migration from a branch is not something to
   apply by accident. Set `RUN_MIGRATIONS=1` when that is genuinely what you
   want.

Three things behave differently there, and only three:

- **Live updates arrive over SSE**, not a WebSocket, because a function cannot
  hold a socket open. The frames are identical and the client picks the
  transport by asking `/api/health`; nothing in the interface changes. A stream
  ends itself just under a minute and the browser resumes from the last event it
  saw, so a platform timeout is an ordinary reconnect rather than a gap.
- **Uploads go to the Supabase bucket** rather than a volume. The bucket stays
  private: bytes are still served through `/api/files/:id`, which is where board
  membership and the safe-content-type rules live.
- **Migrations run at deploy**, not at boot, because there is no boot.

Everything else — the write path, authorization, automation, webhooks, exports —
is the same code running in a different shape.

### Without Docker

Requires Node 20 or newer, pnpm, and a reachable Postgres 16 or newer.

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and BETTER_AUTH_SECRET
pnpm build
pnpm --filter @pergola/server start
```

## Configuration

All configuration is by environment variable. Only the first two are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string. Required. |
| `BETTER_AUTH_SECRET` | — | Signs session cookies. Required. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | The URL people actually reach this instance on. |
| `DATABASE_DIRECT_URL` | unset | Direct, non-pooled connection for live updates. See above. |
| `PORT` | `3000` | Port to listen on. |
| `TRUSTED_ORIGINS` | unset | Additional origins allowed to sign in, comma separated. |
| `STORAGE_DRIVER` | `local` | Where uploaded files are kept: `local` or `supabase`. |
| `STORAGE_DIR` | `./data/uploads` | Directory used by the local driver. |
| `SUPABASE_URL` | unset | Project URL. Required by the `supabase` driver. |
| `SUPABASE_SECRET_KEY` | unset | Service key. Required by the `supabase` driver. |
| `SUPABASE_STORAGE_BUCKET` | `attachments` | Bucket the `supabase` driver writes to. |
| `RUNTIME` | detected | `node` or `serverless`. Only set it for a host neither is guessed correctly on. |
| `REALTIME_STREAM_SECONDS` | `50` | How long one SSE stream lives before inviting a reconnect. |
| `REALTIME_POLL_MS` | `2000` | How often a stream checks for changes where there is no listener. |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Permit webhooks to private addresses. Development only; see [Webhooks](#webhooks). |

Generate a signing secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Running it for a team

The instance is the organisation. A self-hosted deployment does not need a
separate workspace object on top of itself: the people with accounts are the
team, and whoever runs the server owns it.

**Roles.** Owner, admin and member. The first account created becomes the owner.
Owners and admins see the admin console; members only see the boards they have
been added to.

**Registration is invite-only by default.** An instance reachable from the
internet with open registration will collect strangers. Owners can change this
under *Admin → Access* to open registration, or to an allowed-domain list so
anyone with a company email address can join.

**Invitations** are bound to the address they were issued for, expire after
seven days, and can be used once. Only a hash is stored, so a database backup is
not a set of working invitations. There is no mail server on a fresh instance,
so the link is given to you to pass on however you like.

**Revoking access takes effect immediately.** Deactivating an account deletes
its sessions and invalidates its API tokens, so that person is signed out
everywhere at once rather than when a cookie eventually expires.

*Admin → Boards* lists every board on the instance with its owner, member and
card counts, and flags any board that has been made public.

Guardrails: an admin cannot create an owner, nobody can change their own role or
deactivate themselves, and the instance always keeps at least one active owner.

## Migrating from Trello

In Trello, choose *Menu → More → Print and export → Export as JSON*. Then use
**Import** in the Pergola toolbar.

Lists, cards, their order, labels, due dates, descriptions, checklists and
comments all transfer. Cards Trello had archived arrive in the archive rather
than being discarded. Trello's ten label colours map onto the nearest of the six
used here.

Comment authorship cannot transfer, because your Trello colleagues have no
account on your instance. Rather than silently reattributing those comments to
whoever ran the import, each keeps its original author's name in the text. The
importer reports everything it could not carry when it finishes.

## Exporting your data

**Export** on any board downloads a `.pergola.json` file containing lists, cards
and their order, labels, custom fields, checklists, attachments and comments.
**Import** reads it back, into this instance or any other. A test asserts that a
round trip returns the same board in the same order.

Assignees are deliberately not carried across, since accounts belong to an
instance and inventing a mapping would attribute work to the wrong person.

For a full backup, `pg_dump` is sufficient. Everything lives in Postgres except
uploaded files, which are in `STORAGE_DIR`.

## API

Every endpoint the interface uses accepts an `Authorization: Bearer` token as
well as a session cookie. Create one under *Settings → Tokens*; it is shown once
and stored only as a hash.

```bash
# List your boards
curl -H "Authorization: Bearer prg_..." https://your-host/api/boards

# Read a board, including every card
curl -H "Authorization: Bearer prg_..." https://your-host/api/boards/<board-id>

# Change something. Every write goes through this one endpoint.
curl -X POST https://your-host/api/mutations \
  -H "Authorization: Bearer prg_..." \
  -H "content-type: application/json" \
  -d '{
        "id": "<a uuid you generate>",
        "boardId": "<board-id>",
        "body": { "kind": "card.rename", "cardId": "<card-id>", "title": "New title" }
      }'
```

The `id` you supply is an idempotency key. Sending the same mutation twice is a
no-op, so a request that times out can be retried without first checking whether
it landed.

Mutation kinds are defined in `packages/shared/src/mutations.ts`.

## AI assistants (MCP)

Pergola is an [MCP](https://modelcontextprotocol.io) server. Claude Code,
Cursor, VS Code's agent mode and any other MCP client can list your boards,
read cards, create and move them, tick checklists and leave comments — as you,
with your access, and every change logged under your name like any other.

Open any board, *Settings → Tokens → Connect*. It mints a token and shows the
one-liner for each client. For Claude Code — the CLI and the VS Code extension
share one list of servers, and this command is how a server gets onto it (the
"Install in VS Code" link is for GitHub Copilot, which keeps a separate list):

```bash
claude mcp add --transport http --scope user pergola https://your-host/api/mcp \
  --header "Authorization: Bearer prg_..."
```

Then ask it: *"what's on my plate?"*, *"move PRG-12 to Done and say what
you changed"*. The endpoint is `/api/mcp`, Streamable HTTP, stateless, so it
runs on a serverless host as happily as on a container. Revoking the token
disconnects the assistant.

Tools: `list_boards`, `my_cards`, `get_board`, `get_card`, `search_cards`,
`create_card`, `update_card`, `move_card`, `add_comment`, `add_checklist`,
`check_item`, `archive_card`. Cards can be named by key (`PRG-12`) or id,
lists by title, people by `me`, email or name.

## Webhooks

Add an endpoint under *Settings → Webhooks*. Every change on that board is POSTed
to it as JSON, signed with HMAC-SHA256 over `"{timestamp}.{body}"`.

```
x-pergola-event      card.rename
x-pergola-timestamp  1788012386618
x-pergola-signature  9f86d081884c7d65...
```

Verify with `apps/server/src/automation/signature.ts`, which has no dependencies
and can be copied straight into a receiver.

Endpoints must be publicly routable. A URL resolving onto a private network is
rejected, and re-checked on every delivery rather than only when saved, so a
hostname that later points at loopback cannot be used to make the server call
into its own network. A webhook that begins resolving privately is disabled
rather than retried.

## Architecture

```
apps/web         React 19, Vite, dnd-kit           the interface
apps/server      Hono, Drizzle, Postgres           the only write path
packages/shared  Zod schemas, reduce(), ordering   imported by both
```

Worth reading first:

- `apps/server/src/mutations/commit.ts` — the only write path. Authorize, apply,
  append to the log and advance the board's sequence in one transaction, then
  `NOTIFY`.
- `packages/shared/src/state.ts` — a single `reduce(state, mutation)` used by the
  optimistic interface, the socket and offline replay. Pure, and the easiest
  thing here to test.
- `packages/shared/src/order.ts` — fractional indexing. Moving a card writes one
  row and reads two, whatever the length of the list.
- `apps/server/src/realtime/bus.ts` — fan-out over Postgres `LISTEN`/`NOTIFY`, so
  multiple application replicas need no Redis.
- `apps/server/src/app.ts` — the app, with no side effects, so the same routes
  are served by `index.ts` (one long-lived process, a port, a socket) and by
  `api/` on a serverless host. `runtime.ts` is the only place that knows which.
- `apps/server/src/auth/guard.ts` — one capability table, checked in one
  middleware.
- `apps/server/src/automation/engine.ts` — automation rules, which produce
  ordinary mutations and so inherit logging, undo and live sync.

![Card detail](docs/img/card.jpg)

## Development

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev                      # server on :3000, client on :5173
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Server and client with hot reload |
| `pnpm build` | Build shared, then the client, then the server |
| `pnpm -r typecheck` | Typecheck every package |
| `pnpm --filter @pergola/shared test` | Ordering and reducer tests |
| `pnpm --filter @pergola/server test` | Storage, signing and schema tests |
| `pnpm --filter @pergola/server check` | End-to-end checks against a running server |
| `pnpm db:generate` | Generate a migration after changing the schema |

The end-to-end suite covers live sync, undo, roles, search, import and export,
automation, webhooks, tokens, notifications, file uploads, public boards and
instance administration. CI runs all of it plus a production build.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. The short
version: every change to a board goes through the mutation log, and nothing
bypasses `commit()`.

## Project status

Usable. The features listed above are implemented and covered by tests.

Not yet done: email delivery, so notifications are in-app only; scheduled
automation triggers such as "due tomorrow"; and translations, since strings are
currently inline rather than extracted.

## Licence

Not yet chosen. Until a licence file is added, default copyright applies and this
code is not licensed for reuse. If you would like to use it, please open an issue.
