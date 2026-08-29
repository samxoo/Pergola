# Contributing

## Getting it running

```bash
pnpm install
cp .env.example .env          # point DATABASE_URL at a Postgres you can reach
pnpm db:migrate
pnpm dev                      # server :3000, client :5173
```

`pnpm dev` runs a watcher on `packages/shared` too. If you run the apps
individually, build shared first — the apps import its emitted `.js`, not its
source:

```bash
pnpm --filter @pergola/shared build
```

## Before you open a pull request

```bash
pnpm -r typecheck
pnpm --filter @pergola/shared test
pnpm --filter @pergola/server exec tsx src/e2e-check.ts   # needs the server running
```

CI runs all three plus a production build.

## The one rule

**Every change to a board goes through the mutation log.** No handler writes to
a table directly, and nothing bypasses `commit()`. That single write path is
what makes live sync, undo, the activity feed and offline replay work — and any
one of them breaks silently if a write sneaks past it.

Adding a new kind of change means:

1. A Zod schema in `packages/shared/src/mutations.ts`, added to the union.
2. A case in `reduce()` in `packages/shared/src/state.ts`.
3. A handler in `apps/server/src/mutations/handlers.ts` that returns the mutation
   which undoes it — or `null`, honestly, if it cascades and cannot be undone.
4. The capability in `apps/server/src/auth/guard.ts`, or nobody can perform it.
5. A line in `describe()`, or it shows up blank in the activity feed.

TypeScript enforces 1–3: the discriminated union makes a missing case a compile
error. It cannot enforce 4 and 5, so those are on you and on review.

## Things worth knowing

- **Ordering keys are never jittered.** Appending random characters to a
  fractional index can push a key past its upper bound; ties break on `id`
  instead. There is a test for this, and it was a real bug.
- **Deletes that cascade return `null` for their inverse.** Restoring a card
  would not bring back its comments, so pretending otherwise is worse than
  admitting it. `card.archive` is the reversible action the UI offers.
- **The board caps how many cards it renders per list** (60, with a "show more").
  Rendering 400 makes a filter keystroke take 254 ms instead of 51 ms.
- **`LISTEN`/`NOTIFY` does not survive a connection pooler.** If you point
  `DATABASE_URL` at one, set `DATABASE_DIRECT_URL` too.

## Style

Match the file you are in. Comments explain *why*, not what — if a line needs a
comment to say what it does, rewrite the line.
