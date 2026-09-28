// bun circuits/tests/auction.fixture.ts
// Real proofs for contracts/test/AuctionFlow.t.sol. A buyer's TQ note and two sellers' TSLA notes are deposited and
// appended; a buy of 3 @ $255, a rolling sell of 2 @ $245 and an at-auction sell of 2 are placed in auction 0; it is
// pinned at a $250 reference and settled with an AuctionClearProof built by src/shielded/settle.ts (the operator's
// code) at p* = $245; the outputs are appended, the at-auction seller withdraws its TQ fill with a TransactProof, and
// the rolled remainder is cancelled from auction 1 with a ReclaimProof.
import { writeFileSync } from "node:fs";
import { AbiCoder, keccak256, ZeroAddress } from "ethers";
import { settleAuction, commitmentOf, PLAIN, type OrderOpening, type PinnedAuction } from "../../src/shielded/settle";
import { blind, depositLabel, DEPTH, FIELD, note, nullifier, orderNullifier, ownerPub, pathOf, treeUpdateInputs } from "./hash";
import { DIR, fixtureJson, prove, type Value } from "./prove";

const U = 1_000_000n;
const UNIT = 10n ** 12n; // TSLA: 18 decimals

// Must match the Foundry test (deployCodeTo addresses).
const CHAIN_ID = 31337n;
const POOL = "0x00000000000000000000000000000000000a0c71";
const TSLA = 0x000000000000000000000000000000000000c9f9n;
const TQ = 0x0000000000000000000000000000000000007e7en;
const DEPOSITOR = "0x000000000000000000000000000000000000d0d0";
const TO = "0x000000000000000000000000000000000000a11c";
const FEE_OWNER = ownerPub(424242n);
const AUCTION = 0n;

const abi = AbiCoder.defaultAbiCoder();
const context = (to: string, relayer: string, fee: bigint) =>
  BigInt(keccak256(abi.encode(["uint256", "address", "address", "address", "uint256"], [CHAIN_ID, POOL, to, relayer, fee]))) % FIELD;
const placementContext = (id: bigint, relayer: string, fee: bigint) =>
  BigInt(keccak256(abi.encode(["uint256", "address", "uint256", "address", "uint256"], [CHAIN_ID, POOL, id, relayer, fee]))) % FIELD;
const values = (o: Record<string, unknown>): Record<string, Value> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (typeof v === "number" ? BigInt(v) : v) as Value]));
const zeroPath = () => Array<bigint>(DEPTH).fill(0n);
const plainTerms = { min_qty: 0n, display: 0n, peg: 0n, rfq: 0n } as unknown as Value;

const buyer = { secret: 1001n, blinding: 11n, changeBlinding: 12n, amount: 1000n * U, asset: TQ };
const sellerA = { secret: 2002n, blinding: 21n, changeBlinding: 22n, amount: 5n * 10n ** 18n, asset: TSLA };
const sellerB = { secret: 3003n, blinding: 31n, changeBlinding: 32n, amount: 2n * 10n ** 18n, asset: TSLA };
const label = (i: number) => depositLabel(CHAIN_ID, POOL, DEPOSITOR, BigInt(i)); // deposits 0, 1, 2 in that order
const opening = (secret: bigint, o: Pick<OrderOpening, "salt" | "buy" | "qty" | "lock" | "roll" | "rollsLeft" | "label" | "hasLimit" | "limitUsd">): OrderOpening => ({
  owner: ownerPub(secret), viewPub: "0x", terms: PLAIN, ...o,
});
const buy = opening(buyer.secret, { salt: 5555n, buy: true, qty: 3n * U, hasLimit: true, limitUsd: 255n * U, lock: 900n * U, roll: false, rollsLeft: 0, label: label(0) });
const sellA = opening(sellerA.secret, { salt: 6666n, buy: false, qty: 2n * U, hasLimit: true, limitUsd: 245n * U, lock: 2n * U, roll: true, rollsLeft: 3, label: label(1) });
const sellB = opening(sellerB.secret, { salt: 7777n, buy: false, qty: 2n * U, hasLimit: false, limitUsd: 0n, lock: 2n * U, roll: false, rollsLeft: 0, label: label(2) });

// 1. deposits, appended
const who = [buyer, sellerA, sellerB];
const leaves = who.map((w, i) => note(ownerPub(w.secret), w.asset, w.amount, w.blinding, label(i)));
who.forEach((w, i) =>
  prove("deposit", `flow_deposit_${i}`, { owner: ownerPub(w.secret), blinding: w.blinding, commitment: leaves[i]!, asset: w.asset, amount: w.amount, label: label(i) }),
);
const advance1 = treeUpdateInputs(leaves, 0, leaves.length);
prove("tree_update", "flow_advance1", values(advance1));
const root1 = advance1.new_root;

// 2. orders into auction 0, self-submitted
const place = (name: string, w: typeof buyer, index: number, o: OrderOpening) => {
  const unit = o.buy ? 1n : UNIT;
  const change = note(o.owner, w.asset, w.amount - o.lock * unit, w.changeBlinding, o.label);
  const spent = nullifier(w.secret, leaves[index]!, BigInt(index));
  const commitment = commitmentOf(TSLA, o);
  prove("order_validity", name, {
    secret: w.secret, label: o.label, blinding: w.blinding, note_amount: w.amount, leaf_index: BigInt(index), path: pathOf(leaves, index),
    change_blinding: w.changeBlinding, fee_label: 0n, fee_note_amount: 0n, fee_blinding: 0n, fee_index: 0n, fee_path: zeroPath(),
    fee_change_blinding: 0n, buy: o.buy, qty: o.qty, has_limit: o.hasLimit, limit_usd: o.limitUsd, roll: o.roll,
    rolls_left: BigInt(o.rollsLeft), lock: o.lock, salt: o.salt, root: root1, spent, fee_spent: 0n, change, fee_change: 0n,
    asset: TSLA, unit: UNIT, quote_token: TQ, quote_unit: 1n, commitment, fee: 0n, context: placementContext(AUCTION, ZeroAddress, 0n),
    terms: plainTerms,
  });
  return { root: root1, spent, change, commitment };
};
const placements = [place("flow_order_0", buyer, 0, buy), place("flow_order_1", sellerA, 1, sellA), place("flow_order_2", sellerB, 2, sellB)];

// 3. settlement, exactly as the operator builds it
const pinned: PinnedAuction = { asset: TSLA, unit: UNIT, quote: TQ, quoteUnit: 1n, refUsd: 250n * U, capBps: 500n, quoteUsd: U, feeBps: 5n, feeOwner: FEE_OWNER };
const s = settleAuction(pinned, [buy, sellA, sellB], 777n);
const { orders, ...scalars } = s.inputs;
const t0 = Date.now();
prove("auction_clear", "flow_settle", values(scalars), { orders: orders.map((o) => values(o as Record<string, unknown>)) });
const proveMs = Date.now() - t0;

// 4. append what placement and settlement queued: the changes, then per order its fill and refund (rolled orders rest
//    in auction 1 instead), then the fee note
const queued = placements.map((p) => p.change);
s.results.forEach((x) => {
  queued.push(x.fill);
  if (!x.rolls) queued.push(x.residual);
});
queued.push(s.onchain.feeNote);
const all = [...leaves, ...queued];
const advance2 = treeUpdateInputs(all, leaves.length, queued.length);
prove("tree_update", "flow_advance2", values(advance2));
const root2 = advance2.new_root;

// 5. the at-auction seller withdraws its whole TQ fill (dummy second input, zero outputs, no association proof)
const sold = s.results[2]!;
const fillIndex = all.indexOf(sold.fill);
const payout = sold.quote - sold.fee;
const dummy = note(sellB.owner, TQ, 0n, 555n, sellB.label);
const withdrawal = {
  nullifier0: nullifier(sellerB.secret, sold.fill, BigInt(fillIndex)),
  nullifier1: nullifier(sellerB.secret, dummy, 0n),
  output0: note(sellB.owner, TQ, 0n, 99n, sellB.label),
  output1: note(sellB.owner, TQ, 0n, 98n, sellB.label),
};
prove("transact", "flow_withdraw", {
  secret: sellerB.secret, label: sellB.label, in_amounts: [payout, 0n], in_blindings: [blind(sellB.salt, 0n), 555n],
  in_indexes: [BigInt(fillIndex), 0n], in_paths: [pathOf(all, fillIndex), zeroPath()], out_owners: [sellB.owner, sellB.owner],
  out_amounts: [0n, 0n], out_blindings: [99n, 98n], asp_index: 0n, asp_path: zeroPath(), root: root2, asp_root: 0n,
  spent: [withdrawal.nullifier0, withdrawal.nullifier1], outputs: [withdrawal.output0, withdrawal.output1], asset: TQ,
  released: payout, fee: 0n, context: context(TO, ZeroAddress, 0n),
});

// 6. seller A cancels the rolled remainder from auction 1 while it is still collecting
const rolled = s.results[1]!.rolled!;
const rolledCommitment = s.results[1]!.residual;
const cancelSpent = orderNullifier(sellerA.secret, rolledCommitment);
const cancelRefund = note(rolled.owner, TSLA, rolled.lock * UNIT, blind(rolled.salt, 3n), rolled.label);
prove("reclaim", "flow_cancel", {
  secret: sellerA.secret, label: rolled.label, buy: false, qty: rolled.qty, has_limit: rolled.hasLimit, limit_usd: rolled.limitUsd,
  roll: rolled.roll, rolls_left: BigInt(rolled.rollsLeft), lock: rolled.lock, salt: rolled.salt, asset: TSLA, unit: UNIT,
  quote_token: TQ, quote_unit: 1n, commitment: rolledCommitment, spent: cancelSpent, refund: cancelRefund, terms: plainTerms,
});

writeFileSync(
  `${DIR}/target/fixtures/flow.json`,
  fixtureJson({
    feeOwner: FEE_OWNER,
    deposits: who.map((w, i) => ({ asset: w.asset, amount: w.amount, commitment: leaves[i] })),
    root1,
    placements,
    pStar: s.onchain.pStar,
    crossedQty: s.onchain.crossedQty,
    fills: s.onchain.fills,
    residuals: s.onchain.residuals,
    rolls: s.onchain.rolls,
    feeNote: s.onchain.feeNote,
    advance2Count: BigInt(queued.length),
    root2,
    payout,
    withdrawal,
    cancel: { commitment: rolledCommitment, spent: cancelSpent, refund: cancelRefund },
  }),
);
console.log(`auction.fixture: ok — p* ${s.onchain.pStar}, crossed ${s.onchain.crossedQty}, ${queued.length} leaves appended, auction_clear proved in ${proveMs} ms (native bb)`);
