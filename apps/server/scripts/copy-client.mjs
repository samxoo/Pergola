import { cpSync, existsSync, rmSync } from "node:fs";

/**
 * The server serves the built client from ./public. The container image does
 * this copy in its own layer; doing it here too means `pnpm build && pnpm start`
 * behaves exactly like the image instead of 404ing on every page.
 */
const from = "../web/dist";
const to = "public";

if (!existsSync(from)) {
  console.error(`Client build not found at ${from}. Run "pnpm --filter @pergola/web build" first.`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`client copied to ${to}`);
