export { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } from "../apps/server/dist/vercel.js";

/**
 * The serverless deployment.
 *
 * Vercel rewrites every /api path to this one file (see vercel.json), and Hono
 * does the rest — the same app object the container serves, so the two
 * deployments cannot answer a request differently. What is missing is only what
 * a function cannot do: no port is bound, no WebSocket is upgraded, and no
 * migration runs at boot; the build does that once instead of every cold start.
 *
 * One export per HTTP method rather than a default export, because that is what
 * makes the platform hand over a web-standard Request with its body intact.
 * See apps/server/src/vercel.ts.
 *
 * It re-exports compiled output rather than importing source, so the function
 * bundler only ever traces plain JavaScript and resolves every dependency from
 * the package that declares it. `pnpm vercel-build` produces it.
 */
