import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/index.js";
import { env } from "./env.js";
import * as authSchema from "./db/auth-schema.js";

/**
 * Authentication.
 *
 * Password hashing, session rotation and invite tokens are a solved problem with
 * a very bad failure mode, so Better Auth owns them and their tables. Everything
 * about *boards* stays ours.
 *
 * Email and password only, deliberately. A self-hosted instance should not
 * require registering an OAuth app before anyone can sign in; providers are one
 * config block away whenever the operator wants them.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),

  /**
   * Instance roles.
   *
   * The instance IS the company — a self-hosted box does not need a separate
   * organisation object on top of itself. The first account to exist becomes the
   * owner; everyone after that is a member until an owner says otherwise.
   */
  user: {
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "member", input: false },
      deactivatedAt: { type: "date", required: false, input: false },
    },
  },

  emailAndPassword: {
    enabled: true,
    // No mail server is configured on a fresh self-hosted box, and an
    // unverifiable account is worse than an unverified one.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most daily
  },

  advanced: {
    // Same-origin in every deployment: the server serves the client.
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
  },

  /**
   * Where sign-in requests are allowed to come from.
   *
   * Derived from configuration, never hardcoded: a self-hosted instance runs on
   * whatever host and port its operator chose, and a fixed list locks everyone
   * who is not on localhost:3000 out of their own install.
   */
  trustedOrigins: [
    env.BETTER_AUTH_URL,
    ...(env.NODE_ENV === "development" ? ["http://localhost:5173"] : []),
    ...env.TRUSTED_ORIGINS,
  ],
});

export type Session = typeof auth.$Infer.Session;
