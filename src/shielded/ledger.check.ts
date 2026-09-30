// bun src/shielded/ledger.check.ts
// A buyer and a rolling seller deposit, place orders the way client.ts does, and are settled by the operator's own
// settle.ts; rebuild() must then find each side's change, fill, released lock and the rolled remainder (which is
// emitted before its AuctionSettled, in the next auction).
import { hexlify, toUtf8Bytes } from "ethers";
import { keysFromSignature, seal, type ShieldedKeys } from "./crypto";
import { DEPOSIT_DOMAIN, rebuild, type OrderMemo, type PoolEvent } from "./ledger";
import { commitmentOf, openingToJson, settleAuction, type OrderOpening, type SettledOrder } from "./settle";
import { PLAIN, blind, depositLabel, hex, note, nullifier, ownerPub, ready } from "./protocol";

const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(`ledger.check: ${msg}`);
};
const U = 1_000_000n;
const UNIT = 10n ** 12n;
const POOL = "0x3b0f468A1022AEcdA5E9E3c631D858b77377ec7C";
const TSLA = 0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4en;
const TQ = 0xf96e4e97e2bbecec392733b49fa42490ec5f3420n;
const addr = (x: bigint) => "0x" + x.toString(16).padStart(40, "0");
const unit = (asset: bigint) => (asset === TSLA ? UNIT : 1n);
const utf8Hex = (s: string) => hexlify(toUtf8Bytes(s));

await ready();
const leaves: bigint[] = [];
const events: PoolEvent[] = [];
let block = 1;
const emit = (name: string, args: Record<string, unknown>, tx = `0x${block}`) => events.push({ block: block++, log_index: 0, tx_hash: tx, name, args });

interface Party {
  keys: ShieldedKeys;
  wallet: string;
  asset: bigint;
  amount: bigint;
  index: number;
  label: bigint;
  blinding: bigint;
}
const party = (sig: string, wallet: string, asset: bigint, amount: bigint): Party => {
  const keys = keysFromSignature(sig);
  const label = depositLabel(46630n, POOL, wallet, 0n);
  const blinding = blind(keys.blindKey, DEPOSIT_DOMAIN);
  const commitment = note(keys.owner, asset, amount, blinding, label);
  emit("Deposited", { from: wallet, asset: addr(asset), amount: String(amount), commitment: hex(commitment), label: String(label) });
  leaves.push(commitment);
  return { keys, wallet, asset, amount, index: leaves.length - 1, label, blinding };
};
const buyer = party("0x01", "0x000000000000000000000000000000000000b0b0", TQ, 1000n * U);
const seller = party("0x02", "0x000000000000000000000000000000000000c0c0", TSLA, 5n * 10n ** 18n);
emit("AuctionScheduled", { id: "0", asset: addr(TSLA), quote: addr(TQ), kind: "1", callTime: "100", capBps: "500" });
emit("AuctionScheduled", { id: "1", asset: addr(TSLA), quote: addr(TQ), kind: "1", callTime: "200", capBps: "500" });

// orders built as ShieldedAccount.placeOrder builds them (self-submitted: no fee note)
const place = async (p: Party, slot: number, o: Omit<OrderOpening, "owner" | "salt" | "label" | "terms" | "viewPub">) => {
  const { secret, owner, viewPub } = p.keys;
  const spent = nullifier(secret, leaves[p.index]!, BigInt(p.index));
  const opening: OrderOpening = { ...o, owner, salt: blind(secret, (spent + 1n) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n), label: p.label, terms: PLAIN, viewPub };
  const need = o.lock * (o.buy ? 1n : UNIT);
  const changeBlinding = blind(secret, spent);
  const memo: OrderMemo = { opening: openingToJson(opening), nullifier: String(spent), input: hex(leaves[p.index]!), noteAsset: String(p.asset), change: String(p.amount - need), changeBlinding: String(changeBlinding) };
  leaves.push(note(owner, p.asset, p.amount - need, changeBlinding, p.label));
  const envelope = JSON.stringify({ o: "0x", u: await seal(viewPub, JSON.stringify(memo)) });
  emit("OrderResting", { id: "0", slot: String(slot), commitment: hex(commitmentOf(TSLA, opening)), sealedOrder: utf8Hex(envelope) });
  return opening;
};
const buy = await place(buyer, 0, { buy: true, qty: 3n * U, hasLimit: true, limitUsd: 255n * U, roll: false, rollsLeft: 0, lock: 900n * U });
const sell = await place(seller, 1, { buy: false, qty: 4n * U, hasLimit: true, limitUsd: 245n * U, roll: true, rollsLeft: 11, lock: 4n * U });
emit("AuctionPinned", { id: "0", callBlock: "9", refUsd: String(250n * U), quoteUsd: String(U) });

// the operator's settlement, and its sealed per-order results
const s = settleAuction({ asset: TSLA, unit: UNIT, quote: TQ, quoteUnit: 1n, refUsd: 250n * U, capBps: 500n, quoteUsd: U, feeBps: 5n, feeOwner: ownerPub(9n) }, [buy, sell], 777n);
const notes = await Promise.all(
  s.results.map((r) => {
    const o = [buy, sell][r.slot]!;
    const result: SettledOrder = { auctionId: 0, slot: r.slot, commitment: hex(commitmentOf(TSLA, o)), pStar: String(s.onchain.pStar), qty: String(r.qty), quote: String(r.quote), fee: String(r.fee), left: String(r.left), rolls: r.rolls };
    return seal(o.viewPub, JSON.stringify(result));
  }),
);
for (const r of s.results) {
  leaves.push(r.fill);
  if (r.rolls) emit("OrderResting", { id: "1", slot: "0", commitment: hex(r.residual), sealedOrder: "0x" }, "0xsettle");
  else leaves.push(r.residual);
}
leaves.push(s.onchain.feeNote);
emit("AuctionSettled", { id: "0", pStar: String(s.onchain.pStar), crossedQty: String(s.onchain.crossedQty), notes: utf8Hex(JSON.stringify(notes)) }, "0xsettle");

const [b, sl] = s.results;
assert(b!.qty === 3n * U && sl!.qty === 3n * U && sl!.rolls, `expected 3 crossed with the seller rolling 1, got ${b!.qty} / ${sl!.qty}`);

const mine = (p: Party) => rebuild(p.keys, p.wallet, leaves, events, unit);
const B = await mine(buyer);
const has = (x: Awaited<ReturnType<typeof mine>>, origin: string, asset: bigint, amount: bigint) =>
  assert(x.notes.some((n) => n.origin === origin && n.asset === asset && n.amount === amount && !n.spent), `missing ${origin} ${amount} of ${asset.toString(16).slice(0, 4)}`);
has(B, "Order change", TQ, 100n * U);
has(B, "Fill", TSLA, 3n * U * UNIT);
has(B, "Released lock", TQ, b!.left);
assert(B.orders.length === 1 && B.orders[0]!.status === "settled", "buyer order settled");
assert(B.notes.find((n) => n.origin === "Deposit")!.spent, "buyer deposit spent by the order");

const S = await mine(seller);
has(S, "Order change", TSLA, 1n * 10n ** 18n);
has(S, "Fill", TQ, sl!.quote - sl!.fee);
assert(S.orders.length === 2, `seller sees the settled order and its roll, got ${S.orders.length}`);
const rolled = S.orders.find((o) => o.auctionId === 1)!;
assert(rolled.status === "open" && rolled.opening.qty === 1n * U && rolled.opening.rollsLeft === 10, "rolled remainder rests in auction 1");
assert(!S.notes.some((n) => n.origin === "Released lock"), "a rolled order releases nothing");

// the seller cancels the roll: the refund comes back as blind(salt, 3)
leaves.push(note(seller.keys.owner, TSLA, rolled.opening.lock * UNIT, blind(rolled.opening.salt, 3n), rolled.opening.label));
emit("OrderReclaimed", { id: "1", slot: "0", cancelled: true });
const S2 = await mine(seller);
has(S2, "Cancelled order", TSLA, 1n * U * UNIT);
assert(S2.orders.find((o) => o.auctionId === 1)!.status === "cancelled", "roll cancelled");
console.log(`ledger.check: ok (p* ${s.onchain.pStar})`);
