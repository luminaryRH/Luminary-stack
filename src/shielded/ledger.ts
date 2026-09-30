// Rebuilds a shielded account from public pool data. Shared by the browser client and auditor tooling. With the spending
// secret (the owner) a note counts as spent when its nullifier appears; with only the viewing material of a disclosure
// grant (an auditor) when a memo the owner sealed lists its commitment.
//
// Auctions: AuctionScheduled names each auction's asset and quote token. An order rests in an auction (OrderResting); the
// auction is pinned at its call, then settled (AuctionSettled, whose `notes` carry each order's result sealed to its
// owner) or voided (AuctionVoided). Settlement outputs follow src/shielded/settle.ts: the fill is blind(salt, 0), the
// released lock blind(salt, 1), a rolled remainder rests in the next auction with salt blind(salt, 2), and a reclaimed
// lock comes back as blind(salt, 3).
import { getAddress, toUtf8String } from "ethers";
import { open } from "./crypto";
import { commitmentOf, openingFromJson, type OrderOpening, type SettledOrder } from "./orders";
import { ETH, blind, note, nullifier } from "./protocol";

export const DEPOSIT_DOMAIN = 1n << 32n; // k-th deposit from a wallet: blinding = blind(blindKey, DEPOSIT_DOMAIN + k)

/** Everything needed to read an account. `secret` only on the owner's device; a disclosure grant carries the rest. */
export interface ViewKeys {
  owner: bigint;
  viewPriv: string;
  blindKey: bigint;
  secret?: bigint;
}

export interface PoolEvent {
  block: number;
  log_index: number;
  tx_hash: string;
  name: string;
  args: Record<string, any>;
}

export interface Note {
  asset: bigint;
  amount: bigint; // base units
  blinding: bigint;
  label: bigint; // the deposit this value descends from; only same-label notes combine
  commitment: bigint;
  index: number;
  nullifier: bigint | null; // null without the secret
  spent: boolean;
  origin: string;
}

/** AuctionPool.Kind */
export const KINDS = ["OPEN", "CLOSE", "MIDNIGHT", "NAV", "RFQ"] as const;
export type AuctionKind = (typeof KINDS)[number];

/** An auction as the pool's events describe it. */
export interface PoolAuction {
  id: number;
  asset: bigint;
  quote: bigint;
  kind: AuctionKind;
  callTime: number; // unix seconds
  pinned: boolean;
  settled: boolean;
  voided: boolean;
  pStar?: bigint; // micro-USD, once settled
  refUsd?: bigint; // micro-USD, once pinned
}

export interface MyOrder {
  auctionId: number;
  asset: bigint;
  quote: bigint;
  slot: number;
  commitment: bigint;
  opening: OrderOpening;
  /** open: collecting, cancellable. pinned: past its call, waiting for settlement. void: reclaimable. */
  status: "open" | "pinned" | "settled" | "void" | "cancelled" | "reclaimed";
  result?: SettledOrder;
}

/** One line of this account's own pool history. Amounts are in base units. */
export interface Activity {
  type: string;
  detail: string;
  asset: bigint;
  amount: bigint | null;
  block: number;
  tx: string;
  feeWei?: bigint; // ETH this line paid to the relayer
  priceUsd?: bigint; // fills: p*, micro-USD per token
}

/** What the owner keeps about an order inside its sealed envelope (`u`), to rebuild it and its change notes anywhere. */
export interface OrderMemo {
  opening: string;
  nullifier: string;
  input: string; // the locked note's commitment
  noteAsset: string;
  change: string;
  changeBlinding: string;
  feeNullifier?: string;
  feeInput?: string;
  feeChange?: string;
  feeChangeBlinding?: string;
  feeLabel?: string;
}

/** A transaction's memo: the label, the spent notes' commitments and [amount, blinding] per output. A transfer seals
 * two of these: the sender's (what it spent, both outputs) and the recipient's (only their own note). */
export interface TransactMemo {
  label: string;
  ins: string[];
  outs: [string, string][];
  kind?: "transfer";
}

// Changing this list must also change CACHE_KEY in client.ts, or cached snapshots keep missing the new events.
export const EVENT_NAMES = [
  "Deposited",
  "Transacted",
  "AuctionScheduled",
  "OrderResting",
  "OrderFeePaid",
  "AuctionPinned",
  "AuctionSettled",
  "AuctionVoided",
  "OrderReclaimed",
];

/** The public pool data a client holds between syncs. Only chain data: never keys or anything decrypted. */
export interface PoolSnapshot {
  pool: string; // lowercase pool address the data belongs to
  leaves: bigint[];
  events: PoolEvent[];
}

const LEAF_PAGE = 50_000;

/**
 * Public pool data from the site API (`base` = "" in the browser). With `prev` from the same pool it fetches only what
 * is new: leaves after the last known index, and events from the last known block on (that block is read again and
 * replaced, so a block read half-way last time is completed). The result equals a full load.
 */
export async function loadPool<C>(base = "", prev: PoolSnapshot | null = null) {
  const get = async <T,>(path: string): Promise<T> => {
    const res = await fetch(base + path);
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
    return body.data as T;
  };
  const config = await get<C>("/api/pool");
  const pool = String((config as { pool?: string }).pool ?? "").toLowerCase();
  const queued = Number((config as { tree?: { queued?: number } }).tree?.queued ?? Number.POSITIVE_INFINITY);
  // the mirror never shrinks for a pool; if it looks like it did, trust nothing cached
  const known = prev && prev.pool === pool && prev.leaves.length <= queued ? prev : null;

  const fresh: string[] = [];
  for (const from = known?.leaves.length ?? 0; ; ) {
    const page = await get<{ leaves: string[] }>(`/api/pool/leaves?from=${from + fresh.length}`);
    fresh.push(...page.leaves);
    if (page.leaves.length < LEAF_PAGE) break;
  }
  const leaves = [...(known?.leaves ?? []), ...fresh.map((x) => BigInt(x))];

  const last = known?.events.at(-1)?.block;
  const events =
    known && last !== undefined
      ? [...known.events.filter((e) => e.block < last), ...(await loadEvents(get, EVENT_NAMES, last - 1))]
      : await loadEvents(get, EVENT_NAMES);
  return { config, pool, leaves, events };
}

const PAGE = 5_000;
/** Past every log index: a cursor at (block, LAST_LOG) resumes at the next block, so `from` means a whole block. */
export const LAST_LOG = 2_147_483_647;

export async function loadEvents(get: <T>(path: string) => Promise<T>, names: string[], from = -1) {
  const events: PoolEvent[] = [];
  // the cursor is the last row's (block, log_index), so a page that cuts inside a block resumes inside it
  for (let block = from, log = LAST_LOG; ; ) {
    const page = await get<{ events: PoolEvent[] }>(`/api/pool/events?names=${names.join(",")}&after=${block}&afterLog=${log}`);
    events.push(...page.events);
    if (page.events.length < PAGE) break;
    ({ block, log_index: log } = page.events[page.events.length - 1]!);
  }
  return events.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
}

/** Opens a sealed payload with an account's viewing key, or null when it is not for this account. */
export type Opener = (sealed: string) => Promise<string | null>;

/** Trial decryption, remembered per account in memory: every sync replays the whole history. */
export function memoOpener(viewPriv: string): Opener {
  const cache = new Map<string, string | null>();
  return async (sealed) => {
    if (cache.has(sealed)) return cache.get(sealed)!;
    const text = await open(viewPriv, sealed);
    cache.set(sealed, text);
    return text;
  };
}

/** Every auction the events describe, by id. */
export function auctionsOf(events: PoolEvent[]) {
  const auctions = new Map<number, PoolAuction>();
  for (const e of events) {
    const a = e.args;
    const id = Number(a["id"]);
    if (e.name === "AuctionScheduled") {
      auctions.set(id, {
        id,
        asset: BigInt(a["asset"]),
        quote: BigInt(a["quote"]),
        kind: KINDS[Number(a["kind"])] ?? "OPEN",
        callTime: Number(a["callTime"]),
        pinned: false,
        settled: false,
        voided: false,
      });
    } else if (auctions.has(id)) {
      const x = auctions.get(id)!;
      if (e.name === "AuctionPinned") Object.assign(x, { pinned: true, refUsd: BigInt(a["refUsd"]) });
      else if (e.name === "AuctionSettled") Object.assign(x, { settled: true, pStar: BigInt(a["pStar"]) });
      else if (e.name === "AuctionVoided") x.voided = true;
    }
  }
  return auctions;
}

/** Replays the pool's public history with an account's keys. `unit(asset)` = base units per micro-unit. */
export async function rebuild(keys: ViewKeys, wallet: string, leaves: bigint[], events: PoolEvent[], unit: (asset: bigint) => bigint, read: Opener = memoOpener(keys.viewPriv)) {
  const { secret, owner, blindKey } = keys;
  // leaf positions by commitment, so finding a note's index is a lookup instead of a scan over every leaf
  const positions = new Map<bigint, number[]>();
  leaves.forEach((c, i) => (positions.get(c)?.push(i) ?? positions.set(c, [i])));
  const notes: Note[] = [];
  const orders: MyOrder[] = [];
  const activity: Activity[] = [];
  const used = new Set<number>();
  const auctions = auctionsOf(events);
  const log = (e: PoolEvent, type: string, detail: string, asset: bigint, amount: bigint | null, extra: Pick<Activity, "feeWei" | "priceUsd"> = {}) =>
    activity.push({ type, detail, asset, amount, block: e.block, tx: e.tx_hash, ...extra });
  // a relayed order's fee is its own event in the same transaction
  const orderFees = new Map(events.filter((x) => x.name === "OrderFeePaid").map((x) => [x.tx_hash, BigInt(x.args["fee"])]));

  const add = (asset: bigint, amount: bigint, blinding: bigint, label: bigint, origin: string) => {
    const commitment = note(owner, asset, amount, blinding, label);
    const index = positions.get(commitment)?.find((i) => !used.has(i)) ?? -1;
    if (index < 0) return; // not indexed yet
    used.add(index);
    const nul = secret === undefined ? null : nullifier(secret, commitment, BigInt(index));
    notes.push({ asset, amount, blinding, label, commitment, index, nullifier: nul, spent: false, origin });
  };
  /** Marks a note spent: by nullifier with the secret, else by the commitment the owner's memo names. */
  const spend = (nul: string | undefined, commitment: string | undefined) => {
    const n =
      secret !== undefined
        ? nul === undefined ? undefined : notes.find((x) => x.nullifier === BigInt(nul) && !x.spent)
        : commitment === undefined ? undefined : notes.find((x) => x.commitment === BigInt(commitment) && !x.spent);
    if (n) n.spent = true;
    return n;
  };
  const lockAsset = (o: MyOrder) => (o.opening.buy ? o.quote : o.asset);

  // results sealed to this account, by order commitment
  const results = new Map<bigint, SettledOrder>();
  for (const e of events.filter((x) => x.name === "AuctionSettled")) {
    for (const s of parseList(e.args["notes"])) {
      const text = s ? await read(s) : null;
      if (!text) continue;
      try {
        const r = JSON.parse(text) as SettledOrder;
        results.set(BigInt(r.commitment), r);
      } catch {
        // not a result
      }
    }
  }

  const me = getAddress(wallet);
  let deposits = 0;
  for (const e of events) {
    const a = e.args;
    if (e.name === "Deposited") {
      if (getAddress(a["from"]) !== me) continue;
      const asset = BigInt(a["asset"]);
      const label = BigInt(a["label"]);
      for (let k = Math.max(0, deposits - 3); k <= deposits + 3; k++) {
        const blinding = blind(blindKey, DEPOSIT_DOMAIN + BigInt(k));
        if (note(owner, asset, BigInt(a["amount"]), blinding, label) === BigInt(a["commitment"])) {
          add(asset, BigInt(a["amount"]), blinding, label, "Deposit");
          log(e, "Deposit", "Moved into the shielded pool from your wallet.", asset, BigInt(a["amount"]));
          break;
        }
      }
      deposits++;
    } else if (e.name === "Transacted") {
      const text = await readTransact(read, a["memo"]);
      if (!text) continue; // not ours
      const memo = JSON.parse(text) as TransactMemo;
      const sent = memo.kind === "transfer" && memo.ins.length > 0; // the sender's copy; the recipient's has no inputs
      spend(a["nullifier0"], memo.ins[0]);
      spend(a["nullifier1"], memo.ins[1]);
      for (const [amount, blinding] of memo.outs) {
        // a transfer's first output belongs to the other side, so its commitment never matches a leaf here and add() drops it
        if (BigInt(amount) > 0n) add(BigInt(a["asset"]), BigInt(amount), BigInt(blinding), BigInt(memo.label), memo.kind === "transfer" && !sent ? "Received" : "Transaction output");
      }
      const released = BigInt(a["released"] ?? 0);
      const relayed = BigInt(a["fee"] ?? 0) > 0n ? " Sent through the relayer." : "";
      const outs = memo.outs.filter(([amount]) => BigInt(amount) > 0n).length;
      const fee = BigInt(a["asset"]) === ETH && BigInt(a["fee"] ?? 0) > 0n ? { feeWei: BigInt(a["fee"]) } : {};
      if (memo.kind === "transfer") {
        const amount = BigInt(memo.outs[0]?.[0] ?? 0);
        if (sent) log(e, "Sent", `Paid to a shielded address. Nothing on chain says who received it.${relayed}`, BigInt(a["asset"]), amount, fee);
        else log(e, "Received", "Paid into your account from a shielded address.", BigInt(a["asset"]), amount);
      } else if (released > 0n) log(e, "Withdrawal", `Released to ${getAddress(a["to"])}.${relayed}`, BigInt(a["asset"]), released, fee);
      else log(e, "Notes", `${memo.ins.length > 1 ? "Two notes merged into one" : `One note split into ${outs}`}.${relayed}`, BigInt(a["asset"]), null, fee);
    } else if (e.name === "OrderResting") {
      const auction = auctions.get(Number(a["id"]));
      if (!auction) continue;
      const commitment = BigInt(a["commitment"]);
      let opening: OrderOpening | null = null;
      if (a["sealedOrder"] === "0x") {
        // a remainder rolled by settlement (emitted before its AuctionSettled): mine if it is the roll of one of my orders
        const parent = orders.find((o) => results.get(o.commitment)?.rolls && o.asset === auction.asset && commitmentOf(o.asset, rolledOpening(o)) === commitment);
        if (parent) opening = rolledOpening(parent);
      } else {
        const memo = await readMemo(read, a["sealedOrder"]);
        if (memo) {
          opening = openingFromJson(memo.opening);
          if (opening && spend(memo.nullifier, memo.input)) {
            add(BigInt(memo.noteAsset), BigInt(memo.change), BigInt(memo.changeBlinding), opening.label, "Order change");
          }
          if (memo.feeChange !== undefined && spend(memo.feeNullifier, memo.feeInput)) {
            add(ETH, BigInt(memo.feeChange), BigInt(memo.feeChangeBlinding ?? 0), BigInt(memo.feeLabel ?? 0), "Relayer fee change");
          }
        }
      }
      if (opening && commitmentOf(auction.asset, opening) === commitment) {
        const o: MyOrder = { auctionId: auction.id, asset: auction.asset, quote: auction.quote, slot: Number(a["slot"]), commitment, opening, status: "open" };
        orders.push(o);
        const rolled = a["sealedOrder"] === "0x" ? " (rolled from the last auction)" : "";
        log(e, "Sealed order", `${opening.buy ? "Buy" : "Sell"} sealed into auction #${auction.id}${rolled}. The lock is held until it settles.`, lockAsset(o), opening.lock * unit(lockAsset(o)), orderFees.has(e.tx_hash) ? { feeWei: orderFees.get(e.tx_hash)! } : {});
      }
    } else if (e.name === "AuctionPinned") {
      for (const o of orders) if (o.auctionId === Number(a["id"]) && o.status === "open") o.status = "pinned";
    } else if (e.name === "AuctionSettled") {
      const pStar = BigInt(a["pStar"]);
      for (const o of orders.filter((x) => (x.status === "open" || x.status === "pinned") && x.auctionId === Number(a["id"]))) {
        const r = results.get(o.commitment);
        if (!r) continue;
        o.status = "settled";
        o.result = r;
        const p = o.opening;
        const got = p.buy ? { asset: o.asset, amount: BigInt(r.qty) * unit(o.asset) } : { asset: o.quote, amount: (BigInt(r.quote) - BigInt(r.fee)) * unit(o.quote) };
        add(got.asset, got.amount, blind(p.salt, 0n), p.label, "Fill");
        if (BigInt(r.qty) > 0n) log(e, "Fill", `Auction #${o.auctionId} cleared${r.rolls ? "; the rest rolls to the next auction" : ""}.`, got.asset, got.amount, { priceUsd: pStar });
        if (!r.rolls) {
          const back = BigInt(r.left) * unit(lockAsset(o));
          add(lockAsset(o), back, blind(p.salt, 1n), p.label, "Released lock");
          if (back > 0n) log(e, "Released lock", "The unfilled part of the lock came back as a note.", lockAsset(o), back);
        }
      }
    } else if (e.name === "AuctionVoided") {
      for (const o of orders) if ((o.status === "open" || o.status === "pinned") && o.auctionId === Number(a["id"])) o.status = "void";
    } else if (e.name === "OrderReclaimed") {
      const o = orders.find((x) => x.auctionId === Number(a["id"]) && x.slot === Number(a["slot"]));
      if (!o) continue;
      const cancelled = Boolean(a["cancelled"]);
      o.status = cancelled ? "cancelled" : "reclaimed";
      const back = o.opening.lock * unit(lockAsset(o));
      add(lockAsset(o), back, blind(o.opening.salt, 3n), o.opening.label, cancelled ? "Cancelled order" : "Reclaimed lock");
      log(e, cancelled ? "Order cancelled" : "Lock reclaimed", cancelled ? `Taken out of auction #${o.auctionId} before its call.` : `Auction #${o.auctionId} was voided, so the lock was taken back.`, lockAsset(o), back);
    }
  }
  return { notes, orders, activity, auctions };

  function rolledOpening(o: MyOrder): OrderOpening {
    const r = results.get(o.commitment)!;
    return { ...o.opening, qty: o.opening.qty - BigInt(r.qty), rollsLeft: o.opening.rollsLeft - 1, lock: BigInt(r.left), salt: blind(o.opening.salt, 2n) };
  }
}

/** AuctionSettled `notes`: UTF-8 JSON array of sealed results. */
function parseList(notesHex: string): string[] {
  try {
    const list = JSON.parse(toUtf8String(notesHex));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A transaction's memo: one sealed blob, or for a transfer an envelope holding one for each side. */
async function readTransact(read: Opener, memoHex: string | undefined): Promise<string | null> {
  if (!memoHex || memoHex === "0x") return null;
  try {
    const envelope = JSON.parse(toUtf8String(memoHex)) as { s?: unknown; r?: unknown };
    for (const part of [envelope.s, envelope.r]) {
      const text = typeof part === "string" ? await read(part) : null;
      if (text) return text;
    }
    return null;
  } catch {
    return read(memoHex); // a plain sealed memo
  }
}

async function readMemo(read: Opener, sealedOrderHex: string): Promise<OrderMemo | null> {
  try {
    const envelope = JSON.parse(toUtf8String(sealedOrderHex)) as { u?: unknown };
    const text = typeof envelope.u === "string" ? await read(envelope.u) : null;
    return text ? (JSON.parse(text) as OrderMemo) : null;
  } catch {
    return null;
  }
}

/** A disclosure grant's plaintext: viewing material for one wallet's account (never the spending secret). */
export interface Grant {
  wallet: string;
  owner: string;
  viewPriv: string;
  blindKey: string;
}
