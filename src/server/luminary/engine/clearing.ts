// The uniform-price call auction (published spec, mirrored exactly by circuits/auction_clear). Pure and deterministic:
// anyone holding an auction's orders can recompute p* and every fill.
//   band        [ref·(1−cap), ref·(1+cap)] (floored)
//   eligibility plain orders only; a buy's effective limit is its limit capped by what its lock affords for the whole
//               order plus fee (an at-auction buy: the lock alone); a sell's is its limit (0 at-auction)
//   candidates  every effective limit inside the band, plus both band edges
//   p*          maximizes V(p) = min(D(p), S(p)); ties to the smallest |D−S|, then closest to ref, then the lower price
//   fills       strictly better orders first (pro rata among them if they alone exceed V), then the orders at p* pro
//               rata; rounding units by largest remainder, ties to the earliest slot
// All quantities are raw integer units: asset micro-units, micro-USD, quote micro-units.

export const BPS = 10_000n;
export const U128_MAX = (1n << 128n) - 1n;

export interface ClearOrder {
  buy: boolean;
  qty: bigint; // asset micro-units
  hasLimit: boolean; // false = at-auction
  limitUsd: bigint; // micro-USD per asset token
  lock: bigint; // quote micro-units for a buy, asset micro-units for a sell
  plain: boolean; // no reserved terms (an rfq order in an auction takes no part)
}

export interface ClearParams {
  refUsd: bigint;
  capBps: bigint;
  quoteUsd: bigint; // micro-USD per quote token
  feeBps: bigint;
}

/** Rounding units of one pro-rata split, and per side [buy, sell] the lowest-ranked holder (the circuit's cut). */
export interface Split {
  filled: bigint[];
  bonus: boolean[];
  cutRem: [bigint, bigint];
  cutIdx: [number, number];
}

export interface Clearing {
  lo: bigint;
  hi: bigint;
  pStar: bigint;
  pIdx: number; // circuit hint: order slot whose effective limit is p*, or N / N + 1 for the band edges
  volume: bigint;
  demand: bigint;
  supply: bigint;
  eff: bigint[];
  size: bigint[];
  better: Split; // strictly better tier
  at: Split; // at-p* tier
  filled: bigint[]; // per slot, better + at
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const gap = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Quote a buyer pays for `q` at `p`, rounded up, and its fee (rounded up). */
export function buyCost(q: bigint, p: bigint, quoteUsd: bigint, feeBps: bigint) {
  const pay = ceilDiv(q * p, quoteUsd);
  return { pay, fee: ceilDiv(pay * feeBps, BPS) };
}

/** Quote a seller receives for `q` at `p`, rounded down, and its fee (rounded up). */
export function sellProceeds(q: bigint, p: bigint, quoteUsd: bigint, feeBps: bigint) {
  const proceeds = (q * p) / quoteUsd;
  return { proceeds, fee: ceilDiv(proceeds * feeBps, BPS) };
}

/** A buy's effective limit: its limit capped by the highest price its lock pays for the whole order plus fee. */
export function effectiveLimit(o: ClearOrder, quoteUsd: bigint, feeBps: bigint) {
  if (!o.buy) return o.hasLimit ? o.limitUsd : 0n;
  const budget = (o.lock * BPS) / (BPS + feeBps);
  const afford = (budget * quoteUsd) / (o.qty === 0n ? 1n : o.qty);
  return o.hasLimit ? min(o.limitUsd, afford) : afford;
}

function depth(p: bigint, orders: (ClearOrder | null)[], eff: bigint[], size: bigint[]) {
  let d = 0n;
  let s = 0n;
  orders.forEach((o, i) => {
    if (!o) return;
    if (o.buy ? eff[i]! >= p : eff[i]! <= p) {
      if (o.buy) d += size[i]!;
      else s += size[i]!;
    }
  });
  return { d, s };
}

/**
 * Splits `targets` [buy, sell] over `qty` by side: everything where a side's total equals its target, pro rata + largest
 * remainder otherwise. Returns the fills and the circuit's rounding hints.
 */
export function allocate(qty: bigint[], buy: boolean[], targets: [bigint, bigint]): Split {
  const n = qty.length;
  const totals: [bigint, bigint] = [0n, 0n];
  qty.forEach((q, i) => (totals[buy[i] ? 0 : 1] += q));
  const filled = Array<bigint>(n).fill(0n);
  const rems = Array<bigint>(n).fill(0n);
  const bonus = Array<boolean>(n).fill(false);
  const cutRem: [bigint, bigint] = [U128_MAX, U128_MAX];
  const cutIdx: [number, number] = [0, 0];
  for (const side of [0, 1] as const) {
    const [total, target] = [totals[side], targets[side]];
    if (target > total) throw new Error(`allocate: target ${target} above total ${total}`);
    const idx = [...Array(n).keys()].filter((i) => (buy[i] ? 0 : 1) === side);
    let sum = 0n;
    for (const i of idx) {
      if (target < total) {
        filled[i] = (qty[i]! * target) / total;
        rems[i] = (qty[i]! * target) % total;
      } else filled[i] = qty[i]!;
      sum += filled[i]!;
    }
    const units = Number(target - sum);
    const ranked = idx.filter((i) => rems[i]! > 0n).sort((a, b) => (rems[a] === rems[b] ? a - b : rems[b]! > rems[a]! ? 1 : -1));
    for (const i of ranked.slice(0, units)) {
      filled[i]! += 1n;
      bonus[i] = true;
    }
    if (units > 0) {
      const last = ranked[units - 1]!;
      cutRem[side] = rems[last]!;
      cutIdx[side] = last;
    }
  }
  return { filled, bonus, cutRem, cutIdx };
}

/** Clears one auction. `orders` is slot-ordered; null marks an empty or cancelled slot. */
export function clearAuction(orders: (ClearOrder | null)[], p: ClearParams): Clearing {
  const n = orders.length;
  if (p.refUsd <= 0n || p.quoteUsd <= 0n || p.capBps >= BPS || p.feeBps >= BPS) throw new Error("clearAuction: bad parameters");
  const lo = (p.refUsd * (BPS - p.capBps)) / BPS;
  const hi = (p.refUsd * (BPS + p.capBps)) / BPS;
  const eff = orders.map((o) => (o && o.plain ? effectiveLimit(o, p.quoteUsd, p.feeBps) : 0n));
  const size = orders.map((o) => (!o || !o.plain ? 0n : o.buy ? o.qty : min(o.qty, o.lock)));
  const buy = orders.map((o) => o?.buy ?? false);

  // candidates, in the circuit's order: effective limits in band, then the two edges
  const candidates: { price: bigint; idx: number }[] = [];
  eff.forEach((e, i) => {
    if (size[i]! > 0n && e >= lo && e <= hi) candidates.push({ price: e, idx: i });
  });
  candidates.push({ price: lo, idx: n }, { price: hi, idx: n + 1 });

  let best: { price: bigint; idx: number; v: bigint; imbalance: bigint; distance: bigint; d: bigint; s: bigint } | undefined;
  for (const c of candidates) {
    const { d, s } = depth(c.price, orders, eff, size);
    const cand = { ...c, v: min(d, s), imbalance: gap(d, s), distance: gap(c.price, p.refUsd), d, s };
    const wins =
      !best ||
      cand.v > best.v ||
      (cand.v === best.v &&
        (cand.imbalance < best.imbalance ||
          (cand.imbalance === best.imbalance && (cand.distance < best.distance || (cand.distance === best.distance && cand.price < best.price)))));
    if (wins) best = cand;
  }
  const b = best!;
  const pStar = b.price;
  const volume = b.v;

  const better = Array<bigint>(n).fill(0n);
  const at = Array<bigint>(n).fill(0n);
  let buyBetter = 0n;
  let sellBetter = 0n;
  orders.forEach((o, i) => {
    if (!o || size[i] === 0n) return;
    const e = eff[i]!;
    if (o.buy ? e > pStar : e < pStar) {
      better[i] = size[i]!;
      if (o.buy) buyBetter += size[i]!;
      else sellBetter += size[i]!;
    } else if (e === pStar) at[i] = size[i]!;
  });
  const buyFirst = min(buyBetter, volume);
  const sellFirst = min(sellBetter, volume);
  const s1 = allocate(better, buy, [buyFirst, sellFirst]);
  const s2 = allocate(at, buy, [volume - buyFirst, volume - sellFirst]);
  return {
    lo,
    hi,
    pStar,
    pIdx: b.idx,
    volume,
    demand: b.d,
    supply: b.s,
    eff,
    size,
    better: s1,
    at: s2,
    filled: s1.filled.map((f, i) => f + s2.filled[i]!),
  };
}
