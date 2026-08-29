import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Storage } from "./adapter.js";

/**
 * Files on a disk.
 *
 * The default driver, because a self-hosted instance should need nothing beyond
 * a volume: no bucket, no credentials, no second service to remember to back up.
 */

/** Bytes and their content type sit side by side: `ab/abcd…` and `ab/abcd….type`. */
const META = ".type";

/**
 * Turn a key into a path that cannot leave the root.
 *
 * ─────────────── The single most important thing in this file. ───────────────
 *
 * Keys are caller-influenced, and a key is about to become a filesystem path.
 * `../../../etc/passwd` reads and writes outside the volume. A leading `/` makes
 * `resolve` throw the root away entirely. A `\0` truncates the string down in
 * the syscall layer, so any check that looked at the tail of it never happened.
 * None of these are exotic; they are the first three things anyone tries.
 *
 * So there are two defences for the one problem. An allowlist on the way in —
 * an alphabet with no separators, no null, and a first character that cannot be
 * a dot, which kills `.`, `..` and `.ssh` before `..` is even considered. Then
 * the resolved path is measured against the root again on the way out. The
 * duplication is deliberate: the regex is what a later refactor is most likely
 * to loosen, and the second check is what still holds when it does.
 *
 * Nothing here follows a symlink out, because nothing but this driver ever
 * writes into the root — keep it that way.
 */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function pathFor(root: string, key: string): string {
  if (!KEY.test(key) || key.includes("..")) {
    throw new Error(`Storage key is not a plain name: ${JSON.stringify(key.slice(0, 40))}`);
  }

  // Sharded on the first two characters. One directory holding a hundred
  // thousand files is slow to list and slower still to back up.
  const full = resolve(root, key.slice(0, 2), key);

  const rel = relative(root, full);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Storage key resolves outside the storage root");
  }
  return full;
}

/** ENOENT and ENOTDIR mean "no such object". Anything else is a real fault. */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function createLocalStorage(): Storage {
  // Absolute up front: a relative root would follow the process's working
  // directory, and `pnpm dev` and `pnpm start` do not run from the same one.
  const root = resolve(process.env.STORAGE_DIR ?? "./data/uploads");

  return {
    async put(key, data, contentType) {
      const full = pathFor(root, key);
      // Recursive, so this creates the root itself on the first upload and
      // costs a no-op syscall on every one after it.
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
      // A sidecar rather than a column: the attachment table has nowhere to put
      // a content type, and a driver that demands a schema change to be swapped
      // in is not a driver. S3 carries the same value as object metadata.
      await writeFile(full + META, contentType);
      return { key, size: data.byteLength, contentType };
    },

    async get(key) {
      const full = pathFor(root, key);

      let size: number;
      try {
        const info = await stat(full);
        if (!info.isFile()) return null;
        size = info.size;
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }

      // A crash between the two writes above leaves bytes with no sidecar. That
      // is the safe direction to fail in — the caller gets a download, not a
      // guess at what the bytes are.
      const declared = await readFile(full + META, "utf8").catch(() => "");
      return {
        stream: createReadStream(full),
        contentType: declared.trim() || "application/octet-stream",
        size,
      };
    },

    async delete(key) {
      const full = pathFor(root, key);
      // `force` is what makes this idempotent: bytes that were already gone are
      // the outcome the caller asked for.
      await rm(full, { force: true });
      await rm(full + META, { force: true });
    },
  };
}
