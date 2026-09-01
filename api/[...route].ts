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
 * The filename is a catch-all — `[...route]` — because that is what Vercel's
 * file-system routing understands in an `api/` directory. The doubled
 * `[[...route]]` form is a Next.js convention, and a project that is not Next
 * ends up with a function that only shallow paths reach.
 *
 * It re-exports the compiled output rather than importing source, so the
 * function bundler only ever traces plain JavaScript and resolves every
 * dependency from the package that declares it. `pnpm vercel-build` produces
 * it; see vercel.json.
 */
