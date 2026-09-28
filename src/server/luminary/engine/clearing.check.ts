// bun src/server/luminary/engine/clearing.check.ts
// Golden cases for the call auction, plus a randomized check against brute force over every integer price in the band.
import assert from "node:assert/strict";
import { allocate, buyCost, clearAuction, effectiveLimit, type ClearOrder, type ClearParams } from "./clearing";

const U = 1_000_000n;
const P: ClearParams = { refUsd: 250n * U, capBps: 500n, quoteUsd: U, feeBps: 5n };
const buy = (qty: bigint, limitUsd: bigint, lock = 10n ** 12n): ClearOrder => ({ buy: true, qty, hasLimit: limitUsd > 0n, limitUsd, lock, plain: true });
const sell = (qty: bigint, limitUsd: bigint): ClearOrder => ({ buy: false, qty, hasLimit: limitUsd > 0n, limitUsd, lock: qty, plain: true });

// 1. the circuit test scenario: V = 3 at $245 and $255, same imbalance and distance → the lower price
{
  const c = clearAuction([buy(3n * U, 255n * U, 900n * U), sell(2n * U, 245n * U), sell(2n * U, 0n)], P);
  assert.equal(c.pStar, 245n * U);
  assert.equal(c.pIdx, 1);
  assert.equal(c.volume, 3n * U);
  assert.deepEqual(c.filled, [3n * U, 1n * U, 2n * U]); // at-auction sell first, then the $245 sell
  assert.equal(c.lo, 237_500_000n);
  assert.equal(c.hi, 262_500_000n);
}

// 2. at-auction orders on both sides fill at p*, which stays in the band
{
  const c = clearAuction([buy(5n * U, 0n), sell(5n * U, 0n)], P);
  assert.equal(c.volume, 5n * U);
  assert.ok(c.pStar >= c.lo && c.pStar <= c.hi);
  assert.equal(c.pStar, c.lo); // both edges cross 5 with no imbalance, equally far from ref: the lower wins
}

// 3. |D−S| tie-break: at $240 D=4,S=4; at $250 D=4,S=6 → $240 wins despite being farther from ref
{
  const c = clearAuction([buy(4n * U, 250n * U), sell(4n * U, 240n * U), sell(2n * U, 250n * U)], P);
  assert.equal(c.volume, 4n * U);
  assert.equal(c.pStar, 240n * U);
}

// 4. pro rata among orders at p* with a largest-remainder unit (ties to the earliest slot)
{
  const c = clearAuction([buy(4n, 250n * U), sell(3n, 250n * U), sell(3n, 250n * U), sell(3n, 250n * U)], P);
  assert.equal(c.volume, 4n);
  assert.deepEqual(c.filled.slice(1), [2n, 1n, 1n]);
  assert.deepEqual(c.at.bonus, [false, true, false, false]);
  assert.deepEqual(c.at.cutIdx, [0, 1]);
}

// 5. a buy's lock caps its effective limit: 3 shares with $600 of quote can pay at most ~$199.9, below the band
{
  const o = buy(3n * U, 0n, 600n * U);
  assert.ok(effectiveLimit(o, U, 5n) < 200n * U);
  const c = clearAuction([o, sell(3n * U, 0n)], P);
  assert.equal(c.volume, 0n);
}

// 6. allocate: exact targets, units only where there is a remainder
{
  const s = allocate([5n, 5n, 5n, 0n], [false, false, false, false], [0n, 10n]);
  assert.deepEqual(s.filled, [4n, 3n, 3n, 0n]);
  assert.deepEqual(s.bonus, [true, false, false, false]);
}

// 7. random auctions against brute force over every integer price in a small band
let seed = 42;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
const small: ClearParams = { refUsd: 1000n, capBps: 500n, quoteUsd: 1000n, feeBps: 5n };
for (let t = 0; t < 400; t++) {
  const orders: (ClearOrder | null)[] = [];
  for (let i = 0; i < 1 + rnd(12); i++) {
    if (rnd(8) === 0) {
      orders.push(null);
      continue;
    }
    const qty = BigInt(1 + rnd(50));
    const limit = rnd(4) === 0 ? 0n : BigInt(930 + rnd(140));
    orders.push(rnd(2) ? { buy: true, qty, hasLimit: limit > 0n, limitUsd: limit, lock: BigInt(rnd(3) === 0 ? 30 + rnd(60) : 100_000), plain: true } : sell(qty, limit));
  }
  const c = clearAuction(orders, small);
  const vAt = (p: bigint) => {
    let d = 0n;
    let s = 0n;
    orders.forEach((o, i) => {
      if (!o) return;
      if (o.buy && c.eff[i]! >= p) d += c.size[i]!;
      if (!o.buy && c.eff[i]! <= p) s += c.size[i]!;
    });
    return d < s ? d : s;
  };
  assert.ok(c.pStar >= c.lo && c.pStar <= c.hi, "p* in band");
  for (let p = c.lo; p <= c.hi; p++) assert.ok(vAt(p) <= c.volume, `volume maximal (p=${p})`);
  let bought = 0n;
  let sold = 0n;
  orders.forEach((o, i) => {
    if (!o) return assert.equal(c.filled[i], 0n);
    const q = c.filled[i]!;
    assert.ok(q <= c.size[i]!, "never above the order");
    if (q === 0n) return;
    if (o.buy) {
      bought += q;
      assert.ok(!o.hasLimit || o.limitUsd >= c.pStar, "buy limit respected");
      const { pay, fee } = buyCost(q, c.pStar, small.quoteUsd, small.feeBps);
      assert.ok(pay + fee <= o.lock, "buy lock covers the fill");
    } else {
      sold += q;
      assert.ok(!o.hasLimit || o.limitUsd <= c.pStar, "sell limit respected");
    }
  });
  assert.equal(bought, c.volume);
  assert.equal(sold, c.volume);
}

console.log("clearing: ok");
