import { app } from "./app.js";

/**
 * The app as a serverless function.
 *
 * Exported as one function per HTTP method, taking a `Request` and returning a
 * `Response`. That is not decoration — it is what selects the platform's
 * web-standard calling convention, and the alternative silently breaks writes:
 * a default-exported `(req, res)` handler gets Node objects whose body the
 * runtime has already parsed for you, so reading it as a stream waits for an
 * `end` that has been and gone. GET works, every POST hangs until the function
 * times out, and nothing is logged. Measured, on a deployment that did exactly
 * that.
 *
 * Streaming still works on this path, which is what the SSE route needs: a
 * Response carrying a ReadableStream is streamed to the client.
 */
async function respond(request: Request): Promise<Response> {
  return app.fetch(restore(request));
}

/**
 * Put the requested path back.
 *
 * File-system routing in a bare `api/` directory matches one path segment and
 * no more, so /api/boards reached this function and /api/auth/sign-in/email
 * answered 404 from the edge before any of our code ran. vercel.json therefore
 * rewrites every /api path here and carries the original in `__path`, which is
 * undone before Hono sees the request — so routing happens on the URL the
 * client actually asked for, and the app knows nothing about the arrangement.
 *
 * Anything else in the query string belongs to the caller and is preserved.
 */
function restore(request: Request): Request {
  const url = new URL(request.url);
  const original = url.searchParams.get("__path");
  if (original === null) return request;

  url.searchParams.delete("__path");
  const path = original.startsWith("/") ? original : `/${original}`;
  url.pathname = path === "/" ? "/api" : `/api${path}`;
  // Rebuilt from the original, so method, headers and body all ride along.
  return new Request(url, request);
}

export const GET = respond;
export const POST = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const HEAD = respond;
export const OPTIONS = respond;
