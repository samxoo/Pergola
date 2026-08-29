import { z } from "zod";

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

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuration problem:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nCopy .env.example to .env and fill it in.\n");
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

  if (realtimeMode === "poll") {
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
