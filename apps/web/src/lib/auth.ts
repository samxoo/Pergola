import { createAuthClient } from "better-auth/react";

/**
 * Same-origin in every deployment — the server serves this client, and Vite
 * proxies /api in development — so there is no base URL to configure.
 *
 * Exported whole rather than destructured: re-exporting the individual members
 * makes TypeScript try to name Better Auth's internal inference types, which it
 * cannot do portably across the workspace.
 */
export const authClient = createAuthClient();
