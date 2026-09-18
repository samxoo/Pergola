import assert from "node:assert/strict";
import { test } from "node:test";
import { handleNames, mentionHandle, mentionedHandles } from "./mentions.js";

const grigol = { name: "Grigol Samkharadze", email: "grigol@example.com" };
const nino = { name: "ნინო ბერიძე", email: "nino.b@example.com" };

test("a name runs together into its handle; the address is the fallback", () => {
  assert.equal(mentionHandle(grigol), "GrigolSamkharadze");
  assert.equal(mentionHandle(nino), "ნინობერიძე");
  assert.equal(mentionHandle({ name: "", email: "solo@example.com" }), "solo");
  assert.equal(mentionHandle({ name: "?!", email: "odd@example.com" }), "odd");
});

test("handles are found in any script, once each, case folded", () => {
  assert.deepEqual(
    mentionedHandles("hey @GrigolSamkharadze and @ნინობერიძე — @grigolsamkharadze again"),
    ["grigolsamkharadze", "ნინობერიძე"],
  );
  assert.deepEqual(mentionedHandles("mail me at x@y.com"), ["y.com"]);
  assert.deepEqual(mentionedHandles("a lone @ or @a is nothing"), []);
});

test("a handle names a person by run-together name or by address", () => {
  assert.ok(handleNames("grigolsamkharadze", grigol));
  assert.ok(handleNames("GRIGOL", grigol));
  assert.ok(handleNames("ნინობერიძე", nino));
  assert.ok(handleNames("nino.b", nino));
  assert.ok(!handleNames("nino", nino));
  assert.ok(!handleNames("grigol", nino));
});
