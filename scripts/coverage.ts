// Off-chain line coverage of the in-scope code (src/server/luminary, src/shielded, src/routes/api): runs every test in
// test/ (the standalone checks, the module loader and the local end-to-end flow) under `bun test --coverage` and sums
// the lcov lines per file. test/scope.test.ts loads every in-scope module, so a file no test reaches still counts.
//   bun scripts/coverage.ts        (needs foundry: anvil and forge, for test/e2e.test.ts)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "luminary-coverage");
const run = spawnSync("bun", ["test", "./test/", "--coverage", "--coverage-reporter=lcov", "--coverage-dir", dir], { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);

const SCOPE = /^src\/(server\/luminary|shielded|routes\/api)\//;
const rows: { file: string; hit: number; lines: number }[] = [];
let file = "";
let lines = 0;
for (const line of readFileSync(join(dir, "lcov.info"), "utf8").split("\n")) {
  if (line.startsWith("SF:")) file = line.slice(3).replaceAll("\\", "/");
  else if (line.startsWith("LF:")) lines = Number(line.slice(3));
  else if (line.startsWith("LH:") && SCOPE.test(file) && !/\.(check|bench)\.ts$/.test(file)) rows.push({ file, hit: Number(line.slice(3)), lines });
}
rows.sort((a, b) => a.file.localeCompare(b.file));
for (const r of rows) console.log(`${String(r.hit).padStart(5)}/${String(r.lines).padEnd(5)} ${((100 * r.hit) / r.lines).toFixed(1).padStart(5)}%  ${r.file}`);
const [hit, total] = rows.reduce(([h, t], r) => [h + r.hit, t + r.lines], [0, 0]);
console.log(`off-chain in-scope lines: ${hit}/${total} = ${((100 * hit) / total).toFixed(1)}% across ${rows.length} files`);
// a floor under the measured 95.7% (2026-10-19), so CI fails when new code lands without tests
if (hit < total * 0.9) process.exit(1);
