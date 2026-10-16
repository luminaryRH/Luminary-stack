// bun src/shielded/buylock.check.ts — a default buy lock lets the order trade at its own limit (auction_clear's budget
// and afford arithmetic, src/server/luminary/engine/clearing.ts) for any quote price from $0.99 up.
import { buyLockFor } from "./client";

const BPS = 10_000n;
let seed = 7n;
const rand = (n: bigint) => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % n;
for (let i = 0; i < 100_000; i++) {
  const qty = 1_000n + rand(10n ** 9n);
  const limit = 1n + rand(10n ** 9n);
  const fee = rand(101n);
  const quoteUsd = 990_000n + rand(20_000n);
  const lock = buyLockFor(qty, limit, fee);
  const budget = (lock * BPS) / (BPS + fee);
  const afford = (budget * quoteUsd) / qty;
  if (afford < limit) throw new Error(`qty ${qty} limit ${limit} fee ${fee} quote ${quoteUsd}: afford ${afford}`);
}
console.log("buylock.check: ok");
