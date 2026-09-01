import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import { isServerless } from "../runtime.js";
import * as schema from "./schema.js";

/**
 * One pool per process — and how big it should be depends entirely on how many
 * processes there are.
 *
 * A container is one process serving everybody, so ten connections is a
 * sensible ceiling shared across every request. A serverless deployment is the
 * opposite shape: many short-lived instances, each with its own pool, all
 * pointing at the same database. Ten apiece is how a quiet afternoon exhausts
 * Postgres' connection limit and every request starts failing at once — so keep
 * it small there and let the platform's own pooler do the multiplexing, which
 * is what it is for.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: isServerless ? 3 : 10,
  // A frozen instance holding an idle connection is holding it for nothing.
  ...(isServerless ? { idleTimeoutMillis: 10_000, allowExitOnIdle: true } : {}),
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
/** A transaction handle. Every mutation handler takes one of these, never `db`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
