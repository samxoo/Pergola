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
  return db.transaction(async (tx) => {
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
      // Replay of an offline queue, or a retry after a timeout, lands here and
      // does nothing. That is what makes a network timeout unambiguous.
      .onConflictDoNothing({ target: mutation.id })
      .returning();

    if (!row) {
      // Already applied under this id. Return the row that is already there so
      // the caller still gets a coherent answer.
      const [existing] = await tx
        .select()
        .from(mutation)
        .where(eq(mutation.id, env.id))
        .limit(1);
      return toRecord(existing!);
    }

    // NOTIFY fires on commit, not on statement — so a listener can never observe
    // a change that later rolls back. The payload carries only the cursor; it is
    // capped at 8000 bytes and the rows are the source of truth anyway.
    await tx.execute(
      sql`SELECT pg_notify('board_changed', ${JSON.stringify({
        boardId: env.boardId,
        seq,
      })})`,
    );

    return toRecord(row);
  });
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
