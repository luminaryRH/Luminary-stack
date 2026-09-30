// Shielded account in the browser. Keys come from one wallet signature; the whole state is rebuilt from public pool
// events on every sync (ledger.ts); proofs are made here with noir_js + bb.js in a web worker. The server sees only
// public data and sealed ciphertexts, and Merkle paths are built locally so nobody learns which note is being spent.
// ETH transactions and every order go through the relayer by default, so the connected wallet is only ever linked to
// its own deposits. Every note carries its deposit's label: withdrawals prove that label is in the association set.
//
// Orders rest in AuctionPool auctions: a buy locks the auction's quote token (TQ for stock auctions, USDG for the NAV
// auction), a sell locks the stock. A relayed order pays its ETH relayer fee from a separate ETH note.
import { AbiCoder, Interface, ZeroAddress, formatUnits, getAddress, hexlify, isHexString, keccak256, toUtf8Bytes } from "ethers";
import { CHAIN_HEX, CONFIG, DEPLOYMENT } from "@/lib/luminary-config";
import { KEY_MESSAGE, keysFromSignature, parseShieldedAddress, seal, shieldedAddress, type ShieldedKeys } from "./crypto";
import { DEPOSIT_DOMAIN, loadPool, memoOpener, rebuild, type Activity, type Grant, type MyOrder, type Note, type Opener, type OrderMemo, type PoolAuction, type PoolEvent, type PoolSnapshot, type TransactMemo } from "./ledger";
import { FEE_NOTE_ORDERS, commitmentOf, feeNoteSource, openingToJson, type OrderOpening } from "./orders";
import { DEPTH, ETH, ETH_UNIT, FIELD, PLAIN, aspLeaf, blind, depositLabel, hex, note, nullifier, orderNullifier, pathOf, ready, rootOf } from "./protocol";
import type { Input } from "./prove";
import type { BrowserCircuit } from "./prove.worker";
import { rfqCommitment } from "./rfq";

export type { MyOrder, Note, PoolAuction } from "./ledger";
export { newSession, readIntents, sendIntent, type RfqIntent, type RfqSession } from "./rfq";

export interface Eth {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

export interface Market {
  symbol: string;
  token: string;
  decimals: number;
  unit: string | number; // base units per micro-unit
  kind: "stock" | "quote";
  feed: string | null;
}

export interface PoolConfig {
  chainId: number;
  pool: string;
  gate: string | null;
  disclosure: string | null;
  depositFeeWei: string;
  associationRequired: boolean;
  sealPublic: string;
  relayer: string;
  relayFees: { transactWei: string; orderWei: string };
  feeBps: number;
  markets: Market[];
  tree: { size: number; queued: number; root: string };
}

interface Association {
  root: string;
  labels: string[];
}

const POOL = new Interface([
  "function deposit(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function depositNonce(address) view returns (uint256)",
  "function transact((bytes32 root, bytes32 aspRoot, bytes32[2] nullifiers, bytes32[2] outputs, address asset, uint256 released, uint256 fee, address to, address relayer) t, bytes proof, bytes memo)",
  "function placeOrder(uint256 id, (bytes32 root, bytes32 nullifier, bytes32 feeNullifier, bytes32 change, bytes32 feeChange, bytes32 commitment, address relayer, uint256 fee) p, bytes proof, bytes sealedOrder)",
  "function reclaim(uint256 id, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes proof)",
  "function abandon(uint256 id)",
  "function auctions(uint256 id) view returns ((address asset, uint64 callTime, uint8 kind, bool settled, bool voided, address quote, uint64 callBlock, uint16 capBps, uint16 feeBps, uint64 refUsd, uint64 quoteUsd, uint64 pinnedAt, uint16 live))",
]);
const DESK = new Interface(["function open(address asset, address quote, uint256 delay) returns (uint256)"]);
const REGISTRY = new Interface(["function disclose(bytes32 auditor, bytes grant)"]);
const ERC20 = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const USDG = new Interface(["function mint(address to, uint256 amount)"]);
const TQ = new Interface(["function deposit(uint256 assets, address receiver) returns (uint256)", "function redeem(uint256 shares, address receiver, address holder) returns (uint256)"]);
const CHAIN = {
  chainId: CHAIN_HEX,
  chainName: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [CONFIG.rpcUrl],
  blockExplorerUrls: [CONFIG.explorer],
};
const SETTLE_DEADLINE = 3_600; // AuctionPool.SETTLE_DEADLINE, after the pin
const MAX_ROLLS = 11; // circuits/order_validity MAX_ROLLS
const CALL_MARGIN_SEC = 20; // an order this close to its auction's call may not mine before it

const utf8Hex = (text: string) => hexlify(toUtf8Bytes(text));
const address = (asset: bigint) => getAddress("0x" + asset.toString(16).padStart(40, "0"));
const zeroPath = () => Array<bigint>(DEPTH).fill(0n);
const abi = AbiCoder.defaultAbiCoder();

// Public pool data kept in IndexedDB between visits, so a returning visitor fetches only what is new. It holds what
// anyone can read on chain (leaves and events): never keys, notes or anything decrypted. Every failure is silent.
const CACHE_DB = "luminary";
const CACHE_STORE = "public";
const CACHE_KEY = "pool-1"; // new key whenever ledger EVENT_NAMES changes
function cacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function readPoolCache(): Promise<PoolSnapshot | null> {
  const db = await cacheDb();
  if (!db) return null;
  return new Promise<PoolSnapshot | null>((resolve) => {
    try {
      const req = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(CACHE_KEY);
      req.onsuccess = () => {
        const v = req.result as { pool: string; leaves: string[]; events: PoolEvent[] } | undefined;
        resolve(v?.pool && Array.isArray(v.leaves) && Array.isArray(v.events) ? { pool: v.pool, leaves: v.leaves.map((x) => BigInt(x)), events: v.events } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close());
}
async function writePoolCache(snapshot: PoolSnapshot) {
  const db = await cacheDb();
  if (!db) return;
  try {
    const value = { pool: snapshot.pool, leaves: snapshot.leaves.map((x) => "0x" + x.toString(16)), events: snapshot.events };
    db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put(value, CACHE_KEY);
  } catch {
    // quota or private mode: the next visit loads from the network
  } finally {
    db.close();
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
  return body.data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RelayState = { status: "none" | "submitting" | "sent" | "mined" | "reverted" | "replaced" | "unknown"; tx: string | null };

/**
 * Hands a proof to the relayer and waits for the chain. The call carries a random id, so when a reply never arrives the
 * same call can be sent again without a second broadcast, and its outcome can be looked up by id. Returns the mined
 * hash; after two minutes still pending, the last known hash (the next sync shows the result either way).
 */
export async function relayCall(payload: Record<string, unknown>, progress: (s: string) => void, fetchImpl: typeof fetch = (...a) => fetch(...a), wait = sleep): Promise<string> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const ask = async (init?: RequestInit): Promise<{ data?: any; error?: string } | null> => {
    try {
      const res = await fetchImpl(init ? "/api/pool/relay" : `/api/pool/relay?id=${id}`, { ...init, signal: AbortSignal.timeout(60_000) });
      const body = await res.json().catch(() => null);
      if (body?.ok) return { data: body.data };
      if (body && res.status < 500) return { error: String(body.error) }; // a definite refusal: nothing was sent
    } catch {
      // network error or timeout: no answer
    }
    return null;
  };

  let tx: string | null = null;
  for (let attempt = 1; ; attempt++) {
    const reply = await ask({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, id }) });
    if (reply?.error !== undefined) throw Error(reply.error);
    if (reply) {
      tx = reply.data.tx ?? null;
      break;
    }
    if (attempt === 3) {
      throw Error("The relayer did not answer. If the transaction went through, your balance shows it within a few minutes; check before trying again.");
    }
    progress("No answer from the relayer yet. Asking again (it will not be sent twice)…");
    await wait(3_000 * attempt);
  }

  for (const started = Date.now(); Date.now() - started < 120_000; await wait(2_500)) {
    progress(tx ? `Submitted (${tx.slice(0, 10)}…). Waiting for it to be mined…` : "The relayer is submitting it…");
    const s = (await ask())?.data as RelayState | undefined;
    if (!s) continue;
    if (s.status === "mined") return s.tx!;
    if (s.status === "reverted") throw Error("The transaction failed on chain.");
    if (s.status === "replaced") throw Error("The relayer could not get this transaction mined, so nothing was spent. Try again.");
    if (s.status === "none") throw Error("The relayer never received this transaction, so nothing was sent. Try again.");
    if (s.status === "unknown") break;
    tx = s.tx ?? tx;
  }
  if (!tx) throw Error("The relayer has not confirmed this transaction. If it went through, your balance shows it within a few minutes; check before trying again.");
  return tx;
}

/** Decimal text → integer with `decimals` places, no floating point; null when malformed. */
export function toUnits(value: string, decimals: number): bigint | null {
  const m = String(value ?? "").trim().match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

// Proving lives in ./prove.worker. The stack it imports (bb.js and the noir WASM) is several megabytes and only an
// unlocked account needs it, so nothing here references it statically: the worker is named by URL, and the in-page
// fallback is an import() taken only where a module worker cannot start.
interface Proof {
  proof: string;
  publicInputs: string[];
}
let worker: Worker | null | undefined; // undefined: not tried yet. null: unavailable, so the page proves it itself.
let jobId = 0;
const pending = new Map<number, { resolve: (p: Proof) => void; reject: (e: Error) => void }>();

function prover(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker === "undefined") return worker;
    const w = new Worker(new URL("./prove.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<{ id: number; ok: boolean; result: Proof; error: string }>) => {
      const job = pending.get(data.id);
      pending.delete(data.id);
      if (job) data.ok ? job.resolve(data.result) : job.reject(Error(data.error));
    };
    w.onerror = () => {
      worker = null; // whatever killed it, the next proof runs in the page
      for (const job of pending.values()) job.reject(Error("The proving worker stopped. Reload the page and try again."));
      pending.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

let warming: Promise<void> | undefined;
/** Starts the proving stack downloading and initialising, so the first proof does not also pay for it. */
export function preloadProver(): Promise<void> {
  const w = prover();
  warming ??= w
    ? new Promise<void>((done) => {
        const id = ++jobId;
        pending.set(id, { resolve: () => done(), reject: () => done() });
        w.postMessage({ id, warm: true });
      })
    : import("./prove.worker").then(
        (m) => m.warm().then(() => {}),
        () => {},
      );
  return warming;
}

async function proveCircuit(name: BrowserCircuit, inputs: Record<string, Input>) {
  if (typeof window === "undefined") {
    // scripts (scripts/acceptance.ts): Node's noir_js loads its own WASM, the same path the server proves on
    const load = { deposit: () => import("./circuits/deposit.json"), transact: () => import("./circuits/transact.json"), order_validity: () => import("./circuits/order_validity.json"), reclaim: () => import("./circuits/reclaim.json") };
    const [{ prove }, circuit] = await Promise.all([import("./prove"), load[name]()]);
    return prove(circuit.default as never, inputs, 4);
  }
  await preloadProver();
  const w = prover();
  return w
    ? new Promise<Proof>((resolve, reject) => {
        const id = ++jobId;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, name, inputs });
      })
    : (await import("./prove.worker")).proveNamed(name, inputs);
}

/** What placeOrder takes from the order ticket. */
export interface OrderTicket {
  auctionId: number;
  side: "buy" | "sell";
  sizeText: string; // tokens, up to 6 decimals
  limitText: string; // USD per token; empty = at the auction price
  lockText?: string; // buys: the most quote tokens to lock; defaults from the limit when there is one
  roll?: boolean; // an unfilled remainder rolls to the next auction of the pair
  rfq?: string; // an RFQ block commitment (RFQ auctions)
  selfSubmit?: boolean;
}

export class ShieldedAccount {
  config!: PoolConfig;
  leaves: bigint[] = [];
  events: PoolEvent[] = [];
  notes: Note[] = [];
  orders: (MyOrder & { symbol: string })[] = [];
  activity: Activity[] = [];
  auctions = new Map<number, PoolAuction>();

  private constructor(
    private readonly eth: Eth,
    private readonly keys: ShieldedKeys,
    readonly wallet: string,
  ) {}

  /** Asks the wallet for one signature (no transaction) and loads the account from chain data. */
  static async open(eth: Eth) {
    await ready();
    const [wallet] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!wallet) throw Error("No wallet account available.");
    const signature = (await eth.request({ method: "personal_sign", params: [utf8Hex(KEY_MESSAGE), wallet] })) as string;
    const account = new ShieldedAccount(eth, keysFromSignature(signature), getAddress(wallet));
    await account.sync();
    return account;
  }

  market(asset: bigint): Market {
    const m = this.config.markets.find((x) => BigInt(x.token) === asset);
    if (!m) throw Error("Unknown market.");
    return m;
  }

  marketBySymbol(symbol: string): Market {
    const m = this.config.markets.find((x) => x.symbol === symbol);
    if (!m) throw Error(`Unknown market ${symbol}.`);
    return m;
  }

  /** RFQ intents name the market by token address; null when it is not a market of this pool. */
  rfqSymbol(asset: string) {
    return this.config.markets.find((m) => m.token.toLowerCase() === String(asset).toLowerCase())?.symbol ?? null;
  }

  /** The block commitment both counterparties' orders carry, from the agreed terms (micro-token `qty`). */
  rfqCommitmentOf(b: { symbol: string; qty: string; buyerPub: string; sellerPub: string; nonce: string }) {
    return hex(rfqCommitment({ asset: BigInt(this.marketBySymbol(b.symbol).token), qty: BigInt(b.qty), buyerPub: b.buyerPub, sellerPub: b.sellerPub, nonce: BigInt(b.nonce) }));
  }

  symbol = (asset: bigint) => (asset === ETH ? "ETH" : this.market(asset).symbol);
  unit = (asset: bigint) => (asset === ETH ? ETH_UNIT : BigInt(String(this.market(asset).unit)));
  private assetOf = (symbol: string) => (symbol === "ETH" ? ETH : BigInt(this.marketBySymbol(symbol).token));
  private decimalsOf = (asset: bigint) => (asset === ETH ? 18 : this.market(asset).decimals);

  private pool = "";
  private verifiedSize = -1;
  private opener: Opener | null = null; // trial decryptions remembered for this account, in memory only

  /** Whether reused leaves reproduce the on-chain root (checked once per tree size; skipped while the index catches up). */
  private matchesChain(d: { config: PoolConfig; leaves: bigint[] }) {
    const size = d.config.tree.size;
    if (size === this.verifiedSize || d.leaves.length < size) return true;
    const ok = hex(rootOf(d.leaves.slice(0, size))) === d.config.tree.root.toLowerCase();
    if (ok) this.verifiedSize = size;
    return ok;
  }

  /**
   * Refreshes from public pool data: the first sync starts from this browser's cache, later ones from what the account
   * already holds, and both fetch only what is new. Anything that does not reproduce the chain's tree root is dropped
   * and loaded again in full, so a stale cache can never produce a wrong balance or proof.
   */
  async sync() {
    const known = this.pool ? { pool: this.pool, leaves: this.leaves, events: this.events } : await readPoolCache();
    let data = await loadPool<PoolConfig>("", known);
    if (known && !this.matchesChain(data)) data = await loadPool<PoolConfig>("");
    const changed = data.pool !== this.pool || data.leaves.length !== this.leaves.length || data.events.length !== this.events.length || data.events.at(-1)?.tx_hash !== this.events.at(-1)?.tx_hash;
    this.config = data.config;
    this.pool = data.pool;
    this.leaves = data.leaves;
    this.events = data.events;
    if (changed) void writePoolCache(data);
    const { notes, orders, activity, auctions } = await rebuild(this.keys, this.wallet, this.leaves, this.events, this.unit, (this.opener ??= memoOpener(this.keys.viewPriv)));
    this.notes = notes;
    this.orders = orders.map((o) => ({ ...o, symbol: this.symbol(o.asset) }));
    this.activity = activity;
    this.auctions = auctions;
  }

  /** Unspent, non-empty notes of `asset` already in the tree, largest first (an unfilled order leaves a 0 fill note). */
  private spendableNotes(asset: bigint, except: Note[] = []) {
    const size = this.config.tree.size;
    return this.notes
      .filter((n) => !n.spent && n.amount > 0n && n.asset === asset && n.index < size && !except.includes(n))
      .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  }

  /**
   * The smallest single note covering `amount` plus the relayer `fee`, else the smallest-total pair from one deposit
   * (same label) that does. A shortfall the fee alone causes says so with the numbers: the fee follows gas.
   */
  private cover(asset: bigint, amount: bigint, maxNotes: 1 | 2, fee = 0n, except: Note[] = []): Note[] {
    const need = amount + fee;
    const notes = this.spendableNotes(asset, except);
    const single = [...notes].reverse().find((n) => n.amount >= need);
    if (single) return [single];
    if (maxNotes === 2) {
      const pair = this.bestPair(notes, (sum) => sum >= need, "smallest");
      if (pair) return pair;
    }
    const sym = this.symbol(asset);
    const fmt = (x: bigint) => formatUnits(x, this.decimalsOf(asset));
    const pair = maxNotes === 2 ? this.bestPair(notes, () => true, "largest") : undefined;
    const pairSum = pair ? pair[0].amount + pair[1].amount : 0n;
    const most = notes[0] && notes[0].amount > pairSum ? notes[0].amount : pairSum;
    if (fee > 0n && most >= amount) {
      throw Error(
        `This needs ${fmt(need)} ${sym}: ${fmt(amount)} plus the relayer fee of ${fmt(fee)} ${sym}, which rises with gas prices. The most one transaction can take from your notes is ${fmt(most)} ${sym}. Enter a smaller amount, or submit from your wallet.`,
      );
    }
    const total = this.notes.filter((n) => !n.spent && n.asset === asset).reduce((s, n) => s + n.amount, 0n);
    if (total >= need) {
      throw Error(`Your ${sym} is spread over notes from different deposits (only notes from the same deposit combine), or new notes are waiting for the next tree batch. Use a smaller amount, or wait a minute.`);
    }
    throw Error(fee > 0n ? `Not enough shielded ${sym}: this needs ${fmt(need)} ${sym}, including the relayer fee of ${fmt(fee)} ${sym}, and you have ${fmt(total)} ${sym}.` : `Not enough shielded ${sym}.`);
  }

  /** Two notes with the same label: the pair meeting `ok` with the smallest or largest total. Notes arrive largest first. */
  private bestPair(notes: Note[], ok: (sum: bigint) => boolean, prefer: "smallest" | "largest") {
    let best: [Note, Note] | undefined;
    for (const label of new Set(notes.map((n) => n.label))) {
      const [a, b] = notes.filter((n) => n.label === label);
      if (!a || !b || !ok(a.amount + b.amount)) continue;
      const sum = a.amount + b.amount;
      const bestSum = best ? best[0].amount + best[1].amount : undefined;
      if (bestSum === undefined || (prefer === "smallest" ? sum < bestSum : sum > bestSum)) best = [a, b];
    }
    return best;
  }

  /** Current tree as the contract has it; refuses to prove against a tree this client cannot reproduce. */
  private tree() {
    const size = this.config.tree.size;
    const leaves = this.leaves.slice(0, size);
    if (leaves.length < size) throw Error("The pool index is catching up. Try again in a minute.");
    const root = rootOf(leaves);
    if (hex(root) !== this.config.tree.root.toLowerCase()) throw Error("The pool tree just changed. Try again in a moment.");
    return { leaves, root };
  }

  /** AuctionPool.context: binds a transaction proof to this pool, its recipient, relayer and fee. */
  private context(to: string, relayer: string, fee: bigint) {
    return BigInt(keccak256(abi.encode(["uint256", "address", "address", "address", "uint256"], [this.config.chainId, this.config.pool, to, relayer, fee]))) % FIELD;
  }

  /** AuctionPool.placementContext: binds an order proof to this pool, its auction, relayer and fee. */
  private placementContext(id: number, relayer: string, fee: bigint) {
    return BigInt(keccak256(abi.encode(["uint256", "address", "uint256", "address", "uint256"], [this.config.chainId, this.config.pool, id, relayer, fee]))) % FIELD;
  }

  private async call(to: string, data: string) {
    return (await this.eth.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as string;
  }

  /** Switches the wallet to Robinhood Chain testnet, adding it when the wallet does not know it. */
  async ensureChain() {
    try {
      await this.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
    } catch (e: any) {
      if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
      await this.eth.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
    }
  }

  private async send(to: string, data: string, value = 0n) {
    await this.ensureChain();
    const hash = (await this.eth.request({
      method: "eth_sendTransaction",
      params: [{ from: this.wallet, to, data, ...(value ? { value: "0x" + value.toString(16) } : {}) }],
    })) as string;
    for (const started = Date.now(); Date.now() - started < 180_000; ) {
      const receipt = await this.eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (receipt) {
        if (receipt.status !== "0x1") throw Error("The transaction failed on chain.");
        return hash;
      }
      await sleep(1500);
    }
    throw Error("The transaction is taking longer than expected. Check your wallet.");
  }

  /** Approves `spender` for `amount` of `token` from the wallet when the allowance is short. */
  private async approve(token: string, spender: string, amount: bigint, symbol: string, progress: (s: string) => void) {
    const allowance = BigInt(await this.call(token, ERC20.encodeFunctionData("allowance", [this.wallet, spender])));
    if (allowance >= amount) return;
    progress(`Approve ${symbol} in your wallet…`);
    await this.send(token, ERC20.encodeFunctionData("approve", [spender, amount]));
  }

  /** Deposit ETH ("ETH") or a market's token from the connected wallet into a new note, plus the pool's deposit fee. */
  async deposit(symbol: string, amountText: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const { owner, blindKey } = this.keys;
    // the contract's nonce, not the indexed events: a deposit the index has not caught up with still counts
    await this.ensureChain();
    const nonce = BigInt(await this.call(this.config.pool, POOL.encodeFunctionData("depositNonce", [this.wallet])));
    const label = depositLabel(BigInt(this.config.chainId), this.config.pool, this.wallet, nonce);
    const blinding = blind(blindKey, DEPOSIT_DOMAIN + nonce);
    const commitment = note(owner, asset, amount, blinding, label);

    progress("Proving the deposit in your browser…");
    const { proof } = await proveCircuit("deposit", { owner, blinding, commitment, asset, amount, label });
    if (asset !== ETH) await this.approve(address(asset), this.config.pool, amount, symbol, progress);
    progress("Confirm the deposit in your wallet…");
    const value = (asset === ETH ? amount : 0n) + BigInt(this.config.depositFeeWei);
    return this.send(this.config.pool, POOL.encodeFunctionData("deposit", [address(asset), amount, hex(commitment), proof]), value);
  }

  /** The association set entry for `label`: the published root and this label's path, or null when it is not in it. */
  private async association(label: bigint) {
    const { association } = await get<{ association: Association | null }>("/api/pool/association");
    const index = association ? association.labels.indexOf(String(label)) : -1;
    if (index < 0) return null;
    return { root: BigInt(association!.root), index, path: pathOf(association!.labels.map((l) => aspLeaf(BigInt(l))), index) };
  }

  /**
   * One TransactProof: spend `ins` (one or two notes of `asset` with one label), create `outs` (amounts, owned by this
   * account), release `released` to `to`. ETH goes through the relayer (its fee comes out of the notes) unless
   * `selfSubmit`; tokens are always self-submitted. Releasing funds proves the label is in the association set.
   * With `recipient`, the first output is made out to their owner key instead: a private transfer.
   */
  private async transact(asset: bigint, ins: Note[], outs: bigint[], released: bigint, to: string, selfSubmit: boolean, progress: (s: string) => void, recipient?: { owner: bigint; viewPub: string }) {
    const relayed = asset === ETH && !selfSubmit;
    const fee = relayed ? BigInt(this.config.relayFees.transactWei) : 0n;
    const relayer = relayed ? this.config.relayer : ZeroAddress;
    const { leaves, root } = this.tree();
    const { secret, owner, viewPub } = this.keys;
    const label = ins[0]!.label;
    if (ins.some((n) => n.label !== label)) throw Error("Notes from different deposits cannot be spent together.");
    const first = ins[0]!.nullifier!;
    const dummy = { amount: 0n, blinding: blind(secret, (first + 7n) % FIELD), index: 0 };
    const spentOf = (i: { amount: bigint; blinding: bigint; index: number }) => nullifier(secret, note(owner, asset, i.amount, i.blinding, label), BigInt(i.index));
    const slots = ins.length === 2 ? ins : [ins[0]!, dummy];
    const outAmounts = [outs[0] ?? 0n, outs[1] ?? 0n];
    const available = ins.reduce((s, n) => s + n.amount, 0n);
    const change = available - released - fee - outAmounts[0]! - outAmounts[1]!;
    if (change < 0n) throw Error(relayed ? `Not enough in these notes to cover the relayer fee of ${formatUnits(fee, 18)} ETH.` : "Not enough in these notes.");
    outAmounts[1] = outAmounts[1]! + change; // whatever is left returns in the second output
    const outBlindings = [0n, 1n].map((k) => blind(secret, (first + 11n + k) % FIELD));
    const outOwners = [recipient?.owner ?? owner, owner]; // a transfer's change always comes back here
    const outputs = outAmounts.map((amount, k) => note(outOwners[k]!, asset, amount, outBlindings[k]!, label));
    const spent = slots.map(spentOf);

    let asp: Awaited<ReturnType<ShieldedAccount["association"]>> = null;
    if (released > 0n) {
      progress("Checking your deposit against the association set…");
      asp = await this.association(label);
      if (!asp && this.config.associationRequired) {
        throw Error("The deposit these notes come from is not in the pool's current association set yet. If it was made in the last few minutes, try again shortly.");
      }
    }

    progress("Proving the transaction in your browser…");
    const { proof } = await proveCircuit("transact", {
      secret,
      label,
      in_amounts: slots.map((i) => i.amount),
      in_blindings: slots.map((i) => i.blinding),
      in_indexes: slots.map((i) => i.index),
      in_paths: slots.map((i) => (i.amount === 0n ? zeroPath() : pathOf(leaves, i.index))),
      out_owners: outOwners,
      out_amounts: outAmounts,
      out_blindings: outBlindings,
      asp_index: asp?.index ?? 0,
      asp_path: asp?.path ?? zeroPath(),
      root,
      asp_root: asp?.root ?? 0n,
      spent,
      outputs,
      asset,
      released,
      fee,
      context: this.context(to, relayer, fee),
    });
    const memo: TransactMemo = {
      label: String(label),
      ins: ins.map((n) => hex(n.commitment)),
      outs: outAmounts.map((amount, k) => [String(amount), String(outBlindings[k])]),
      ...(recipient ? { kind: "transfer" as const } : {}),
    };
    // a transfer seals twice: the recipient is told only their own note, never what was spent or what came back
    const theirs: TransactMemo = { label: String(label), ins: [], outs: [[String(outAmounts[0]), String(outBlindings[0])]], kind: "transfer" };
    const sealedMemo = recipient
      ? utf8Hex(JSON.stringify({ s: await seal(viewPub, JSON.stringify(memo)), r: await seal(recipient.viewPub, JSON.stringify(theirs)) }))
      : await seal(viewPub, JSON.stringify(memo));
    const t = {
      root: hex(root),
      aspRoot: hex(asp?.root ?? 0n),
      nullifiers: spent.map(hex),
      outputs: outputs.map(hex),
      asset: address(asset),
      released: String(released),
      fee: String(fee),
      to,
      relayer,
    };
    if (relayed) {
      progress("Handing the proof to the relayer…");
      return relayCall({ kind: "transact", transaction: t, proof, memo: sealedMemo }, progress);
    }
    progress("Confirm the transaction in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("transact", [Object.values(t), proof, sealedMemo]));
  }

  /** Withdraw `amountText` of `symbol` to `to` (from up to two notes of one deposit; the rest stays shielded as change). */
  async withdraw(symbol: string, amountText: string, to: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount, 2, fee), [], amount, getAddress(to), selfSubmit, progress);
  }

  /** This account's shielded address: what someone else needs to pay it, and nothing more. */
  shieldedAddress() {
    return shieldedAddress(this.keys);
  }

  /** Pay `amountText` of `symbol` to another account's shielded address; the change comes back here. */
  async transfer(symbol: string, amountText: string, addressText: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const to = parseShieldedAddress(addressText);
    if (!to) throw Error("That is not a shielded address. Ask the recipient for the one in their account panel; it starts with lm.");
    if (to.owner === this.keys.owner) throw Error("That is this account's own shielded address.");
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount, 2, fee), [amount], 0n, ZeroAddress, selfSubmit, progress, to);
  }

  /** Merge the largest pair of spendable `symbol` notes that come from the same deposit. */
  async merge(symbol: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    const pair = this.bestPair(this.spendableNotes(asset), (sum) => sum > fee, "largest");
    if (!pair) throw Error(`You have no two spendable ${symbol} notes from the same deposit.`);
    return this.transact(asset, pair, [], 0n, ZeroAddress, selfSubmit, progress);
  }

  /** Split one note of `symbol` into `amountText` and the rest. */
  async split(symbol: string, amountText: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount, 1, fee), [amount], 0n, ZeroAddress, selfSubmit, progress);
  }

  /** Auctions still taking orders, soonest call first. */
  collecting(now = Date.now() / 1000) {
    return [...this.auctions.values()].filter((a) => !a.voided && !a.pinned && !a.settled && a.callTime > now + CALL_MARGIN_SEC).sort((a, b) => a.callTime - b.callTime);
  }

  /**
   * Seal an order into collecting auction `t.auctionId`. A buy locks quote tokens (up to `lockText`, or enough for the
   * limit plus fee); a sell locks `sizeText` tokens. Relayed by default: the relayer fee comes from a separate ETH note,
   * so neither the wallet nor the fee says anything about the order.
   */
  async placeOrder(t: OrderTicket, progress: (s: string) => void = () => {}) {
    await this.sync();
    const auction = this.auctions.get(t.auctionId);
    if (!auction) throw Error("That auction is not on chain yet. Pick another one, or wait a minute.");
    if (auction.voided || auction.pinned || auction.settled || auction.callTime <= Date.now() / 1000 + CALL_MARGIN_SEC) {
      throw Error("This auction is no longer taking orders. Choose the next one.");
    }
    const { asset, quote } = auction;
    const unit = this.unit(asset);
    const quoteUnit = this.unit(quote);
    const buy = t.side === "buy";
    const rfqAuction = auction.kind === "RFQ";
    const qty = toUnits(t.sizeText, 6);
    if (!qty || qty < 1000n || qty >= 1n << 56n) throw Error("Enter a size of at least 0.001 tokens, up to 6 decimals.");
    const limit = t.limitText.trim() ? toUnits(t.limitText, 6) : null;
    if (t.limitText.trim() && (!limit || limit >= 1n << 48n)) throw Error("Enter a positive price limit or leave it empty.");
    let lock: bigint | null = qty;
    if (buy) {
      const typed = t.lockText?.trim() ? toUnits(t.lockText, this.market(quote).decimals) : undefined;
      if (typed !== undefined) lock = typed === null ? null : typed / quoteUnit;
      // ponytail: assumes 1 quote token ≈ $1 (TQ NAV starts at 1 and only rises), so qty × limit covers the buy; an at-auction buy names its lock
      else lock = limit ? (qty * limit * (10_000n + BigInt(this.config.feeBps))) / 10_000n / 1_000_000n + 1n : null;
      if (!lock || lock <= 0n) throw Error(`Enter the most ${this.symbol(quote)} this buy may spend.`);
    }
    if (lock >= 1n << 64n) throw Error("That lock is too large.");
    let terms = PLAIN;
    if (t.rfq?.trim()) {
      const rfq = /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(t.rfq.trim()) ? BigInt(t.rfq.trim()) : 0n;
      if (rfq === 0n || rfq >= FIELD) throw Error("Enter the block commitment from your RFQ.");
      terms = { ...PLAIN, rfq };
    } else if (rfqAuction) throw Error("An RFQ auction takes only orders carrying the agreed block commitment.");
    const roll = Boolean(t.roll) && !rfqAuction; // RFQ blocks cross whole or refund, never roll

    const noteAsset = buy ? quote : asset;
    const need = lock * (buy ? quoteUnit : unit);
    const [n] = this.cover(noteAsset, need, 1);
    const relayed = !t.selfSubmit;
    const fee = relayed ? BigInt(this.config.relayFees.orderWei) : 0n;
    let feeNote: Note | undefined;
    if (relayed) {
      feeNote = this.spendableNotes(ETH, [n!]).reverse().find((x) => x.amount >= fee);
      if (!feeNote) {
        if (this.notes.some((x) => !x.spent && x.asset === ETH && x.amount >= fee && x.index >= this.config.tree.size)) {
          throw Error("An ETH note that can pay the relayer fee is still joining the pool tree. Place the order again in about a minute.");
        }
        const { amountEth, costEth } = this.feeNoteQuote();
        throw Object.assign(
          Error(
            `A relayed order pays its ${formatUnits(fee, 18)} ETH relayer fee from a separate shielded ETH note, and you have none. Deposit a little ETH, prepare a fee note (${amountEth} ETH, split off for ${costEth} ETH), or submit the order from your wallet.`,
          ),
          { code: "needs-fee-note" },
        );
      }
    }
    const { leaves, root } = this.tree();
    const { secret, owner, viewPub } = this.keys;

    const opening: OrderOpening = {
      owner,
      salt: blind(secret, (n!.nullifier! + 1n) % FIELD),
      buy,
      qty,
      hasLimit: limit !== null,
      limitUsd: limit ?? 0n,
      roll,
      rollsLeft: roll ? MAX_ROLLS : 0,
      lock,
      label: n!.label,
      terms,
      viewPub,
    };
    const commitment = commitmentOf(asset, opening);
    const changeBlinding = blind(secret, n!.nullifier!);
    const change = note(owner, noteAsset, n!.amount - need, changeBlinding, n!.label);
    const feeChangeBlinding = feeNote ? blind(secret, feeNote.nullifier!) : 0n;
    const feeChange = feeNote ? note(owner, ETH, feeNote.amount - fee, feeChangeBlinding, feeNote.label) : 0n;
    const memo: OrderMemo = {
      opening: openingToJson(opening),
      nullifier: String(n!.nullifier),
      input: hex(n!.commitment),
      noteAsset: String(noteAsset),
      change: String(n!.amount - need),
      changeBlinding: String(changeBlinding),
      ...(feeNote
        ? {
            feeNullifier: String(feeNote.nullifier),
            feeInput: hex(feeNote.commitment),
            feeChange: String(feeNote.amount - fee),
            feeChangeBlinding: String(feeChangeBlinding),
            feeLabel: String(feeNote.label),
          }
        : {}),
    };
    const envelope = JSON.stringify({ o: await seal(this.config.sealPublic, openingToJson(opening)), u: await seal(viewPub, JSON.stringify(memo)) });
    const relayer = relayed ? this.config.relayer : ZeroAddress;

    progress("Proving the order in your browser…");
    const { proof } = await proveCircuit("order_validity", {
      secret,
      label: n!.label,
      blinding: n!.blinding,
      note_amount: n!.amount,
      leaf_index: n!.index,
      path: pathOf(leaves, n!.index),
      change_blinding: changeBlinding,
      fee_label: feeNote?.label ?? 0n,
      fee_note_amount: feeNote?.amount ?? 0n,
      fee_blinding: feeNote?.blinding ?? 0n,
      fee_index: feeNote?.index ?? 0,
      fee_path: feeNote ? pathOf(leaves, feeNote.index) : zeroPath(),
      fee_change_blinding: feeChangeBlinding,
      buy,
      qty,
      has_limit: opening.hasLimit,
      limit_usd: opening.limitUsd,
      roll: opening.roll,
      rolls_left: opening.rollsLeft,
      lock,
      salt: opening.salt,
      root,
      spent: n!.nullifier!,
      fee_spent: feeNote?.nullifier ?? 0n,
      change,
      fee_change: feeChange,
      asset,
      unit,
      quote_token: quote,
      quote_unit: quoteUnit,
      commitment,
      fee,
      context: this.placementContext(auction.id, relayer, fee),
      terms: { min_qty: terms.minQty, display: terms.display, peg: terms.peg, rfq: terms.rfq },
    });
    const placement = {
      root: hex(root),
      nullifier: hex(n!.nullifier!),
      feeNullifier: hex(feeNote?.nullifier ?? 0n),
      change: hex(change),
      feeChange: hex(feeChange),
      commitment: hex(commitment),
      relayer,
      fee: String(fee),
    };
    if (relayed) {
      progress("Handing the sealed order to the relayer…");
      return relayCall({ kind: "order", auctionId: String(auction.id), placement, proof, sealedOrder: utf8Hex(envelope) }, progress);
    }
    progress("Confirm the sealed order in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("placeOrder", [auction.id, Object.values(placement), proof, utf8Hex(envelope)]));
  }

  /** A fee note's size (enough for a few relayed orders) and what splitting it off through the relayer costs. */
  feeNoteQuote() {
    const size = BigInt(this.config.relayFees.orderWei) * FEE_NOTE_ORDERS;
    return { size, amountEth: formatUnits(size, 18), costEth: formatUnits(BigInt(this.config.relayFees.transactWei), 18) };
  }

  /** Split a separate ETH note off for relayed order fees, through the relayer, then wait until it is spendable. */
  async prepareFeeNote(progress: (s: string) => void = () => {}) {
    await this.sync();
    const { size, amountEth } = this.feeNoteQuote();
    const cost = BigInt(this.config.relayFees.transactWei);
    const source = feeNoteSource(this.spendableNotes(ETH), size, cost, 0n);
    if (!source) throw Error(`Not enough spendable shielded ETH to split off a ${amountEth} ETH fee note. Deposit a little more ETH, or submit orders from your wallet.`);
    const tx = await this.transact(ETH, [source], [size], 0n, ZeroAddress, false, progress);
    for (const started = Date.now(); Date.now() - started < 6 * 60_000; ) {
      progress("Fee note sent. Waiting for it to join the pool tree, usually a minute or two…");
      await sleep(10_000);
      await this.sync().catch(() => {});
      if (this.spendableNotes(ETH).some((x) => x.amount === size)) return tx;
    }
    throw Error("The fee note is still joining the pool tree. Place the order again in a minute.");
  }

  /**
   * Take an order's lock back (ReclaimProof), from the wallet: a cancel while its auction is still collecting, or a
   * reclaim once it was voided. A pinned auction nobody settled within an hour is abandoned first.
   */
  async cancel(commitmentHex: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    const o = this.orders.find((x) => hex(x.commitment) === commitmentHex.toLowerCase());
    if (!o) throw Error("Order not found.");
    if (o.status === "pinned") {
      await this.ensureChain();
      const [a] = POOL.decodeFunctionResult("auctions", await this.call(this.config.pool, POOL.encodeFunctionData("auctions", [o.auctionId])));
      const opens = Number(a.pinnedAt) + SETTLE_DEADLINE;
      if (Date.now() / 1000 < opens) throw Error(`Auction #${o.auctionId} is being settled. If it is not settled by ${new Date(opens * 1000).toLocaleTimeString()}, the lock can be reclaimed.`);
      progress("Close the unsettled auction in your wallet…");
      await this.send(this.config.pool, POOL.encodeFunctionData("abandon", [o.auctionId]));
    } else if (o.status !== "open" && o.status !== "void") {
      throw Error("This order can no longer be cancelled.");
    }
    const p = o.opening;
    const lockAsset = p.buy ? o.quote : o.asset;
    const refund = note(this.keys.owner, lockAsset, p.lock * this.unit(lockAsset), blind(p.salt, 3n), p.label);
    const spent = orderNullifier(this.keys.secret, o.commitment);
    progress("Proving the cancel in your browser…");
    const { proof } = await proveCircuit("reclaim", {
      secret: this.keys.secret,
      label: p.label,
      buy: p.buy,
      qty: p.qty,
      has_limit: p.hasLimit,
      limit_usd: p.limitUsd,
      roll: p.roll,
      rolls_left: p.rollsLeft,
      lock: p.lock,
      salt: p.salt,
      asset: o.asset,
      unit: this.unit(o.asset),
      quote_token: o.quote,
      quote_unit: this.unit(o.quote),
      commitment: o.commitment,
      spent,
      refund,
      terms: { min_qty: p.terms.minQty, display: p.terms.display, peg: p.terms.peg, rfq: p.terms.rfq },
    });
    progress("Confirm the cancel in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("reclaim", [o.auctionId, o.slot, hex(spent), hex(refund), proof]));
  }

  /** Opens an RFQ auction of `symbol` against TQ on RfqDesk, called after `delaySec` (60 to 3600); returns the tx hash. */
  async openRfq(symbol: string, delaySec = 600, progress: (s: string) => void = () => {}) {
    await this.sync();
    if (!DEPLOYMENT) throw Error("No deployment.");
    progress("Open the RFQ auction in your wallet…");
    return this.send(DEPLOYMENT.RfqDesk, DESK.encodeFunctionData("open", [this.marketBySymbol(symbol).token, this.marketBySymbol("TQ").token, delaySec]));
  }

  /** Testnet faucet: mint up to 10,000 MockUSDG to the wallet. */
  async mintUsdg(amountText: string, progress: (s: string) => void = () => {}) {
    const amount = toUnits(amountText, 6);
    if (!amount || amount <= 0n || amount > 10_000_000_000n) throw Error("Mint from 0.000001 to 10,000 USDG at a time.");
    progress("Confirm the mint in your wallet…");
    return this.send(this.marketBySymbol("USDG").token, USDG.encodeFunctionData("mint", [this.wallet, amount]));
  }

  /** USDG → TQ (TreasuryQuote shares) in the wallet, ready to deposit as buy collateral. */
  async toTreasury(amountText: string, progress: (s: string) => void = () => {}) {
    const amount = toUnits(amountText, 6);
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const tq = this.marketBySymbol("TQ").token;
    await this.approve(this.marketBySymbol("USDG").token, tq, amount, "USDG", progress);
    progress("Confirm the treasury deposit in your wallet…");
    return this.send(tq, TQ.encodeFunctionData("deposit", [amount, this.wallet]));
  }

  /** TQ shares → USDG in the wallet, at the current NAV. */
  async fromTreasury(sharesText: string, progress: (s: string) => void = () => {}) {
    const shares = toUnits(sharesText, 6);
    if (!shares || shares <= 0n) throw Error("Enter an amount.");
    progress("Confirm the redemption in your wallet…");
    return this.send(this.marketBySymbol("TQ").token, TQ.encodeFunctionData("redeem", [shares, this.wallet, this.wallet]));
  }

  /** The wallet's own (public) balances: ETH and every market token, formatted. */
  async walletBalances() {
    await this.ensureChain();
    const eth = BigInt(await this.eth.request({ method: "eth_getBalance", params: [this.wallet, "latest"] }));
    const tokens = await Promise.all(
      this.config.markets.map(async (m) => ({ symbol: m.symbol, amount: formatUnits(BigInt(await this.call(m.token, ERC20.encodeFunctionData("balanceOf", [this.wallet]))), m.decimals) })),
    );
    return [{ symbol: "ETH", amount: formatUnits(eth, 18) }, ...tokens];
  }

  /**
   * Selective disclosure: seal this account's viewing material (never the spending secret) to an auditor's public key
   * and publish it in DisclosureRegistry. The auditor can then read every note, order and result of this account.
   */
  async disclose(auditorPub: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    if (!this.config.disclosure) throw Error("Disclosure is not available on this pool yet.");
    const pub = auditorPub.trim();
    if (!isHexString(pub, 33) || !/^0x0[23]/.test(pub)) throw Error("Enter the auditor's compressed public key (0x02… or 0x03…, 33 bytes).");
    const grant: Grant = { wallet: this.wallet, owner: String(this.keys.owner), viewPriv: this.keys.viewPriv, blindKey: String(this.keys.blindKey) };
    const sealed = await seal(pub, JSON.stringify(grant));
    progress("Confirm the disclosure in your wallet…");
    return this.send(this.config.disclosure, REGISTRY.encodeFunctionData("disclose", [keccak256(pub), sealed]));
  }

  /** Display-ready snapshot (strings only) for the dashboard. */
  view() {
    const size = this.config.tree.size;
    const assets: bigint[] = [ETH, ...this.config.markets.map((m) => BigInt(m.token))];
    const fmt = (asset: bigint, v: bigint) => formatUnits(v, this.decimalsOf(asset));
    const now = Date.now() / 1000;
    return {
      wallet: this.wallet,
      shieldedAddress: shieldedAddress(this.keys),
      activity: [...this.activity].reverse().map((r) => ({
        type: r.type,
        detail: r.detail,
        symbol: this.symbol(r.asset),
        amount: r.amount === null ? null : fmt(r.asset, r.amount),
        block: r.block,
        tx: r.tx,
        feeEth: r.feeWei === undefined ? null : formatUnits(r.feeWei, 18),
        priceUsd: r.priceUsd === undefined ? null : formatUnits(r.priceUsd, 6),
      })),
      relayFees: { transactEth: formatUnits(BigInt(this.config.relayFees.transactWei), 18), orderEth: formatUnits(BigInt(this.config.relayFees.orderWei), 18) },
      depositFeeEth: formatUnits(BigInt(this.config.depositFeeWei), 18),
      disclosure: Boolean(this.config.disclosure),
      markets: this.config.markets.map((m) => ({ symbol: m.symbol, kind: m.kind })),
      tree: this.config.tree,
      balances: assets.map((asset) => {
        const mine = this.notes.filter((n) => !n.spent && n.amount > 0n && n.asset === asset);
        const inOrders = this.orders
          .filter((o) => o.status === "open" || o.status === "pinned" || o.status === "void")
          .filter((o) => (o.opening.buy ? o.quote : o.asset) === asset)
          .reduce((s, o) => s + o.opening.lock * this.unit(asset), 0n);
        return {
          symbol: this.symbol(asset),
          spendable: fmt(asset, mine.filter((n) => n.index < size).reduce((s, n) => s + n.amount, 0n)),
          pending: fmt(asset, mine.filter((n) => n.index >= size).reduce((s, n) => s + n.amount, 0n)),
          inOrders: fmt(asset, inOrders),
          notes: mine.length,
        };
      }),
      auctions: this.collecting(now).map((a) => ({ id: a.id, symbol: this.symbol(a.asset), quote: this.symbol(a.quote), kind: a.kind, callTime: a.callTime })),
      orders: this.orders
        .map((o) => {
          const auction = this.auctions.get(o.auctionId);
          return {
            id: hex(o.commitment),
            auctionId: o.auctionId,
            kind: auction?.kind ?? null,
            callTime: auction?.callTime ?? null,
            symbol: o.symbol,
            quote: this.symbol(o.quote),
            side: o.opening.buy ? "BUY" : "SELL",
            size: formatUnits(o.opening.qty, 6),
            limit: o.opening.hasLimit ? formatUnits(o.opening.limitUsd, 6) : null,
            lock: formatUnits(o.opening.lock * this.unit(o.opening.buy ? o.quote : o.asset), this.decimalsOf(o.opening.buy ? o.quote : o.asset)),
            roll: o.opening.roll,
            status: o.status,
            filled: o.result ? formatUnits(BigInt(o.result.qty), 6) : "0",
            pStar: o.result ? formatUnits(BigInt(o.result.pStar), 6) : null,
            rolled: Boolean(o.result?.rolls),
            cancellable: o.status === "open" || o.status === "void" || o.status === "pinned",
          };
        })
        .reverse(),
    };
  }
}
