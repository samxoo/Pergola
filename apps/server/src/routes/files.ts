import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { attachment, card } from "../db/schema.js";
import {
  actorOf,
  authorizeRead,
  authorizeWrite,
  requireUser,
  type Env,
} from "../auth/guard.js";
import { commit } from "../mutations/commit.js";
import { createStorage } from "../storage/adapter.js";

const storage = createStorage();

/** Big enough for a design mock or a PDF, small enough to hold in memory. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Multipart framing around the file: boundaries, part headers, the filename. */
const ENVELOPE = 64 * 1024;

/** The prefix that marks an attachment as ours rather than someone's link. */
const FILE_URL = "/api/files/";

/**
 * The name is the caller's, and it is headed for a page and for a header.
 * Browsers on some platforms send a full path, and a control character in a
 * name breaks header parsing and log lines alike. Take the last segment, drop
 * the characters that are not text, and cap it.
 */
function displayName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, 200) || "file";
}

/**
 * `inline`, so an image opens in the card instead of landing in Downloads — but
 * the name still has to survive a header, where an unescaped quote ends the
 * quoted string early and turns the rest of the filename into parameters. The
 * ASCII form is the fallback; the RFC 5987 form carries the real name.
 */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Types a browser will execute in our own origin the moment it renders them.
 * HTML runs script outright; SVG and XML are HTML wearing a hat — an inline
 * <script>, an `xml-stylesheet`, an event handler on a <rect>. Anyone who can
 * upload to a board could otherwise hand a colleague a same-origin link that
 * runs as them, session cookie attached, and no amount of care elsewhere in the
 * app would matter. Everything in this family is served as a download instead.
 */
const EXECUTES_HERE = new Set([
  "text/html",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Clamp on the way out, not on the way in, so the stored type stays the truth.
 *
 * Returns the type to serve and, for SVG, a Content-Security-Policy. SVG is an
 * image and previews in an `<img>`, where scripts never run — but a direct
 * navigation to the file would run them in our origin. The sandbox CSP closes
 * exactly that case (no script, no outbound fetch), so a preview costs nothing.
 */
function serveAs(stored: string): { type: string; csp?: string } {
  const type = stored.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!MIME.test(type)) return { type: "application/octet-stream" };
  if (type === "image/svg+xml") {
    return { type, csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  }
  // The rest of the executable family — HTML, JS, non-image XML (`+xml` catches
  // xhtml and every future dialect) — is still handed back as a download.
  if (EXECUTES_HERE.has(type) || type.endsWith("+xml")) return { type: "application/octet-stream" };
  return { type };
}

export const files = new Hono<Env>()
  .use("*", requireUser)

  /* -------------------------------------------------------------- upload */

  .post("/cards/:cardId/files", async (c) => {
    const cardId = c.req.param("cardId");
    if (!z.uuid().safeParse(cardId).success) {
      return c.json({ message: "Not a card id" }, 400);
    }

    // `parseBody` buffers the entire request before anything can measure it, so
    // an obviously oversized upload is refused on its declared length first. A
    // client that sends no Content-Length is still caught below, just later and
    // more expensively.
    if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES + ENVELOPE) {
      return c.json({ message: "That file is larger than 10 MB" }, 413);
    }

    const [target] = await db
      .select({ boardId: card.boardId })
      .from(card)
      .where(eq(card.id, cardId))
      .limit(1);
    if (!target) return c.json({ message: "No card at that id" }, 404);

    // Authorisation before the bytes: an upload from someone with no business on
    // this board should cost a query, not ten megabytes of memory. The check is
    // the write capability, not a bare read, so an observer — invited precisely
    // because they cannot change the board — cannot write through this door.
    await authorizeWrite(target.boardId, actorOf(c), "attachment.add");

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ message: "Send the file as multipart/form-data" }, 400);
    }

    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ message: 'Attach the file as a form field named "file"' }, 400);
    }
    if (file.size === 0) return c.json({ message: "That file is empty" }, 400);
    if (file.size > MAX_BYTES) {
      return c.json({ message: "That file is larger than 10 MB" }, 413);
    }

    // One identifier used twice. The attachment table has no column for a
    // storage key, and a second id could only ever drift from the first.
    const key = randomUUID();
    const data = Buffer.from(await file.arrayBuffer());
    const stored = await storage.put(key, data, file.type || "application/octet-stream");

    /*
     * The row goes in through the mutation log, not a bare insert.
     *
     * A bare insert was how this worked at first, and it is why an upload used
     * to show up for the person who made it and for nobody else: the live
     * connection carries the mutation log and nothing besides, so a row written
     * around it never reached another screen until that person reloaded. Going
     * through commit() appends the record, bumps the board's cursor and fires
     * the notification, so everyone watching the board is handed the file the
     * same way they are handed a moved card — and it turns up in the activity
     * feed, and undo knows about it.
     */
    const url = `${FILE_URL}${key}`;
    const name = displayName(file.name);
    try {
      const record = await commit(
        {
          id: randomUUID(),
          boardId: target.boardId,
          body: { kind: "attachment.add", attachmentId: key, cardId, url, name },
        },
        actorOf(c).id,
      );

      return c.json(
        {
          id: key,
          cardId,
          url,
          name,
          size: stored.size,
          contentType: stored.contentType,
          createdAt: record.createdAt,
          /** The change as the board will see it, so the client can apply it directly. */
          mutation: record,
        },
        201,
      );
    } catch (err) {
      // A row that never landed leaves bytes nothing will ever reference again.
      await storage.delete(key).catch(() => {});
      throw err;
    }
  })

  /* ---------------------------------------------------------------- serve */

  .get("/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) {
      return c.json({ message: "Not a file id" }, 400);
    }

    // The board comes from the card the attachment hangs off. There is no other
    // path to it, and no request may name its own board.
    const [row] = await db
      .select({ name: attachment.name, url: attachment.url, boardId: card.boardId })
      .from(attachment)
      .innerJoin(card, eq(card.id, attachment.cardId))
      .where(eq(attachment.id, id))
      .limit(1);
    if (!row) return c.json({ message: "No file at that id" }, 404);
    if (!row.url.startsWith(FILE_URL)) {
      return c.json({ message: "That attachment is a link, not an uploaded file" }, 404);
    }

    await authorizeRead(row.boardId, actorOf(c));

    const stored = await storage.get(id);
    if (!stored) return c.json({ message: "That file is no longer in storage" }, 404);

    const served = serveAs(stored.contentType);
    return c.body(Readable.toWeb(Readable.from(stored.stream)), 200, {
      "Content-Type": served.type,
      ...(served.csp ? { "Content-Security-Policy": served.csp } : {}),
      "Content-Length": String(stored.size),
      "Content-Disposition": disposition(row.name),
      // Without this a browser sniffs the bytes and may conclude a text file
      // full of markup was HTML all along, undoing the line above it.
      "X-Content-Type-Options": "nosniff",
      // `private`, because the response was authorised and no shared cache may
      // keep it. Immutable, because the key is a UUID and the bytes under it
      // never change.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  })

  /* --------------------------------------------------------------- delete */

  .delete("/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) {
      return c.json({ message: "Not a file id" }, 400);
    }

    const [row] = await db
      .select({ url: attachment.url, boardId: card.boardId })
      .from(attachment)
      .innerJoin(card, eq(card.id, attachment.cardId))
      .where(eq(attachment.id, id))
      .limit(1);
    // Nothing to delete and nothing to authorise against. Answering 204 matches
    // the other delete endpoints and tells an unauthenticated guesser nothing.
    if (!row) return c.body(null, 204);
    if (!row.url.startsWith(FILE_URL)) {
      return c.json({ message: "That attachment is a link, not an uploaded file" }, 404);
    }

    await authorizeWrite(row.boardId, actorOf(c), "attachment.remove");

    // Row first, and through the log, so every open board sees it go. Orphaned
    // bytes waste a few kilobytes on a volume; an attachment pointing at bytes
    // that are gone is a broken link in somebody's card.
    await commit(
      {
        id: randomUUID(),
        boardId: row.boardId,
        body: { kind: "attachment.remove", attachmentId: id },
      },
      actorOf(c).id,
    );
    await storage.delete(id);
    return c.body(null, 204);
  });
