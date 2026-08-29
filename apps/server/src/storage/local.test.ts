import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalStorage } from "./local.js";

process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "pergola-store-"));
const store = createLocalStorage();

test("a key cannot escape the storage root", async () => {
  const attacks = [
    "../../../etc/passwd",
    "..",
    "../x",
    "/etc/passwd",
    "a/../../b",
    ".ssh",
    "x\0.png",
    "..%2f..%2fetc",
    "",
  ];
  for (const key of attacks) {
    await assert.rejects(
      () => store.put(key, Buffer.from("x"), "text/plain"),
      `expected ${JSON.stringify(key)} to be refused`,
    );
  }
});

test("an ordinary key round-trips", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  await store.put(key, Buffer.from("hello"), "text/plain");
  const got = await store.get(key);
  assert.ok(got, "stored file should come back");
  const chunks: Buffer[] = [];
  for await (const chunk of got.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "hello");
  assert.equal(got.contentType, "text/plain");

  await store.delete(key);
  assert.equal(await store.get(key), null, "a deleted file is gone");
});

test("nothing was written outside the root", () => {
  // If a traversal had succeeded, the root would be empty or hold a stray path.
  const entries = readdirSync(process.env.STORAGE_DIR!);
  assert.ok(entries.every((e) => /^[A-Za-z0-9]{2}$/.test(e)), `unexpected entries: ${entries}`);
});
