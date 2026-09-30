// bun src/shielded/rfq-settle.check.ts
// settleRfq's outputs must satisfy the real rfq_cross circuit: a matching block crosses whole at the reference, a
// mismatched one refunds both sides. Executes the circuit (witness only, no proof).
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import rfqCross from "./circuits/rfq_cross.json" with { type: "json" };
import { PLAIN, ready } from "./protocol";
import { settleRfq, type OrderOpening, type PinnedAuction } from "./settle";

const U = 1_000_000n;
const TSLA = 0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4en;
const TQ = 0xf96e4e97e2bbecec392733b49fa42490ec5f3420n;
const a: PinnedAuction = { asset: TSLA, unit: 10n ** 12n, quote: TQ, quoteUnit: 1n, refUsd: 250n * U, capBps: 500n, quoteUsd: U, feeBps: 5n, feeOwner: 424242n };
const viewPub = "0x02" + "11".repeat(32);
const block = (buy: boolean, rfq: bigint): OrderOpening => ({
  owner: buy ? 11n : 12n, salt: buy ? 1n : 2n, buy, qty: 10n * U, hasLimit: buy, limitUsd: buy ? 260n * U : 0n, roll: false, rollsLeft: 0,
  lock: buy ? 3000n * U : 10n * U, label: buy ? 101n : 102n, terms: { ...PLAIN, rfq }, viewPub,
});
const hexify = (v: unknown): unknown => (typeof v === "bigint" ? "0x" + v.toString(16) : Array.isArray(v) ? v.map(hexify) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hexify(x)])) : v);

await ready();
const noir = new Noir(rfqCross as unknown as CompiledCircuit);
const cross = settleRfq(a, [block(true, 424242n), block(false, 424242n)], 9n);
if (cross.crossedQty !== 10n * U || cross.fees !== 2_500_000n) throw new Error(`rfq-settle.check: cross ${cross.crossedQty} fees ${cross.fees}`);
await noir.execute(hexify(cross.inputs) as InputMap);
const refund = settleRfq(a, [block(true, 424242n), block(false, 424243n)], 9n);
if (refund.crossedQty !== 0n) throw new Error("rfq-settle.check: a mismatched block crossed");
await noir.execute(hexify(refund.inputs) as InputMap);
console.log("rfq-settle.check: ok");
