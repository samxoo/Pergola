import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { MutationEnvelope, MutationRecord } from "@pergola/shared";
import { db, type Tx } from "../db/index.js";
import { board, mutation } from "../db/schema.js";
import { handlers } from "./handlers.js";

/**
 * The only write path in the system.
 *
 * Authorize, apply, append and bump the board's sequence — all in one
 * transaction, so a failure anywhere rolls the whole thing back and no client
 * ever observes a half-applied change.
 */
export async function commit(
  env: MutationEnvelope,
  actorId: string | null,
  ruleId: string | null = null,
): Promise<MutationRecord> {
  const [record] = await commitAll([env], actorId, ruleId);
  return record!;
}

/**
 * Several mutations as one change.
 *
 * One transaction, one row lock, one notification: either every envelope lands
 * or none does. That is what lets a caller change three fields on a card without
 * the second one failing and leaving the first behind. Envelopes must name the
 * same board — the per-board lock is what serialises writers, and taking two
 * boards' locks in caller-chosen order is how deadlocks start.
 */
export async function commitAll(
  envs: readonly MutationEnvelope[],
  actorId: string | null,
  ruleId: string | null = null,
): Promise<MutationRecord[]> {
  if (envs.length === 0) return [];
  const boardId = envs[0]!.boardId;
  if (envs.some((e) => e.boardId !== boardId)) {
    throw new Error("A batch must stay on one board");
  }

  try {
    return await db.transaction(async (tx) => {
      const out: MutationRecord[] = [];
      let last: number | null = null;
      for (const env of envs) {
        const applied = await applyOne(tx, env, actorId, ruleId);
        out.push(applied.record);
        if (applied.fresh) last = applied.record.seq;
      }
      // NOTIFY fires on commit, not on statement — so a listener can never
      // observe a change that later rolls back. The payload carries only the
      // cursor: subscribers fetch everything after theirs, so one notification
      // for the whole batch is exact. It is capped at 8000 bytes anyway.
      if (last !== null) {
        await tx.execute(
          sql`SELECT pg_notify('board_changed', ${JSON.stringify({ boardId, seq: last })})`,
        );
      }
      return out;
    });
  } catch (err) {
    // Two identical requests raced: the other one won the insert after this
    // one had already applied the handler. Its work is rolled back with the
    // transaction, and the answer is the row that did land.
    if (err instanceof AlreadyApplied) return commitAll(envs, actorId, ruleId);
    throw err;
  }
}

/** Thrown inside the transaction to undo a handler that a concurrent twin beat. */
class AlreadyApplied extends Error {}

/**
 * Apply one envelope inside an open transaction.
 *
 * The id check comes *before* the handler runs. An idempotency key that is only
 * honoured on insert is not one: by then the handler has already changed rows,
 * and for a `card.create` replay that is a duplicate primary key — a 500 where
 * the caller was promised a no-op. Looking first is what makes a retry after a
 * timeout genuinely free, for every kind and not only the ones that happen to
 * be harmless twice.
 */
async function applyOne(
  tx: Tx,
  env: MutationEnvelope,
  actorId: string | null,
  ruleId: string | null,
): Promise<{ record: MutationRecord; fresh: boolean }> {
  const [existing] = await tx
    .select()
    .from(mutation)
    .where(eq(mutation.id, env.id))
    .limit(1);
  if (existing) return { record: toRecord(existing), fresh: false };

  const seq = await nextSeq(tx, env.boardId);

  // The handler mutates rows and hands back the mutation that undoes it.
  const handler = handlers[env.body.kind] as (
    tx: Tx,
    boardId: string,
    body: typeof env.body,
    actorId: string | null,
  ) => Promise<MutationRecord["inverse"]>;
  const inverse = await handler(tx, env.boardId, env.body, actorId);

  const [row] = await tx
    .insert(mutation)
    .values({
      id: env.id,
      boardId: env.boardId,
      seq,
      actorId,
      kind: env.body.kind,
      payload: env.body,
      inverse,
      ruleId,
    })
    .onConflictDoNothing({ target: mutation.id })
    .returning();

  if (!row) throw new AlreadyApplied();
  return { record: toRecord(row), fresh: true };
}

/**
 * Allocate the next per-board sequence.
 *
 * UPDATE ... RETURNING takes a row lock, so concurrent writers to the *same*
 * board serialise here and nowhere else. Different boards never contend, which
 * is the axis that actually grows.
 */
async function nextSeq(tx: Tx, boardId: string): Promise<number> {
  const [row] = await tx
    .update(board)
    .set({ seq: sql`${board.seq} + 1` })
    .where(eq(board.id, boardId))
    .returning({ seq: board.seq });
  if (!row) throw new Error(`No board ${boardId}`);
  return row.seq;
}

/** Everything a client is missing, in order. The entire sync protocol. */
export async function since(boardId: string, cursor: number): Promise<MutationRecord[]> {
  const rows = await db
    .select()
    .from(mutation)
    .where(and(eq(mutation.boardId, boardId), gt(mutation.seq, cursor)))
    .orderBy(asc(mutation.seq))
    .limit(500);
  return rows.map(toRecord);
}

function toRecord(row: typeof mutation.$inferSelect): MutationRecord {
  return {
    id: row.id,
    boardId: row.boardId,
    seq: row.seq,
    actorId: row.actorId,
    body: row.payload,
    inverse: row.inverse,
    ruleId: row.ruleId,
    createdAt: row.createdAt.toISOString(),
  };
}
