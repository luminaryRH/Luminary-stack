// One auction's settlement: decrypted order openings + the pinned auction state → clearing.ts → the exact
// AuctionClearProof inputs and the on-chain Clearing (AuctionPool.settleAuction). Shared by the operator's
// proof-orchestrator and the proof fixtures. Server and tooling only (imports the engine).
import { buyCost, clearAuction, sellProceeds } from "../server/luminary/engine/clearing";
import { commitmentOf, type OrderOpening } from "./orders";
import { FEE_LABEL, ORDERS, PLAIN, blind, note } from "./protocol";

export * from "./orders";

/** The auction as pinned on chain, plus the pool's fee owner. */
export interface PinnedAuction {
  asset: bigint;
  unit: bigint; // asset base units per micro-unit
  quote: bigint;
  quoteUnit: bigint;
  refUsd: bigint;
  capBps: bigint;
  quoteUsd: bigint;
  feeBps: bigint;
  feeOwner: bigint;
}

export interface OrderResult {
  slot: number;
  qty: bigint; // filled
  quote: bigint; // paid (buy) or received gross (sell)
  fee: bigint;
  left: bigint; // what the lock still holds
  rolls: boolean;
  fill: bigint;
  residual: bigint; // rolled order commitment, or the refund note
  rolled?: OrderOpening;
}

const EMPTY = {
  owner: 0n, salt: 0n, buy: false, qty: 0n, has_limit: false, limit_usd: 0n, roll: false, rolls_left: 0n, lock: 0n, label: 0n,
  min_qty: 0n, display: 0n, peg: 0n, rfq: 0n,
};

const isPlain = (o: OrderOpening) => o.terms.minQty === 0n && o.terms.display === 0n && o.terms.peg === 0n && o.terms.rfq === 0n;

/** `slots` in slot order; null for an empty or cancelled slot. */
export function settleAuction(a: PinnedAuction, slots: (OrderOpening | null)[], feeBlinding: bigint) {
  if (slots.length > ORDERS) throw new Error(`auction holds ${slots.length} slots`);
  const c = clearAuction(
    slots.map((o) => o && { buy: o.buy, qty: o.qty, hasLimit: o.hasLimit, limitUsd: o.limitUsd, lock: o.lock, plain: isPlain(o) }),
    { refUsd: a.refUsd, capBps: a.capBps, quoteUsd: a.quoteUsd, feeBps: a.feeBps },
  );

  let fees = 0n;
  let paid = 0n;
  let received = 0n;
  const results: OrderResult[] = [];
  slots.forEach((o, slot) => {
    if (!o) return;
    const q = c.filled[slot]!;
    let quote: bigint;
    let fee: bigint;
    let left: bigint;
    let fill: bigint;
    if (o.buy) {
      const b = buyCost(q, c.pStar, a.quoteUsd, a.feeBps);
      [quote, fee, left] = [b.pay, b.fee, o.lock - b.pay - b.fee];
      paid += b.pay;
      fill = note(o.owner, a.asset, q * a.unit, blind(o.salt, 0n), o.label);
    } else {
      const s = sellProceeds(q, c.pStar, a.quoteUsd, a.feeBps);
      [quote, fee, left] = [s.proceeds, s.fee, o.lock - q];
      received += s.proceeds;
      fill = note(o.owner, a.quote, (s.proceeds - s.fee) * a.quoteUnit, blind(o.salt, 0n), o.label);
    }
    fees += fee;
    const rest = o.qty - q;
    const rolls = rest > 0n && o.roll && o.rollsLeft > 0;
    let residual: bigint;
    let rolled: OrderOpening | undefined;
    if (rolls) {
      rolled = { ...o, qty: rest, rollsLeft: o.rollsLeft - 1, lock: left, salt: blind(o.salt, 2n) };
      residual = commitmentOf(a.asset, rolled);
    } else {
      residual = o.buy ? note(o.owner, a.quote, left * a.quoteUnit, blind(o.salt, 1n), o.label) : note(o.owner, a.asset, left * a.unit, blind(o.salt, 1n), o.label);
    }
    results.push({ slot, qty: q, quote, fee, left, rolls, fill, residual, rolled });
  });
  const feeNote = note(a.feeOwner, a.quote, (fees + paid - received) * a.quoteUnit, feeBlinding, FEE_LABEL);

  const pad = <T,>(xs: T[], fill: T) => [...xs, ...Array<T>(ORDERS - xs.length).fill(fill)];
  const bySlot = new Map(results.map((r) => [r.slot, r]));
  const fills = pad(slots.map((_, i) => bySlot.get(i)?.fill ?? 0n), 0n);
  const residuals = pad(slots.map((_, i) => bySlot.get(i)?.residual ?? 0n), 0n);
  const rolls = pad(slots.map((_, i) => bySlot.get(i)?.rolls ?? false), false);
  const commitments = pad(slots.map((o) => (o ? commitmentOf(a.asset, o) : 0n)), 0n);
  const padBool = (xs: boolean[]) => pad(xs, false);

  /** circuits/auction_clear inputs (snake_case, as Prover.toml / noir_js take them). */
  const inputs = {
    orders: pad(
      slots.map((o) =>
        o
          ? {
              owner: o.owner, salt: o.salt, buy: o.buy, qty: o.qty, has_limit: o.hasLimit, limit_usd: o.limitUsd, roll: o.roll,
              rolls_left: BigInt(o.rollsLeft), lock: o.lock, label: o.label, min_qty: o.terms.minQty, display: o.terms.display,
              peg: o.terms.peg, rfq: o.terms.rfq,
            }
          : EMPTY,
      ),
      EMPTY,
    ),
    p_idx: BigInt(c.pIdx),
    bonus1: padBool(c.better.bonus),
    cut1_rem: c.better.cutRem,
    cut1_idx: c.better.cutIdx.map(BigInt),
    bonus2: padBool(c.at.bonus),
    cut2_rem: c.at.cutRem,
    cut2_idx: c.at.cutIdx.map(BigInt),
    fee_blinding: feeBlinding,
    asset: a.asset,
    unit: a.unit,
    quote_token: a.quote,
    quote_unit: a.quoteUnit,
    ref_usd: a.refUsd,
    cap_bps: a.capBps,
    quote_usd: a.quoteUsd,
    fee_bps: a.feeBps,
    p_star: c.pStar,
    crossed_qty: c.volume,
    commitments,
    fills,
    residuals,
    rolls,
    fee_owner: a.feeOwner,
    fee_note: feeNote,
  };
  // hints are padded to N; an empty tail slot never ranks above a cut (remainder 0, later slot)
  if (c.pIdx >= slots.length) inputs.p_idx = BigInt(c.pIdx === slots.length ? ORDERS : ORDERS + 1);

  return {
    clearing: c,
    results,
    inputs,
    /** AuctionPool.Clearing */
    onchain: { pStar: c.pStar, crossedQty: c.volume, fills, residuals, rolls, feeNote },
  };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * An RFQ auction's settlement (circuits/rfq_cross): its two orders cross whole at the pinned reference when they carry
 * the same block commitment on opposite sides with the same size, inside both limits and fully funded; otherwise both
 * are refunded. Mirrors the circuit line for line. `slots` in slot order (at most 2), null for an empty or cancelled slot.
 */
export function settleRfq(a: PinnedAuction, slots: (OrderOpening | null)[], feeBlinding: bigint) {
  if (slots.length > 2) throw new Error(`RFQ auction holds ${slots.length} slots`);
  const [x, y] = [slots[0] ?? null, slots[1] ?? null];
  const empty = { buy: false, qty: 0n, lock: 0n, hasLimit: false, limitUsd: 0n, terms: PLAIN } as const;
  const [first, second] = [x ?? empty, y ?? empty];
  const [buyer, seller] = first.buy ? [first, second] : [second, first];
  const q = buyer.qty;
  const pay = ceilDiv(q * a.refUsd, a.quoteUsd);
  const buyFee = ceilDiv(pay * a.feeBps, 10_000n);
  const proceeds = (q * a.refUsd) / a.quoteUsd;
  const sellFee = ceilDiv(proceeds * a.feeBps, 10_000n);
  const plainBlock = (o: { terms: typeof PLAIN }) => o.terms.rfq !== 0n && o.terms.minQty === 0n && o.terms.display === 0n && o.terms.peg === 0n;
  const inLimit = (o: { buy: boolean; hasLimit: boolean; limitUsd: bigint }) => !o.hasLimit || (o.buy ? a.refUsd <= o.limitUsd : a.refUsd >= o.limitUsd);
  const cross =
    x !== null && y !== null && plainBlock(x) && plainBlock(y) && x.terms.rfq === y.terms.rfq && x.buy !== y.buy && x.qty === y.qty &&
    inLimit(x) && inLimit(y) && buyer.lock >= pay + buyFee && seller.lock >= q;

  const results: OrderResult[] = [];
  const fills = [0n, 0n];
  const residuals = [0n, 0n];
  [x, y].forEach((o, slot) => {
    if (!o) return;
    const filled = cross ? q : 0n;
    const quote = cross ? (o.buy ? pay : proceeds) : 0n;
    const fee = cross ? (o.buy ? buyFee : sellFee) : 0n;
    const left = cross ? (o.buy ? o.lock - pay - buyFee : o.lock - q) : o.lock;
    fills[slot] = o.buy
      ? note(o.owner, a.asset, filled * a.unit, blind(o.salt, 0n), o.label)
      : note(o.owner, a.quote, (cross ? proceeds - sellFee : 0n) * a.quoteUnit, blind(o.salt, 0n), o.label);
    residuals[slot] = o.buy ? note(o.owner, a.quote, left * a.quoteUnit, blind(o.salt, 1n), o.label) : note(o.owner, a.asset, left * a.unit, blind(o.salt, 1n), o.label);
    results.push({ slot, qty: filled, quote, fee, left, rolls: false, fill: fills[slot]!, residual: residuals[slot]! });
  });
  const fees = cross ? buyFee + sellFee + pay - proceeds : 0n;
  const feeNote = note(a.feeOwner, a.quote, fees * a.quoteUnit, feeBlinding, FEE_LABEL);
  const commitments = [x ? commitmentOf(a.asset, x) : 0n, y ? commitmentOf(a.asset, y) : 0n];
  const orderInput = (o: OrderOpening | null) =>
    o
      ? {
          owner: o.owner, salt: o.salt, buy: o.buy, qty: o.qty, has_limit: o.hasLimit, limit_usd: o.limitUsd, roll: o.roll,
          rolls_left: BigInt(o.rollsLeft), lock: o.lock, label: o.label, min_qty: o.terms.minQty, display: o.terms.display,
          peg: o.terms.peg, rfq: o.terms.rfq,
        }
      : EMPTY;

  return {
    crossedQty: cross ? q : 0n,
    fees,
    results,
    /** circuits/rfq_cross inputs */
    inputs: {
      orders: [orderInput(x), orderInput(y)],
      fee_blinding: feeBlinding,
      asset: a.asset,
      unit: a.unit,
      quote_token: a.quote,
      quote_unit: a.quoteUnit,
      ref_usd: a.refUsd,
      quote_usd: a.quoteUsd,
      fee_bps: a.feeBps,
      crossed_qty: cross ? q : 0n,
      commitments,
      fills,
      residuals,
      fee_owner: a.feeOwner,
      fee_note: feeNote,
    },
    onchain: { fills, residuals, feeNote },
  };
}

export { PLAIN };
