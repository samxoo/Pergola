import assert from "node:assert/strict";
import { test } from "node:test";
import { MutationBody } from "@pergola/shared";
import { openapi } from "./openapi.js";

/**
 * The document is generated, so what can rot is the hand-written half: the
 * paths, and the places a schema is stitched to another by name. These pin
 * that every mutation kind is described, that every reference resolves, and
 * that the write endpoint says what the README says.
 */

type Json = Record<string, unknown>;

const doc = openapi();
const schemas = (doc.components as Json).schemas as Record<string, Json>;

test("every mutation kind is a named schema, and the union maps to all of them", () => {
  const kinds = MutationBody.options.map((v) => v.shape.kind.value);
  const union = schemas.MutationBody!;
  const mapping = (union.discriminator as Json).mapping as Record<string, string>;

  assert.deepEqual(Object.keys(mapping).sort(), [...kinds].sort());
  for (const kind of kinds) {
    const name = mapping[kind]!.replace("#/components/schemas/", "");
    assert.ok(schemas[name], `no schema for ${kind}`);
    const props = schemas[name]!.properties as Record<string, Json>;
    assert.deepEqual(props.kind!.enum, [kind]);
  }
  assert.equal((union.oneOf as unknown[]).length, kinds.length);
});

test("every $ref in the document resolves", () => {
  const refs = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Json)) {
        if (k === "$ref" && typeof v === "string") refs.add(v);
        else walk(v);
      }
    }
  };
  walk(doc);
  const missing = [...refs].filter((r) => !schemas[r.replace("#/components/schemas/", "")]);
  assert.deepEqual(missing, []);
  assert.ok(refs.size > 20, "the document is stitched by reference, not inlined");
});

test("the write endpoint accepts one envelope or a batch, and says so", () => {
  const post = ((doc.paths as Json)["/mutations"] as Json).post as Json;
  const body = (((post.requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
  const [one, many] = body.oneOf as [Json, Json];
  assert.equal(one.$ref, "#/components/schemas/MutationEnvelope");
  assert.equal(many.type, "array");
  assert.equal(many.minItems, 1);
  assert.ok((post.description as string).includes("atomic"));
  assert.ok(post.responses && (post.responses as Json)["409"], "a stale reference is documented as 409");
});

test("the envelope requires an id, a board and a body", () => {
  const env = schemas.MutationEnvelope!;
  assert.deepEqual((env.required as string[]).sort(), ["boardId", "body", "id"]);
  assert.deepEqual((env.properties as Json).body, { $ref: "#/components/schemas/MutationBody" });
});

test("a record carries its inverse as the same union, nullable", () => {
  const inverse = (schemas.MutationRecord!.properties as Json).inverse as Json;
  assert.equal(inverse.nullable, true);
  assert.deepEqual(inverse.allOf, [{ $ref: "#/components/schemas/MutationBody" }]);
});

test("the board's cards say which fields may be null", () => {
  const cards = (schemas.Board!.properties as Json).cards as Json;
  const card = (cards.items as Json).properties as Record<string, Json>;
  assert.equal(card.dueAt!.nullable, true);
  assert.equal(card.dueAt!.format, "date-time");
  assert.equal(card.title!.nullable, undefined);
});
