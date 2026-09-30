// The auction lifecycle from the operator side, run by the scheduler tick:
//   plan      the calendar (calendar.ts) → planned rows in lum_auctions
//   schedule  planned auctions due within the horizon → AuctionPool.schedule (stock auctions quote in TreasuryQuote)
//   pin       at the call time → AuctionPool.pin (permissionless; an auction without orders or prices voids itself)
//   settle    pinned auctions → open each sealed order (committee.ts), clear (engine/clearing.ts via settle.ts), prove
//             AuctionClearProof and send settleAuction with every owner's result sealed to their viewing key
// Clearing and proving run in one step, so the plaintext orders never reach the database. The chain is the state:
// every step recomputes from it (and from the indexed events), and a send still in flight is skipped by its key.
import { hexlify, toBeHex, toUtf8Bytes } from "ethers";
import auctionClear from "@/shielded/circuits/auction_clear.json";
import rfqCross from "@/shielded/circuits/rfq_cross.json";
import { seal } from "@/shielded/crypto";
import { hex, ready } from "@/shielded/protocol";
import { prove } from "@/shielded/prove";
import { commitmentOf, feeBlindingOf, openingFromJson, openingToJson, settleAuction, settleRfq, type OrderOpening, type PinnedAuction, type SettledOrder } from "@/shielded/settle";
import { planAuctions, type CorporateAction, type MarketDay } from "../calendar";
import { provider } from "../chain";
import { rpc } from "../db";
import { env } from "../env";
import { openOrder, orderCiphertexts, sealingPublicKey, type OpenAuction } from "./committee";
import { DESK_ABI, deployment, pool } from "./contract";
import { inFlightKeys, sendOperator, sendPool } from "./sends";

export const KINDS = ["OPEN", "CLOSE", "MIDNIGHT", "NAV", "RFQ"] as const;
const PLAN_DAYS = 7;
const MIN_LEAD_SEC = 120; // schedule() needs a call in the future; leave time for the send to mine
const HORIZON_SEC = 36 * 3_600; // auctions go on chain this far ahead, so orders (and rolls) always have a target
const MAX_SCHEDULE_SENDS = 8;
const SETTLE_BUDGET_MS = 150_000;

interface Asset {
  symbol: string;
  address: string;
  kind: "stock" | "quote";
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** lum_assets from the deployment file: the five stock tokens and the two quote tokens (TQ reads as its own feed). */
export async function seedAssets() {
  const d = deployment();
  const stocks = (["TSLA", "AMZN", "AMD", "PLTR", "NFLX"] as const).map((s) => ({ symbol: s, address: d.tokens[s], feed: d.feeds[s], decimals: 18, kind: "stock" }));
  const quotes = [
    { symbol: "TQ", address: d.tokens.TQ, feed: d.tokens.TQ, decimals: 6, kind: "quote" },
    { symbol: "USDG", address: d.tokens.USDG, feed: d.feeds.USDG, decimals: 6, kind: "quote" },
  ];
  await rpc("lum_assets_put", { p_rows: [...stocks, ...quotes] });
  return { assets: stocks.length + quotes.length };
}

/** Writes the next PLAN_DAYS of calendar auctions into lum_auctions (a plan the calendar dropped is voided there). */
export async function planCalendar(now = new Date()) {
  const assets = await rpc<Asset[]>("lum_assets_list", {});
  const stocks = assets.filter((a) => a.kind === "stock").map((a) => a.symbol);
  if (stocks.length === 0) return { waiting: "no assets (seed lum_assets from the deployment)" };
  const to = new Date(now.getTime() + (PLAN_DAYS + 1) * 86_400_000);
  const cal = await rpc<{ days: MarketDay[]; actions: CorporateAction[] }>("lum_calendar_between", { p_from: isoDay(now), p_to: isoDay(to) });
  const planned = planAuctions(stocks, now, PLAN_DAYS, cal.days, cal.actions);
  const inserted = await rpc<number>("lum_auctions_plan", {
    p_rows: planned.map((p) => ({ key: p.key, symbol: p.symbol, kind: p.kind, callTime: p.callTime.toISOString() })),
  });
  return { planned: planned.length, inserted };
}

/** Puts planned auctions due within the horizon on chain. */
export async function scheduleAuctions() {
  const d = deployment();
  const due = await rpc<{ key: string; symbol: string; kind: string; callTime: number }[]>("lum_auctions_to_schedule", {
    p_min_lead_sec: MIN_LEAD_SEC,
    p_horizon_sec: HORIZON_SEC,
  });
  if (due.length === 0) return { idle: true };
  const busy = await inFlightKeys();
  const sent: string[] = [];
  for (const a of due.slice(0, MAX_SCHEDULE_SENDS)) {
    const key = `schedule:${a.key}`;
    if (busy.has(key)) continue;
    const asset = a.kind === "NAV" ? d.tokens.TQ : d.tokens[a.symbol as keyof typeof d.tokens];
    const quote = a.kind === "NAV" ? d.tokens.USDG : d.tokens.TQ;
    if (!asset) continue;
    const tx = await sendPool("schedule", [asset, quote, KINDS.indexOf(a.kind as (typeof KINDS)[number]), a.callTime], key);
    if (!tx) break;
    sent.push(tx);
  }
  return { due: due.length, sent: sent.length, ...(due.length > MAX_SCHEDULE_SENDS ? { left: due.length - MAX_SCHEDULE_SENDS } : {}) };
}

/** Pins every indexed auction whose call time has passed. */
export async function pinAuctions() {
  const open = await rpc<OpenAuction[]>("lum_pool_open_auctions", {});
  const now = (await provider().getBlock("latest"))!.timestamp;
  const due = open.filter((a) => !a.pinned && a.callTime <= now);
  if (due.length === 0) return { idle: true };
  const [c, busy] = [pool(), await inFlightKeys()];
  const sent: string[] = [];
  for (const a of due) {
    if (busy.has(`pin:${a.id}`)) continue;
    const s = await c.getFunction("auctions")(a.id);
    if (s.callBlock !== 0n || s.voided || s.settled) continue; // the indexer has not caught up
    const tx = await sendPool("pin", [a.id], `pin:${a.id}`);
    if (!tx) break;
    sent.push(tx);
  }
  return { due: due.length, sent: sent.length };
}

async function settleOne(a: OpenAuction) {
  await ready();
  const c = pool();
  const s = await c.getFunction("auctions")(a.id);
  if (s.settled || s.voided) return { indexing: true };
  const [market, quoteMarket, feeOwner, list] = await Promise.all([
    c.getFunction("markets")(s.asset),
    c.getFunction("markets")(s.quote),
    c.getFunction("feeOwner")(),
    c.getFunction("orderList")(a.id) as Promise<string[]>,
  ]);
  const asset = BigInt(s.asset);

  // slot order is the chain's; a cancelled slot is 0 there
  const ciphertexts = new Map((await orderCiphertexts(a)).map((o) => [o.slot, o]));
  const slots: (OrderOpening | null)[] = [];
  for (let slot = 0; slot < list.length; slot++) {
    const commitment = list[slot]!.toLowerCase();
    if (BigInt(commitment) === 0n) {
      slots.push(null);
      continue;
    }
    const o = ciphertexts.get(slot);
    const text = o?.ciphertext ? await openOrder(o.ciphertext) : null;
    const opening = text ? openingFromJson(text) : null;
    let opens = false;
    try {
      opens = opening !== null && hex(commitmentOf(asset, opening)) === commitment;
    } catch {
      // an out-of-field value in the opening
    }
    if (!opening || !opens) {
      console.error("auction cannot be settled: an order does not open its commitment", { id: a.id, slot });
      return { error: `slot ${slot} does not open its commitment (reclaimable once the auction is abandoned)` };
    }
    slots.push(opening);
  }

  const pinned = {
    asset,
    unit: BigInt(market.unit),
    quote: BigInt(s.quote),
    quoteUnit: BigInt(quoteMarket.unit),
    refUsd: BigInt(s.refUsd),
    capBps: BigInt(s.capBps),
    quoteUsd: BigInt(s.quoteUsd),
    feeBps: BigInt(s.feeBps),
    feeOwner: BigInt(feeOwner),
  };
  const feeBlinding = feeBlindingOf(BigInt(env("FEE_SECRET")), BigInt(a.id));
  if (a.kind === KINDS.indexOf("RFQ")) return settleBlock(a, pinned, slots, list, feeBlinding);
  const r = settleAuction(pinned, slots, feeBlinding);

  let rollInto = 0;
  const rolls = r.results.filter((x) => x.rolled);
  if (rolls.length) {
    const symbol = await rpc<string | null>("lum_symbol_of", { p_address: s.asset });
    const target = symbol ? await rpc<number | null>("lum_auction_roll_target", { p_symbol: symbol, p_after: new Date(Number(s.callTime) * 1000).toISOString() }) : null;
    if (target === null) return { waiting: "no collecting auction of this pair to roll orders into yet" };
    rollInto = Number(target);
    // rolled orders rest in the next auction; their openings must exist before the transaction that creates them
    const rows = await Promise.all(rolls.map(async (x) => ({ commitment: hex(x.residual), sealed: await seal(sealingPublicKey(), openingToJson(x.rolled!)) })));
    await rpc("lum_pool_put_openings", { p_rows: rows });
  }

  const notes = await Promise.all(
    slots.map((o, slot) => {
      const x = r.results.find((y) => y.slot === slot);
      if (!o || !x) return "";
      const result: SettledOrder = {
        auctionId: a.id,
        slot,
        commitment: list[slot]!.toLowerCase(),
        pStar: String(r.clearing.pStar),
        qty: String(x.qty),
        quote: String(x.quote),
        fee: String(x.fee),
        left: String(x.left),
        rolls: x.rolls,
      };
      return seal(o.viewPub, JSON.stringify(result)).catch(() => "");
    }),
  );

  // the fee note holds the fees plus the rounding left between what buyers paid and sellers received (settle.ts)
  const feeAmount = r.results.reduce((sum, x) => sum + x.fee + (slots[x.slot]!.buy ? x.quote : -x.quote), 0n);
  if (feeAmount > 0n) {
    await rpc("lum_pool_put_fee_note", { p_commitment: hex(r.onchain.feeNote), p_quote: s.quote, p_auction_id: a.id, p_amount: String(feeAmount * pinned.quoteUnit) });
  }
  const { proof } = await prove(auctionClear as never, r.inputs, 4);
  const clearing = [r.onchain.pStar, r.onchain.crossedQty, r.onchain.fills.map(hex), r.onchain.residuals.map(hex), r.onchain.rolls, hex(r.onchain.feeNote)];
  const tx = await sendPool("settleAuction", [a.id, clearing, rollInto, proof, hexlify(toUtf8Bytes(JSON.stringify(notes)))], `settle:${a.id}`);
  return tx
    ? { settled: true, pStar: String(r.clearing.pStar), crossedQty: String(r.clearing.volume), orders: slots.filter(Boolean).length, tx }
    : { waiting: "an operator transaction is still pending" };
}

/** An RFQ auction: both orders cross whole at the reference or are refunded (rfq_cross), settled through RfqDesk. */
async function settleBlock(a: OpenAuction, pinned: PinnedAuction, slots: (OrderOpening | null)[], list: string[], feeBlinding: bigint) {
  const r = settleRfq(pinned, slots, feeBlinding);
  const notes = await Promise.all(
    slots.map((o, slot) => {
      const x = r.results.find((y) => y.slot === slot);
      if (!o || !x) return "";
      const result: SettledOrder = {
        auctionId: a.id,
        slot,
        commitment: list[slot]!.toLowerCase(),
        pStar: String(pinned.refUsd),
        qty: String(x.qty),
        quote: String(x.quote),
        fee: String(x.fee),
        left: String(x.left),
        rolls: false,
      };
      return seal(o.viewPub, JSON.stringify(result)).catch(() => "");
    }),
  );
  if (r.fees > 0n) {
    await rpc("lum_pool_put_fee_note", { p_commitment: hex(r.onchain.feeNote), p_quote: toBeHex(pinned.quote, 20), p_auction_id: a.id, p_amount: String(r.fees * pinned.quoteUnit) });
  }
  const { proof } = await prove(rfqCross as never, r.inputs, 4);
  const data = DESK_ABI.encodeFunctionData("settle", [a.id, r.onchain.fills.map(hex), r.onchain.residuals.map(hex), hex(r.onchain.feeNote), r.crossedQty, proof, hexlify(toUtf8Bytes(JSON.stringify(notes)))]);
  const tx = await sendOperator(deployment().RfqDesk, data, `settle:${a.id}`);
  return tx ? { settled: true, rfq: true, crossedQty: String(r.crossedQty), tx } : { waiting: "an operator transaction is still pending" };
}

/** Settles pinned auctions, oldest first, within a time budget. */
export async function settleAuctions() {
  const open = (await rpc<OpenAuction[]>("lum_pool_open_auctions", {})).filter((a) => a.pinned);
  if (open.length === 0) return { idle: true };
  const busy = await inFlightKeys();
  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  for (const a of open) {
    if (busy.has(`settle:${a.id}`)) continue;
    if (Date.now() - started > SETTLE_BUDGET_MS) break;
    const r = await settleOne(a).catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
    results.push({ id: a.id, ...r });
  }
  const errors = results.filter((r) => "error" in r);
  return { auctions: results, ...(errors.length ? { error: errors.map((r) => `${r["id"]}: ${r["error"]}`).join("; ").slice(0, 300) } : {}) };
}
