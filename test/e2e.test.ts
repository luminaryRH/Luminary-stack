// End to end on a local chain (test/harness.ts): the checks of scripts/acceptance.ts through the same ShieldedAccount the
// dashboard uses, with the workers driven through the cron routes as pg_cron does. bun test test/
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Contract, Interface, Wallet, hexlify, keccak256, parseUnits, randomBytes, toUtf8Bytes } from "ethers";
import { account, eth, startLocal, type Local } from "./harness";

let L: Local;
// app modules load after startLocal() installs the fakes
let app: {
  client: typeof import("@/shielded/client");
  db: typeof import("@/server/luminary/db");
  sends: typeof import("@/server/luminary/pool/sends");
  contract: typeof import("@/server/luminary/pool/contract");
  crypto: typeof import("@/shielded/crypto");
  ledger: typeof import("@/shielded/ledger");
  relay: typeof import("@/server/luminary/pool/relay");
  committee: typeof import("@/shielded/committee");
  poolCommittee: typeof import("@/server/luminary/pool/committee");
  orders: typeof import("@/shielded/orders");
};
type Account = import("@/shielded/client").ShieldedAccount;
let B: Account;
let S: Account;
let ticking = true;
let tickerNav = true; // the ticker's own alert runs would consume the events the alerts test watches
let ticker: Promise<void>;
let ticks = 0;
const errors: string[] = [];

const KIND = { OPEN: 0, CLOSE: 1, MIDNIGHT: 2, NAV: 3, RFQ: 4 } as const;
const auth = { authorization: "Bearer local-cron-secret" };
const cron = async (job: string) => ((await (await fetch(`/api/cron/${job}`, { headers: auth })).json()) as { data: Record<string, any> }).data;
const api = async <T>(path: string) => {
  const body = (await (await fetch(path)).json()) as { ok: boolean; data: T; error?: string };
  if (!body.ok) throw Error(`${path}: ${body.error}`);
  return body.data;
};

/** One scheduler tick: two empty blocks (the indexer waits for 2 confirmations), and every other tick the tree's
 * partial-batch wait is skipped, so batches land at once. */
async function tick() {
  await L.chain.send("anvil_mine", ["0x2"]);
  if (ticks++ % 2 === 0) {
    const size = Number(await app.contract.pool().getFunction("treeSize")());
    await app.db.rpc("lum_pool_put_state", { p_name: "treeQueue", p_value: { size, since: 0 } });
  }
  const r = await cron("tick");
  for (const [step, v] of Object.entries(r)) if (v && typeof v === "object" && "error" in v) errors.push(`${step}: ${v.error}`);
  return r;
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > ms) throw Error(`timed out: ${label} (tick errors: ${errors.slice(-3).join(" | ")})`);
    await Bun.sleep(250);
  }
}

const chainNow = async () => (await L.chain.getBlock("latest"))!.timestamp;
/** Moves the chain past `t` (the JS clock stays behind, which only makes the client's own time checks more permissive). */
const warpTo = async (t: number) => {
  const now = await chainNow();
  if (t >= now) await L.chain.send("evm_increaseTime", [t - now + 1]);
  await L.chain.send("anvil_mine", ["0x1"]);
};

/** An operator transaction through the app's send queue (the workers send from the same key). */
async function asOperator(to: string, fn: string, ...args: unknown[]) {
  const iface = new Interface([fn]);
  const hash = await app.sends.sendOperator(to, iface.encodeFunctionData(iface.fragments[0] as never, args), null);
  return L.chain.waitForTransaction(hash!);
}

async function schedule(asset: string, kind: number, inSec: number) {
  const callTime = (await chainNow()) + inSec;
  const hash = await app.sends.sendPool("schedule", [asset, L.deployment.tokens.USDG, kind, callTime], `test:${asset}:${callTime}`);
  const receipt = await L.chain.waitForTransaction(hash!);
  const ev = receipt!.logs.map((l) => app.contract.POOL_ABI.parseLog(l)).find((e) => e?.name === "AuctionScheduled")!;
  return { id: Number(ev.args[0]), callTime };
}

const balance = (acc: Account, symbol: string) => Number(acc.view().balances.find((b) => b.symbol === symbol)?.spendable ?? 0);
const spendable = (acc: Account, symbol: string, min: number) => async () => (await acc.sync(), balance(acc, symbol) >= min);
const ordersIn = (acc: Account, id: number) => acc.view().orders.filter((o) => o.auctionId === id);
const indexed = (acc: Account, id: number) => async () => (await acc.sync(), acc.auctions.has(id));
const ref = async (symbol: string) => Number((await api<{ prices: Record<string, { usd: string }> }>("/api/marks")).prices[symbol]!.usd) / 1e6;
const printOf = async (id: number) => (await api<{ prints: { auctionId: number; pStar: string; crossedQty: string; tx: string }[] }>("/api/prints?limit=500")).prints.find((p) => p.auctionId === id);

beforeAll(async () => {
  L = await startLocal();
  app = {
    client: await import("@/shielded/client"),
    db: await import("@/server/luminary/db"),
    sends: await import("@/server/luminary/pool/sends"),
    contract: await import("@/server/luminary/pool/contract"),
    crypto: await import("@/shielded/crypto"),
    ledger: await import("@/shielded/ledger"),
    relay: await import("@/server/luminary/pool/relay"),
    committee: await import("@/shielded/committee"),
    poolCommittee: await import("@/server/luminary/pool/committee"),
    orders: await import("@/shielded/orders"),
  };
  await cron("calendar");
  await cron("nav");
  ticker = (async () => {
    while (ticking) {
      await tick().catch((e) => errors.push(String(e)));
      if (tickerNav && ticks % 20 === 0) await cron("nav").catch(() => {});
      await Bun.sleep(100);
    }
  })();
  const [bw, sw] = [new Wallet(account(1).privateKey), new Wallet(account(2).privateKey)];
  await asOperator(L.deployment.tokens.TSLA, "function mint(address,uint256)", sw.address, parseUnits("3", 18));
  B = await app.client.ShieldedAccount.open(eth(bw, L.chain));
  S = await app.client.ShieldedAccount.open(eth(sw, L.chain));
}, 180_000);

afterAll(async () => {
  ticking = false;
  await ticker?.catch(() => {});
  L?.stop();
});

/** The labels in the published association set (the fee label plus every screened deposit). */
const associationLabels = async () => (await api<{ association: { labels: string[] } | null }>("/api/pool/association")).association?.labels ?? [];

test("deposits join the tree and become spendable", async () => {
  await asOperator(L.deployment.tokens.USDG, "function mint(address,uint256)", B.wallet, 2_000_000_000n);
  await B.deposit("USDG", "1500");
  await B.deposit("ETH", "0.05");
  await S.deposit("TSLA", "2.5");
  await S.deposit("ETH", "0.02");
  await until("deposits spendable", async () => (await spendable(B, "USDG", 1500)()) && (await spendable(B, "ETH", 0.05)()) && (await spendable(S, "TSLA", 2.5)()) && (await spendable(S, "ETH", 0.02)()));
  // withdrawals and orders prove their deposit is in the screened set: the fee label and the four deposits
  await until("deposits screened into the association set", async () => (await associationLabels()).length >= 5);
  expect(balance(S, "ETH")).toBeCloseTo(0.02);
  await B.prepareFeeNote();
  expect(B.notes.filter((n) => !n.spent && n.asset === 0n && n.amount > 0n).length).toBeGreaterThanOrEqual(2);
}, 180_000);

test("a CLOSE auction clears at one p* inside the band; a cancel before the call refunds the lock", async () => {
  const d = L.deployment;
  const a = await schedule(d.tokens.TSLA, KIND.CLOSE, 900);
  await until("auction indexed", async () => (await indexed(B, a.id)()) && (await indexed(S, a.id)()));
  const r = await ref("TSLA");
  await B.placeOrder({ auctionId: a.id, side: "buy", sizeText: "1", limitText: (r * 1.02).toFixed(2), roll: false }); // relayed
  await S.placeOrder({ auctionId: a.id, side: "sell", sizeText: "1", limitText: (r * 0.98).toFixed(2), roll: false, selfSubmit: true });
  await until("both orders seen", async () => (await B.sync(), await S.sync(), ordersIn(B, a.id).length === 1 && ordersIn(S, a.id).length === 1));
  await until("seller change in the tree", spendable(S, "TSLA", 1.4));
  // a sell above the market that rolls into the next TSLA auction
  await S.placeOrder({ auctionId: a.id, side: "sell", sizeText: "0.5", limitText: (r * 1.2).toFixed(2), roll: true, selfSubmit: true });
  await until("buyer change in the tree", spendable(B, "USDG", 100));
  await B.placeOrder({ auctionId: a.id, side: "buy", sizeText: "0.2", limitText: (r * 0.5).toFixed(2), roll: false, selfSubmit: true });
  const low = await until("cancellable order", async () => (await B.sync(), ordersIn(B, a.id).find((o) => o.size === "0.2" && o.status === "open")));
  await B.cancel(low.id);
  await until("cancel seen", async () => (await B.sync(), ordersIn(B, a.id).find((o) => o.size === "0.2")?.status === "cancelled"));

  await warpTo(a.callTime);
  const p = await until("auction printed", () => printOf(a.id));
  const row = (await api<{ auctions: { id: number; refUsd: string; proofTx: string }[] }>(`/api/auctions?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 2 * 86_400_000).toISOString()}`)).auctions.find((x) => x.id === a.id)!;
  const [pStar, refUsd] = [BigInt(p.pStar), BigInt(row.refUsd)];
  expect(pStar * 10_000n >= refUsd * 9_500n && pStar * 10_000n <= refUsd * 10_500n).toBe(true);
  expect(p.crossedQty).toBe("1000000");
  expect(row.proofTx).toBe(p.tx);
  await until("owners read their fills", async () => (await B.sync(), await S.sync(), ordersIn(B, a.id).some((o) => o.status === "settled") && ordersIn(S, a.id).every((o) => o.status === "settled")));
  expect(ordersIn(B, a.id).find((o) => o.status === "settled")!.filled).toBe("1.0");
  const sells = ordersIn(S, a.id);
  expect(sells.some((o) => o.filled === "1.0")).toBe(true);
  // the unfilled 0.5 rolled: its remainder rests in a later TSLA auction
  expect(sells.find((o) => o.size === "0.5")!.rolled).toBe(true);
  await until("rolled order seen", async () => (await S.sync(), S.view().orders.some((o) => o.auctionId !== a.id && o.size === "0.5" && o.status === "open")));

  // no plaintext order data in the indexed events
  const events = await api<{ events: { args: { sealedOrder: string } }[] }>(`/api/pool/events?names=OrderResting&after=0`);
  for (const e of events.events) {
    const text = Buffer.from(e.args.sealedOrder.slice(2), "hex").toString("utf8");
    if (text) expect(Object.keys(JSON.parse(text)).sort().join()).toBe("k,o,u"); // operator ciphertext, memo, proof of the ciphertext's key
  }
}, 300_000);

test("withdrawals: a token to the wallet, ETH through the relayer, and a ragequit", async () => {
  await until("bought TSLA spendable", spendable(B, "TSLA", 1));
  const token = new Contract(L.deployment.tokens.TSLA, ["function balanceOf(address) view returns (uint256)"], L.chain);
  const before = await token.getFunction("balanceOf")(B.wallet);
  await B.withdraw("TSLA", "1", B.wallet, true);
  expect((await token.getFunction("balanceOf")(B.wallet)) - before).toBe(parseUnits("1", 18));

  const to = Wallet.createRandom().address;
  await B.withdraw("ETH", "0.001", to); // relayed
  await until("relayed withdrawal mined", async () => (await L.chain.getBalance(to)) === parseUnits("0.001", 18));

  const wallet = await L.chain.getBalance(S.wallet);
  await S.ragequit("ETH", "0.005");
  expect(await L.chain.getBalance(S.wallet)).toBeGreaterThan(wallet);
}, 180_000);

test("an RFQ block settles whole at the reference", async () => {
  const { newSession, readIntents, sendIntent } = app.client;
  const [bs, ss] = [newSession(), newSession()];
  const request = { kind: "request" as const, asset: L.deployment.tokens.TSLA, side: "buy" as const, qty: "500000", nonce: String(BigInt(keccak256(toUtf8Bytes(String(Date.now())))) >> 8n) };
  await sendIntent(bs, ss.pub, request);
  const got = await until("seller reads the request", async () => (await readIntents(ss)).find((m) => m.intent.nonce === request.nonce));
  await S.openRfq("TSLA", 600);
  const block = await until("RFQ auction indexed", async () => {
    await S.sync();
    return [...S.auctions.values()].filter((a) => a.kind === "RFQ" && !a.pinned && !a.settled && !a.voided).sort((a, b) => b.id - a.id)[0];
  });
  await sendIntent(ss, got.from, { ...request, kind: "accept", side: "sell", auctionId: block.id });
  const rfq = S.rfqCommitmentOf({ symbol: "TSLA", qty: request.qty, buyerPub: bs.pub, sellerPub: ss.pub, nonce: request.nonce });
  await until("seller TSLA spendable", spendable(S, "TSLA", 0.5));
  await S.placeOrder({ auctionId: block.id, side: "sell", sizeText: "0.5", limitText: "", rfq, selfSubmit: true });
  const accepted = await until("buyer reads the accept", async () => (await readIntents(bs)).find((m) => m.intent.kind === "accept"));
  const rfqB = B.rfqCommitmentOf({ symbol: "TSLA", qty: accepted.intent.qty, buyerPub: bs.pub, sellerPub: accepted.from, nonce: accepted.intent.nonce });
  expect(rfqB).toBe(rfq);
  await until("buyer indexed the block", indexed(B, block.id));
  const r = await ref("TSLA");
  await B.placeOrder({ auctionId: block.id, side: "buy", sizeText: "0.5", limitText: "", lockText: (0.5 * r * 1.05).toFixed(6), rfq: rfqB, selfSubmit: true });
  await until("both block orders seen", async () => (await B.sync(), ordersIn(B, block.id).length === 1));
  await warpTo(block.callTime);
  const p = await until("RFQ block printed", () => printOf(block.id));
  expect(p.crossedQty).toBe("500000");
}, 300_000);

test("split, private transfer and merge", async () => {
  const usdg = BigInt(L.deployment.tokens.USDG);
  await until("tree queue drained", async () => (await B.sync(), B.config.tree.queued === B.config.tree.size));
  const notesOf = (acc: Account) => acc.notes.filter((n) => !n.spent && n.amount > 0n && n.asset === usdg && n.index < acc.config.tree.size);
  const total = (acc: Account) => notesOf(acc).reduce((s, n) => s + n.amount, 0n);
  await S.sync();
  const [b0, s0, n0] = [total(B), total(S), notesOf(B).length];
  await B.split("USDG", "10.5", true);
  await until("split in the tree", async () => (await B.sync(), notesOf(B).length === n0 + 1));
  expect(total(B)).toBe(b0);
  await B.transfer("USDG", "5", S.shieldedAddress(), true);
  await until("transfer received", async () => (await S.sync(), total(S) === s0 + 5_000_000n));
  await until("sender change in the tree", async () => (await B.sync(), total(B) === b0 - 5_000_000n));
  const n1 = notesOf(B).length;
  await B.merge("USDG", true);
  await until("merge in the tree", async () => (await B.sync(), notesOf(B).length === n1 - 1));
  expect(total(B)).toBe(b0 - 5_000_000n);
}, 180_000);

test("an auditor rebuilds the account from a disclosure grant", async () => {
  const auditor = Wallet.createRandom();
  const pub = auditor.signingKey.compressedPublicKey;
  await B.disclose(pub);
  const grantEvent = await until("grant indexed", async () =>
    (await api<{ events: { args: { auditor: string; from: string; grant: string } }[] }>(`/api/pool/events?names=Disclosed&after=0`)).events.find((e) => e.args.auditor === keccak256(pub)),
  );
  const grant = JSON.parse((await app.crypto.open(auditor.privateKey, grantEvent.args.grant))!);
  await B.sync();
  const seen = await app.ledger.rebuild({ owner: BigInt(grant.owner), viewPriv: grant.viewPriv, blindKey: BigInt(grant.blindKey) }, grant.wallet, B.leaves, B.events, B.unit);
  const unspent = (ns: { spent: boolean; amount: bigint; commitment: bigint }[]) => ns.filter((n) => !n.spent && n.amount > 0n).map((n) => String(n.commitment)).sort().join();
  expect("secret" in grant).toBe(false);
  expect(unspent(seen.notes)).toBe(unspent(B.notes));
  expect(seen.orders.length).toBe(B.orders.length);
}, 120_000);

test("an order sealed to the wrong key is left out of the settlement and its lock reclaimed", async () => {
  await until("buyer USDG spendable", spendable(B, "USDG", 40));
  const a = await schedule(L.deployment.tokens.TSLA, KIND.CLOSE, 900);
  await until("auction indexed", indexed(B, a.id));
  const r = await ref("TSLA");
  let cfg = B.config;
  Object.defineProperty(B, "config", { configurable: true, get: () => ({ ...cfg, sealPublic: Wallet.createRandom().signingKey.compressedPublicKey }), set: (v) => (cfg = v) });
  try {
    await B.placeOrder({ auctionId: a.id, side: "buy", sizeText: "0.2", limitText: (r * 0.5).toFixed(2), roll: false, selfSubmit: true });
  } finally {
    Object.defineProperty(B, "config", { configurable: true, enumerable: true, writable: true, value: cfg });
  }
  await until("order seen", async () => (await B.sync(), ordersIn(B, a.id).length === 1));
  await warpTo(a.callTime);
  await until("left out of the settlement", async () => (await B.sync(), ordersIn(B, a.id)[0]?.status === "void"));
  expect(BigInt(await app.contract.pool().getFunction("excludedSlots")(a.id))).not.toBe(0n);
  await B.cancel(ordersIn(B, a.id)[0]!.id);
  await until("lock reclaimed", async () => (await B.sync(), ordersIn(B, a.id)[0]?.status === "reclaimed"));
}, 240_000);

test("committee mode: orders open only from members' partials, posted after the pin", async () => {
  const { committeeOf, deal, keyShareOf, partialOf } = app.committee;
  const members = [1, 2, 3];
  const dealings = members.map((m) => deal(m, 2, members));
  const c = committeeOf(2, members, dealings);
  process.env["COMMITTEE"] = JSON.stringify(c);
  try {
    await until("fresh notes", async () => (await spendable(B, "USDG", 100)()) && (await spendable(S, "TSLA", 0.3)()));
    const a = await schedule(L.deployment.tokens.TSLA, KIND.CLOSE, 900);
    await until("auction indexed", async () => (await indexed(B, a.id)()) && (await indexed(S, a.id)()));
    expect(B.config.sealPublic).toBe(c.groupKey);
    const r = await ref("TSLA");
    await B.placeOrder({ auctionId: a.id, side: "buy", sizeText: "0.3", limitText: (r * 1.02).toFixed(2), roll: false, selfSubmit: true });
    await S.placeOrder({ auctionId: a.id, side: "sell", sizeText: "0.3", limitText: (r * 0.98).toFixed(2), roll: false, selfSubmit: true });
    await until("orders seen", async () => (await B.sync(), await S.sync(), ordersIn(B, a.id).length === 1 && ordersIn(S, a.id).length === 1));
    // a junk order whose envelope no member can decrypt (not a curve point) must not hold the auction up
    const junk = new Wallet(account(3).privateKey, L.chain);
    const placeOrder = new Contract(L.deployment.AuctionPool, app.contract.POOL_ABI, junk).getFunction("placeOrder");
    const rand = () => "0x00" + hexlify(randomBytes(31)).slice(2); // below the field modulus
    const root = await app.contract.pool().getFunction("root")();
    const zero = "0x" + "00".repeat(32);
    const aspRoot = await app.contract.gate().getFunction("latestAssociationRoot")();
    const envelope = hexlify(toUtf8Bytes(JSON.stringify({ o: "0x" + "ff".repeat(80), u: "0x" })));
    await (await placeOrder(a.id, [root, rand(), zero, rand(), zero, rand(), "0x" + "00".repeat(20), 0, aspRoot], "0x", envelope)).wait();
    expect(app.committee.partialable("0x" + "ff".repeat(80))).toBe(false);
    // a victim's order rests in a later auction; someone copies its ciphertext into this one, which pins first, hoping the
    // members' partials for the copy open the victim's order before its own call
    const later = await schedule(L.deployment.tokens.TSLA, KIND.CLOSE, 1800);
    await until("buyer USDG for the victim order", spendable(B, "USDG", 30));
    await until("later auction indexed", indexed(B, later.id));
    await B.placeOrder({ auctionId: later.id, side: "buy", sizeText: "0.2", limitText: (r * 0.5).toFixed(2), roll: false, selfSubmit: true });
    const resting = await app.contract.pool().queryFilter(app.contract.pool().filters["OrderResting"]!(later.id));
    const victimEnvelope = String((resting[0] as unknown as { args: unknown[] }).args[3]);
    await (await placeOrder(a.id, [root, rand(), zero, rand(), zero, rand(), "0x" + "00".repeat(20), 0, aspRoot], "0x", victimEnvelope)).wait();
    await warpTo(a.callTime);
    // after the pin the operator waits for partials instead of settling without the orders
    const pending = await until("orders pending for the committee", async () => {
      const p = (await app.poolCommittee.pendingForCommittee()).filter((x) => x.id === a.id);
      return p.length === 2 && p; // the two real orders: the junk one is not decryptable, the copy's proof is for the victim's auction
    });
    expect(await printOf(a.id)).toBeUndefined();
    // a forged partial (member 1's share under member 2's index) is dropped by the route
    const forged = { sealed: pending[0]!.sealed, partial: { ...partialOf(1, keyShareOf(1, dealings), pending[0]!.sealed), member: 2 } };
    const post = async (body: unknown) => (await (await fetch("/api/pool/partials", { method: "POST", body: JSON.stringify(body) })).json()) as { ok: boolean; data?: { accepted: number; rejected: number }; error?: string };
    expect((await post({ items: [forged, { sealed: "nope", partial: {} }] })).data).toEqual({ accepted: 0, rejected: 2 });
    expect((await post({ items: [] })).ok).toBe(false);
    // members 1 and 3 run scripts/committee-member.ts: each checks the chain itself, and two of three partials open each order
    const { round } = await import("../scripts/committee-member");
    const member = (m: number) => ({ member: m, keyShare: keyShareOf(m, dealings), base: "", rpcUrl: L.url, pool: L.deployment.AuctionPool, fromBlock: L.deployment.deployBlock });
    // a dishonest operator also slips in a ciphertext that is not on chain and one of an auction that is not pinned
    const smuggled = await app.crypto.seal(c.groupKey, "an order the operator wants opened early");
    const lying: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (init?.method === "POST") return res;
      const body = (await res.json()) as { data: { pending: unknown[] } };
      body.data.pending.push({ id: a.id, sealed: smuggled }, { id: later.id, sealed: pending[0]!.sealed });
      return Response.json(body);
    };
    // even if a dishonest operator lists the copy, the members refuse it (its key proof is bound to the victim's auction and
    // commitment), as well as the smuggled ciphertext and the unpinned auction's order; the two real orders are opened
    const copy = { id: a.id, sealed: app.orders.operatorCiphertext(victimEnvelope)! };
    const lyingAboutCopy: typeof fetch = async (input, init) => {
      const res = await lying(input, init);
      if (init?.method === "POST") return res;
      const body = (await res.json()) as { data: { pending: unknown[] } };
      body.data.pending.push(copy);
      return Response.json(body);
    };
    expect(await round(member(1), lyingAboutCopy)).toEqual({ accepted: 2, skipped: 3 });
    expect(await round(member(3))).toEqual({ accepted: 2, skipped: 0 });
    const p = await until("committee auction printed", () => printOf(a.id));
    expect(p.crossedQty).toBe("300000");
    expect(BigInt(await app.contract.pool().getFunction("excludedSlots")(a.id))).toBe(12n); // slots 2 and 3: the junk order and the copy
    // the copy cost the victim nothing: once its own auction pins, the original is served and opens
    for (const token of [L.deployment.tokens.TSLA, L.deployment.tokens.USDG]) {
      const feed = (await app.contract.pool().getFunction("markets")(token))[0] as string; // no one pushes the mocks: keep them fresh
      const [, answer] = await new Contract(feed, ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"], L.chain).getFunction("latestRoundData")();
      await asOperator(feed, "function push(int256)", answer);
    }
    await warpTo(later.callTime);
    const original = await until("the victim's order pending in its own auction", async () => {
      const p = (await app.poolCommittee.pendingForCommittee()).filter((x) => x.id === later.id);
      return p.length === 1 && p[0]!;
    });
    expect(original.sealed).toBe(copy.sealed);
    expect(await round(member(1))).toEqual({ accepted: 1, skipped: 0 });
    expect(await round(member(3))).toEqual({ accepted: 1, skipped: 0 });
    expect(await app.poolCommittee.openOrder(original.sealed)).not.toBeNull();
  } finally {
    delete process.env["COMMITTEE"];
  }
  // without a committee the member route is closed
  expect((await (await fetch("/api/pool/partials")).json()).ok).toBe(false);
}, 240_000);

test("the relayer refuses malformed, underpaid and replayed calls", async () => {
  const post = async (body: unknown) =>
    (await (await fetch("/api/pool/relay", { method: "POST", body: JSON.stringify(body) })).json()) as { ok: boolean; data?: { tx: string | null }; error?: string };
  const proof = "0x" + "07".repeat(512);
  const relayer = B.config.relayer;
  const h32 = (b: string) => "0x" + b.repeat(32);
  const tx = { root: h32("11"), aspRoot: h32("00"), nullifiers: [h32("22"), h32("33")], outputs: [h32("44"), h32("55")], asset: "0x" + "00".repeat(20), released: "1", fee: "1", to: B.wallet, relayer };
  const placement = { root: h32("11"), nullifier: h32("22"), feeNullifier: h32("33"), change: h32("44"), feeChange: h32("55"), commitment: h32("66"), relayer, fee: "10000000000000000000" };
  const cases: [unknown, RegExp][] = [
    [{ kind: "transact", proof: "0x12" }, /proof must be hex/],
    [{ kind: "transact", proof, id: "nope" }, /id must be 32/],
    [{ kind: "transact", proof, transaction: { ...tx, root: "0x1" } }, /root must be 32 bytes/],
    [{ kind: "transact", proof, transaction: { ...tx, nullifiers: [h32("22")] } }, /two values/],
    [{ kind: "transact", proof, transaction: { ...tx, released: "-1" } }, /decimal string/],
    [{ kind: "transact", proof, transaction: { ...tx, to: "nowhere" } }, /must be an address/],
    [{ kind: "transact", proof, transaction: { ...tx, asset: L.deployment.tokens.USDG } }, /ETH transactions only/],
    [{ kind: "transact", proof, transaction: { ...tx, to: L.deployment.AuctionPool } }, /plain account/],
    [{ kind: "transact", proof, transaction: { ...tx, relayer: B.wallet } }, /relayer must be/],
    [{ kind: "transact", proof, transaction: tx }, /relayer fee below/],
    [{ kind: "order", proof, placement, auctionId: "x" }, /auctionId must be/],
    [{ kind: "order", proof, placement, auctionId: "1", sealedOrder: "zz" }, /sealedOrder must be hex/],
    [{ kind: "other", proof }, /kind must be/],
  ];
  for (const [body, error] of cases) {
    const res = await post(body);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
  }

  // a relayed call sent again (another id, same notes) is not sent twice: it answers with the first call's tx
  const sent = L.relayed.find((b) => b["kind"] === "transact")!;
  const first = await post(sent);
  expect(first.ok).toBe(true);
  const again = await post({ ...sent, id: hexlify(randomBytes(16)).slice(2) });
  expect(again.data!.tx).toBe(first.data!.tx);
  expect((await api<{ status: string }>(`/api/pool/relay?id=${sent["id"]}`)).status).toBe("mined");
  expect((await api<{ status: string }>(`/api/pool/relay?id=${"0".repeat(32)}`)).status).toBe("none");

  // with its claims forgotten, the same notes reach the pool, which refuses them: the user reads why
  await L.db.query(`delete from lum_relays`);
  const spent = await post({ ...sent, id: hexlify(randomBytes(16)).slice(2) });
  expect(spent.error).toMatch(/already spent/);

  // an operator without gas cannot send; nothing is claimed for good
  await L.db.query(`delete from lum_relays`);
  const op = await L.operator.getAddress();
  const funds = await L.chain.getBalance(op);
  await L.chain.send("anvil_setBalance", [op, "0x0"]);
  try {
    expect((await post({ ...sent, id: hexlify(randomBytes(16)).slice(2) })).ok).toBe(false);
  } finally {
    await L.chain.send("anvil_setBalance", [op, "0x" + funds.toString(16)]);
  }
}, 120_000);

test("revert reasons become sentences the user can act on", () => {
  const { rejection, outOfGas } = app.relay;
  const names = ["NoteSpent", "UnknownRoot", "AuctionFull", "NotCollecting", "BadAuction", "UnknownAssociationRoot", "BadFee", "TransferFailed", "Reentrancy", "BadAmount", "InvalidProof"];
  const iface = new Interface(names.map((n) => `error ${n}()`));
  const messages = names.map((n) => rejection({ data: iface.encodeErrorResult(n, []) })?.message);
  expect(new Set(messages).size).toBe(names.length); // one sentence per reason
  expect(rejection({ info: { error: { data: "0xdeadbeef" } } })?.message).toMatch(/rejected this request/);
  expect(rejection(new Error("timeout"))).toBeNull();
  expect(outOfGas({ code: "INSUFFICIENT_FUNDS" })).toBe(true);
  expect(outOfGas(new Error("insufficient funds for gas * price + value"))).toBe(true);
  expect(outOfGas(new Error("nonce too low"))).toBe(false);
});

test("alerts reach the webhook, and a failed delivery is retried", async () => {
  const op = await L.operator.getAddress();
  const funds = await L.chain.getBalance(op);
  process.env["ALERT_WEBHOOK_URL"] = "http://hook.local/fail";
  tickerNav = false;
  try {
    await asOperator(L.deployment.AuctionPool, "function setScheduler(address,bool)", Wallet.createRandom().address, true);
    // the Safe queues a change on the timelock: alerted at once, 48 hours before it could run on mainnet
    await asOperator(L.deployment.owner, "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)", L.deployment.AuctionPool, 0, "0x", "0x" + "00".repeat(32), "0x" + "11".repeat(32), 0);
    // the app's provider caches the block number for 250 ms: let the head move past these transactions
    await L.chain.send("anvil_mine", ["0x1"]);
    await Bun.sleep(300);
    await L.chain.send("anvil_setBalance", [op, "0x" + parseUnits("0.001", 18).toString(16)]);
    expect((await cron("nav"))["alerts"].sent).toBe(false);
    process.env["ALERT_WEBHOOK_URL"] = "http://hook.local";
    expect((await cron("nav"))["alerts"].sent).toBe(true); // the failed run kept its cursor: the same alerts go out now
    const text = L.webhook.join("\n");
    expect(text).toContain("admin: SchedulerSet");
    expect(text).toContain("governance: CallScheduled");
    expect(text).toContain("top it up");
  } finally {
    delete process.env["ALERT_WEBHOOK_URL"];
    tickerNav = true;
    await L.chain.send("anvil_setBalance", [op, "0x" + funds.toString(16)]);
  }
}, 60_000);

test("a sanctioned depositor is kept out of the association set, and can still ragequit", async () => {
  const w = new Wallet(account(4).privateKey);
  L.sanctioned.add(w.address.toLowerCase());
  const X = await app.client.ShieldedAccount.open(eth(w, L.chain));
  await X.deposit("ETH", "0.01");
  await until("deposit spendable", spendable(X, "ETH", 0.01));
  const labels = await until("the publisher screened it", async () => {
    const st = await app.db.rpc<Record<string, { ok: boolean }> | null>("lum_pool_get_state", { p_name: "screening" });
    return st?.[w.address.toLowerCase()] && (await associationLabels());
  });
  const label = String(X.notes.find((n) => !n.spent && n.amount > 0n)!.label);
  expect(labels).not.toContain(label);
  await expect(X.withdraw("ETH", "0.005", Wallet.createRandom().address, true)).rejects.toThrow(/association set/);
  const before = await L.chain.getBalance(w.address);
  await X.ragequit("ETH", "0.005"); // the exit no screening can stop (studio rule P1)
  expect(await L.chain.getBalance(w.address)).toBeGreaterThan(before);
}, 180_000);

test("status, calendar and the public read routes answer", async () => {
  const status = await api<Record<string, unknown>>("/api/status");
  expect(status).toBeTruthy();
  const cal = await api<{ days?: unknown[] }>(`/api/calendar?from=${new Date().toISOString().slice(0, 10)}`);
  expect(cal).toBeTruthy();
  expect(errors.filter((e) => !/waiting/.test(e))).toEqual([]);
}, 60_000);
