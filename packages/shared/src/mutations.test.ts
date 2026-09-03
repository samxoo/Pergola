import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachmentAdd } from "./mutations.js";

const base = {
  kind: "attachment.add" as const,
  attachmentId: "11111111-1111-4111-8111-111111111111",
  cardId: "22222222-2222-4222-8222-222222222222",
  name: "thing",
};

const accepts = (url: string) => AttachmentAdd.safeParse({ ...base, url }).success;

test("a typed link has to be http or https", () => {
  assert.ok(accepts("https://example.com/report.pdf"));
  assert.ok(accepts("http://example.com/"));
  assert.ok(!accepts("javascript:alert(1)"));
  assert.ok(!accepts("data:text/html,<script>alert(1)</script>"));
  assert.ok(!accepts("ftp://example.com/x"));
  assert.ok(!accepts("example.com"));
});

test("an uploaded file is the one relative form, and only that", () => {
  // The server writes this itself, and redo sends it back through the validator.
  assert.ok(accepts("/api/files/33d48400-3d5b-4f44-9375-d7978808dd38"));
  assert.ok(!accepts("/api/files/"));
  assert.ok(!accepts("/api/files/not-a-uuid"));
  assert.ok(!accepts("/api/files/../boards"));
  assert.ok(!accepts("/api/files/33d48400-3d5b-4f44-9375-d7978808dd38/extra"));
  assert.ok(!accepts("/api/boards/33d48400-3d5b-4f44-9375-d7978808dd38"));
});
