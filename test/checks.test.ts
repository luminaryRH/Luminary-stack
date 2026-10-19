// The standalone checks (`bun run check`) as one bun test, so `bun test --coverage` counts what they run.
import { test } from "bun:test";

const CHECKS = [
  "../src/server/luminary/engine/clearing.check.ts",
  "../src/server/luminary/calendar.check.ts",
  "../supabase/checks/pool.check.ts",
  "../src/shielded/ledger.check.ts",
  "../src/shielded/buylock.check.ts",
  "../src/shielded/rfq-settle.check.ts",
];
for (const c of CHECKS) test(c, () => import(c), 120_000);
