import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { env } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

/**
 * Migrations run at boot. The advisory lock means N replicas starting at the same
 * moment produce one migration run and N-1 waiters, instead of a race that can
 * leave the schema half-applied. Cheap insurance against an unrecoverable failure.
 */
export async function runMigrations(): Promise<void> {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const db = drizzle(client);
  try {
    await db.execute(sql`SELECT pg_advisory_lock(hashtext('pergola_migrate'))`);
    await migrate(db, { migrationsFolder });
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('pergola_migrate'))`);
    await client.end();
  }
}

// `pnpm db:migrate` runs this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("migrations applied");
  process.exit(0);
}
