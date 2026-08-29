import assert from "node:assert/strict";
import { test } from "node:test";
import { getAuthTables } from "better-auth/db";
import * as schema from "./auth-schema.js";

/**
 * Better Auth resolves its columns at runtime, so a schema that has drifted
 * from the installed version fails on the first sign-up rather than at build
 * time — which is exactly how it failed once already. This closes that gap.
 */
test("the Drizzle auth schema matches the installed Better Auth", () => {
  const tables = getAuthTables({ emailAndPassword: { enabled: true } });
  const missing: string[] = [];

  for (const [model, def] of Object.entries(tables)) {
    const table = (schema as Record<string, unknown>)[model];
    assert.ok(table, `no Drizzle table exported for "${model}"`);
    const columns = Object.keys((table as { [k: string]: unknown })[
      Object.getOwnPropertySymbols(table as object).find(
        (s) => s.description === "drizzle:Columns",
      ) as unknown as string
    ] ?? {});

    for (const field of ["id", ...Object.keys(def.fields)]) {
      if (!columns.includes(field)) missing.push(`${model}.${field}`);
    }
  }

  assert.deepEqual(missing, [], `columns Better Auth expects but Drizzle lacks: ${missing.join(", ")}`);
});
