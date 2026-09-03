import { Hono } from "hono";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { actorFromToken, type Actor } from "../auth/guard.js";
import { buildServer } from "./server.js";

/**
 * The MCP endpoint: Pergola as a set of tools for an AI assistant.
 *
 * Streamable HTTP, stateless — one request, one answer, no session to hold —
 * which is what lets the same code answer from a long-lived server and from a
 * function woken per request. The assistant proves who it is with an ordinary
 * API token, so it acts *as that person*: it sees the boards they see, every
 * change it makes is logged under their name, and revoking the token ends it.
 */
const handler = createMcpHandler(
  (ctx) => {
    const actor = (ctx.authInfo?.extra as { actor?: Actor } | undefined)?.actor;
    // The route below never calls in without one; this is belt and braces.
    if (!actor) throw new Error("MCP request without an authenticated actor");
    return buildServer(actor);
  },
  { onerror: (err) => console.error("[mcp]", err) },
);

const CHALLENGE =
  'Bearer realm="pergola", error="invalid_token", ' +
  'error_description="Send a Pergola API token: Authorization: Bearer prg_..."';

export const mcp = new Hono().all("/mcp", async (c) => {
  const actor = await actorFromToken(c.req.header("authorization"));
  if (!actor) {
    return c.json(
      {
        message:
          "This is Pergola's MCP endpoint. Connect with an API token from Settings → Tokens, " +
          "sent as an Authorization: Bearer header.",
      },
      401,
      { "WWW-Authenticate": CHALLENGE },
    );
  }
  const authInfo: AuthInfo = {
    token: "",
    clientId: actor.id,
    scopes: ["pergola"],
    extra: { actor },
  };
  return handler.fetch(c.req.raw, { authInfo });
});
