import { z } from "zod";
import { isServerless } from "./runtime.js";

const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * Only needed when DATABASE_URL points at a transaction-mode pooler.
   * See `isPooled` below — this is the single most likely misconfiguration in
   * the whole project, so it is checked loudly at boot rather than failing quietly.
   */
  DATABASE_DIRECT_URL: z.string().optional(),
  /** Signs session cookies. An instance that changes this signs everyone out. */
  BETTER_AUTH_SECRET: z.string().min(16, "must be at least 16 characters"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  /** Extra origins allowed to sign in — a reverse proxy hostname, say. */
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  /**
   * Let webhooks reach private addresses.
   *
   * Off by default and meant only for a development box or a test run, where the
   * receiving endpoint is on localhost. Leaving it on in production hands anyone
   * who can add a webhook a way to make the server call into its own network.
   */
  WEBHOOK_ALLOW_PRIVATE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

/**
 * What the platform already knows.
 *
 * A deployment's own URL is the one setting an operator cannot know before the
 * first deploy, and getting it wrong locks everyone out of sign-in with a CSRF
 * rejection that names nothing. Where the host tells us — Vercel does — we use
 * it, and an explicitly configured value still wins.
 *
 *   VERCEL_PROJECT_PRODUCTION_URL  the stable domain, so it is a sane default
 *   VERCEL_URL                     this exact deployment, so preview builds can
 *                                  be signed into as well as production
 */
const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
const deploymentUrl = process.env.VERCEL_URL?.trim();

const parsed = Env.safeParse({
  ...process.env,
  BETTER_AUTH_URL:
    process.env.BETTER_AUTH_URL?.trim() || (productionUrl ? `https://${productionUrl}` : undefined),
  TRUSTED_ORIGINS: [process.env.TRUSTED_ORIGINS, deploymentUrl && `https://${deploymentUrl}`]
    .filter(Boolean)
    .join(","),
});

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Configuration problem:\n\n${problems}\n`);
  /*
   * A process that owns its own lifetime exits, so a container restarts into the
   * same clear message instead of serving errors. A function invocation does not
   * own the process it is running in — exiting there kills the instance with no
   * response and no log line anybody can act on, so it throws and lets the
   * platform surface it.
   */
  if (isServerless) throw new Error(`Configuration problem:\n${problems}`);
  console.error('Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

export const env = parsed.data;

/**
 * A transaction-mode pooler hands the session back to the pool between
 * statements, so a LISTEN registered on it receives nothing — writes and reads
 * keep working while realtime silently does nothing. Supabase's pooler runs on
 * 6543; pgBouncer conventionally on 6432.
 */
const isPooled =
  /:6543\//.test(env.DATABASE_URL) ||
  /:6432\//.test(env.DATABASE_URL) ||
  /pooler\./.test(env.DATABASE_URL);

/** The connection the realtime listener must use. */
export const listenUrl = env.DATABASE_DIRECT_URL ?? env.DATABASE_URL;

export const realtimeMode: "listen" | "poll" =
  isPooled && !env.DATABASE_DIRECT_URL ? "poll" : "listen";

export function warnIfDegraded(): void {
  if (env.WEBHOOK_ALLOW_PRIVATE) {
    console.warn(
      [
        "",
        "  WEBHOOK_ALLOW_PRIVATE is on: webhooks may point at private and loopback",
        "  addresses. That is fine on a development box and wrong on a real one —",
        "  it lets anyone who can add a webhook reach this server's own network.",
        "",
      ].join("\n"),
    );
  }

  // Only a long-lived process holds a LISTEN connection; on a serverless host
  // every stream polls by design, so this would be a warning about nothing.
  if (realtimeMode === "poll" && !isServerless) {
    console.warn(
      [
        "",
        "  DATABASE_URL looks like a connection pooler, and DATABASE_DIRECT_URL is not set.",
        "  LISTEN/NOTIFY does not survive a transaction-mode pooler, so live updates would",
        "  never arrive. Falling back to polling every 2s.",
        "",
        "  To get real-time back, set DATABASE_DIRECT_URL to the direct connection",
        "  (Supabase: the :5432 host, not the :6543 pooler).",
        "",
      ].join("\n"),
    );
  }
}
