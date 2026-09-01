export { default } from "../apps/server/dist/vercel.js";

/**
 * The serverless deployment.
 *
 * Vercel routes every /api/* path here, and Hono does the rest — the same app
 * object the container serves, so the two deployments cannot answer a request
 * differently. What is missing is only what a function cannot do: no port is
 * bound, no WebSocket is upgraded, and no migration runs at boot (the build
 * does that once instead of every cold start).
 *
 * One plain filename, and vercel.json rewrites every /api path to it. Not a
 * catch-all: file-system routing in a bare `api/` directory matches a single
 * segment and nothing deeper, so `[...route].ts` served /api/boards and left
 * /api/auth/sign-in/email answering 404 from the edge — measured, after both
 * bracket spellings behaved the same way. The rewrite carries the real path in
 * `__path`, which src/vercel.ts puts back before Hono ever sees the request.
 *
 * It re-exports the compiled output rather than importing source, so the
 * function bundler only ever traces plain JavaScript and resolves every
 * dependency from the package that declares it. `pnpm vercel-build` produces
 * it; see vercel.json.
 */
