import { app } from "../apps/server/dist/app.js";

/**
 * The serverless deployment.
 *
 * Vercel routes every /api/* path to this one file, and Hono does the rest — the
 * same app object the container serves, so the two deployments cannot answer a
 * request differently. What is missing here is only what a function cannot do:
 * no port is bound, no WebSocket is upgraded, and no migration runs (the build
 * does that once, rather than every cold start).
 *
 * The filename is a catch-all — `[...route]` — because that is what Vercel's
 * own file-system routing understands in an `api/` directory. The doubled
 * `[[...route]]` form is a Next.js convention, and a project that is not Next
 * quietly ends up with a function nothing routes to.
 *
 * A one-argument function on purpose: that is the signature the platform reads
 * as a Web handler, taking a Request and returning a Response. Passing
 * `app.fetch` itself would leave that to the arity of somebody else's function.
 *
 * It imports the compiled output rather than the TypeScript source, so the
 * function bundler only ever traces plain JavaScript and resolves dependencies
 * from the server package that declares them. `pnpm vercel-build` produces it;
 * see vercel.json.
 */
export default (request: Request) => app.fetch(request);
