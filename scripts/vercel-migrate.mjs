import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Apply migrations as part of a deploy, rather than at boot.
 *
 * A long-lived server migrates when it starts — one process, one clear place for
 * it to happen. A serverless deployment has no boot: doing it on cold start
 * would mean N functions racing over the same schema, several times a day,
 * forever. So the deploy does it once instead.
 *
 * Off for preview builds unless asked. A preview branch usually points at the
 * production database, and a half-finished migration from a feature branch is
 * not something to apply by accident — set RUN_MIGRATIONS=1 when that is
 * genuinely what you want.
 */
const asked = process.env.RUN_MIGRATIONS;
const shouldRun =
  asked === "1" || asked === "true"
    ? true
    : asked === "0" || asked === "false"
      ? false
      : process.env.VERCEL_ENV === "production";

if (!shouldRun) {
  console.log(
    `[migrate] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}). Set RUN_MIGRATIONS=1 to apply.`,
  );
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("[migrate] DATABASE_URL is not set in the build environment.");
  process.exit(1);
}

const entry = "apps/server/dist/db/migrate.js";
if (!existsSync(entry)) {
  console.error(`[migrate] ${entry} is missing — the server build did not run.`);
  process.exit(1);
}

const { status } = spawnSync(process.execPath, [entry], { stdio: "inherit" });
process.exit(status ?? 1);
