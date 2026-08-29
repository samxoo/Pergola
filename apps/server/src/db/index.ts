import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
/** A transaction handle. Every mutation handler takes one of these, never `db`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
