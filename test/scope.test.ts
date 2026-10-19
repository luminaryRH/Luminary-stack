// Loads every in-scope module (src/server/luminary, src/shielded, src/routes/api), so each one loads cleanly and
// `bun test --coverage` counts all of their lines, including files no other test reaches.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// checks are tests themselves; prove.bench.ts is a benchmark script that proves on import
const SKIP = /\.check\.ts$|prove\.bench\.ts$/;

test("every in-scope module loads", async () => {
  const files = ["src/server/luminary", "src/shielded", "src/routes/api"].flatMap((dir) => [...new Glob("**/*.ts").scanSync(join(ROOT, dir))].map((f) => join(ROOT, dir, f)));
  const failed: string[] = [];
  for (const f of files.filter((f) => !SKIP.test(f))) await import(f).catch((e) => failed.push(`${f}: ${e}`));
  expect(failed).toEqual([]);
}, 60_000);
