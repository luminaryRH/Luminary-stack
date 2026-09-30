// Testnet acceptance (plan.md Verification): the five end-to-end checks, plus cancel and withdraw, against a running
// app on Robinhood Chain testnet. Two users (wallets derived from the operator key, funded by it) go through the same
// ShieldedAccount the dashboard uses; the operator schedules short-notice auctions so a run takes minutes, and the
// workers are driven through the cron routes, as pg_cron does.
//   bun build scripts/acceptance.ts --target=node --splitting --format=esm --outdir=node_modules/.cache/acceptance \
//     --external @aztec/bb.js --external @noir-lang/noir_js --external @noir-lang/acvm_js --external @noir-lang/noirc_abi
//   node --env-file=.env.local node_modules/.cache/acceptance/acceptance.js [base URL, default http://localhost:5199]
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getBytes,
  keccak256,
  parseEther,
  parseUnits,
  toUtf8Bytes,
} from "ethers";
import { CONFIG, DEPLOYMENT } from "@/lib/luminary-config";
import { rpc as db } from "@/server/luminary/db";
import { POOL_ABI } from "@/server/luminary/pool/contract";
import { sendPool } from "@/server/luminary/pool/sends";
import {
  ShieldedAccount,
  newSession,
  readIntents,
  sendIntent,
  type Eth,
  type RfqIntent,
} from "@/shielded/client";

const BASE = (process.argv[2] ?? "http://localhost:5199").replace(/\/$/, "");
const d = DEPLOYMENT!;
const chain = new JsonRpcProvider(process.env["RPC_URL"] || CONFIG.rpcUrl, 46630, {
  staticNetwork: true,
});
const operator = new Wallet(process.env["OPERATOR_PRIVATE_KEY"]!, chain);
const userWallet = (tag: string) =>
  new Wallet(keccak256(toUtf8Bytes(`${operator.privateKey}:acceptance:${tag}`)), chain);
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const KIND = { OPEN: 0, CLOSE: 1, MIDNIGHT: 2, NAV: 3, RFQ: 4 } as const;
// FROM=3 resumes at check 3 with the same (already funded) users; NAV_ID=<id> re-checks a NAV auction already settled
const FROM = Number(process.env["FROM"] ?? 1);

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  nativeFetch(
    typeof input === "string" && input.startsWith("/") ? BASE + input : input,
    init,
  )) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, "—", detail);
}

async function api<T>(path: string): Promise<T> {
  // a fresh query string each call, past the CDN's 10 s cache
  const body = (await (
    await nativeFetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`)
  ).json()) as {
    ok: boolean;
    data: T;
    error?: string;
  };
  if (!body.ok) throw Error(`${path}: ${body.error}`);
  return body.data;
}

async function cron(job: "tick" | "nav" | "calendar") {
  const res = await nativeFetch(`${BASE}/api/cron/${job}`, {
    headers: { authorization: `Bearer ${process.env["CRON_SECRET"]}` },
    signal: AbortSignal.timeout(310_000),
  });
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

// The workers, as pg_cron runs them: a tick back to back, nav every 5 minutes.
let ticking = true;
const ticker = (async () => {
  let lastNav = 0;
  while (ticking) {
    const r = await cron("tick").catch((e) => ({ error: String(e) }));
    const busy = Object.entries(r ?? {}).filter(
      ([, v]) =>
        v &&
        typeof v === "object" &&
        !("idle" in (v as object)) &&
        !("recorded" in (v as object) && (v as { recorded: number }).recorded === 0),
    );
    if (busy.length) log("tick", JSON.stringify(Object.fromEntries(busy)).slice(0, 400));
    if (Date.now() - lastNav > 300_000) {
      lastNav = Date.now();
      await cron("nav").catch(() => {});
    }
    await sleep(8_000);
  }
})();

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 600_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn().catch((e) => {
      log("  (retry)", label, String(e).slice(0, 160));
      return null;
    });
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw Error(`timed out: ${label}`);
    await sleep(10_000);
  }
}

const gasPrice = async () =>
  (((await chain.getBlock("latest"))!.baseFeePerGas ?? 0n) * 3n) / 2n + 10_000_000n;

/** An EIP-1193 provider over a local key, for ShieldedAccount outside the browser. */
function eth(w: Wallet): Eth {
  return {
    async request({ method, params = [] }) {
      if (method === "eth_requestAccounts") return [w.address];
      if (method === "personal_sign") return w.signMessage(getBytes(params[0] as string));
      if (method.startsWith("wallet_")) return null;
      if (method === "eth_sendTransaction") {
        const tx = params[0] as { to: string; data?: string; value?: string };
        const sent = await w.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
          type: 0,
          gasPrice: await gasPrice(),
        });
        return sent.hash;
      }
      return chain.send(method, params as unknown[]);
    },
  };
}

async function fund(to: string, ethWanted: bigint, tsla: bigint) {
  if ((await chain.getBalance(to)) < ethWanted / 2n) {
    const tx = await operator.sendTransaction({
      to,
      value: ethWanted,
      type: 0,
      gasPrice: await gasPrice(),
    });
    await tx.wait();
  }
  const token = new Contract(d.tokens.TSLA, ERC20, operator);
  if (tsla > 0n && (await token.getFunction("balanceOf")(to)) < tsla) {
    // best effort: the operator's faucet TSLA runs out, and users keep what they already shielded
    await token
      .getFunction("transfer")(to, tsla, { type: 0, gasPrice: await gasPrice() })
      .then((tx: { wait: () => Promise<unknown> }) => tx.wait())
      .catch((e: Error) => log("TSLA top-up skipped:", e.message.slice(0, 80)));
  }
}

/** Operator schedules an auction through the send queue; returns its id once indexed. */
async function schedule(asset: string, quote: string, kind: number, inSec: number) {
  const callTime = Math.floor(Date.now() / 1000) + inSec;
  const hash = await sendPool(
    "schedule",
    [asset, quote, kind, callTime],
    `acceptance:${asset}:${callTime}`,
  );
  const receipt = await chain.waitForTransaction(hash!, 1, 120_000);
  const ev = receipt!.logs
    .map((l) => POOL_ABI.parseLog(l))
    .find((e) => e?.name === "AuctionScheduled")!;
  const id = Number(ev.args[0]);
  log(`scheduled auction #${id} kind ${kind} at +${inSec}s`);
  return { id, callTime };
}

type Row = {
  id: number | null;
  status: string;
  refUsd: string | null;
  pStar: string | null;
  crossedQty: string | null;
  proofTx: string | null;
};
const auctionRow = async (id: number) =>
  (
    await api<{ auctions: Row[] }>(
      `/api/auctions?from=${new Date(Date.now() - 86_400_000).toISOString()}`,
    )
  ).auctions.find((a) => a.id === id);
const printOf = async (id: number) =>
  (
    await api<{
      prints: { auctionId: number; pStar: string; crossedQty: string; tx: string; block: number }[];
    }>("/api/prints?limit=500")
  ).prints.find((p) => p.auctionId === id);
const indexed = (acc: ShieldedAccount, id: number) => async () => (
  await acc.sync(),
  acc.auctions.has(id)
);
const spendable = (acc: ShieldedAccount, symbol: string, min: number) => async () => {
  await acc.sync();
  return Number(acc.view().balances.find((b) => b.symbol === symbol)?.spendable ?? 0) >= min;
};
const orderOf = (acc: ShieldedAccount, auctionId: number) =>
  acc.view().orders.filter((o) => o.auctionId === auctionId);
/** The account sees n of its orders in the auction (so the notes they spent are gone from its balance). */
const placed = (acc: ShieldedAccount, auctionId: number, n: number) => async () => (
  await acc.sync(),
  orderOf(acc, auctionId).length >= n
);

async function main() {
  log(
    `acceptance against ${BASE}; operator ${operator.address} holds ${formatEther(await chain.getBalance(operator.address))} ETH`,
  );
  const [bw, sw] = [userWallet("buyer"), userWallet("seller")];
  log("buyer", bw.address, "seller", sw.address);
  await fund(bw.address, parseEther("0.002"), 0n);
  await fund(sw.address, parseEther("0.0012"), FROM <= 2 ? parseUnits("2", 18) : 0n);

  const B = await ShieldedAccount.open(eth(bw));
  const S = await ShieldedAccount.open(eth(sw));
  const ref = async (s: string) =>
    Number((await api<{ prices: Record<string, { usd: string }> }>("/api/marks")).prices[s]!.usd) /
    1e6;

  if (FROM <= 4) {
    // ---- funding: USDG faucet → TQ → shielded; ETH for relayer fees; stock tokens --------------------------------
    const bTq = Number(B.view().balances.find((b) => b.symbol === "TQ")?.spendable ?? 0);
    if (bTq < 500) {
      await B.mintUsdg("2000", (s) => log("B", s));
      await B.toTreasury("2000", (s) => log("B", s));
      await B.deposit("TQ", "1500", (s) => log("B", s));
      await B.deposit("ETH", "0.0006", (s) => log("B", s));
    }
    if (Number(S.view().balances.find((b) => b.symbol === "TSLA")?.spendable ?? 0) < 1.5) {
      await S.deposit("TSLA", "2", (s) => log("S", s));
      await S.mintUsdg("500", (s) => log("S", s));
      await S.deposit("USDG", "300", (s) => log("S", s));
    }
    // relayer fees come out of shielded ETH; earlier runs spend it down
    if (Number(B.view().balances.find((b) => b.symbol === "ETH")?.spendable ?? 0) < 0.0004) {
      await B.deposit("ETH", "0.0004", (s) => log("B", s));
    }
    await until(
      "deposits spendable",
      async () =>
        (await spendable(B, "TQ", 500)()) &&
        (await spendable(B, "ETH", 0.0001)()) &&
        (await spendable(S, "TSLA", 1.5)()) &&
        (await spendable(S, "USDG", 200)()),
    );
    log("deposits are in the tree");
    if (B.notes.filter((n) => !n.spent && n.asset === 0n && n.amount > 0n).length < 2)
      await B.prepareFeeNote((s) => log("B", s));
  }

  if (FROM <= 2) {
    // ---- 1. TSLA CLOSE auction clears every crossable order at one p* inside the band, with one proof -------------
    const a1 = await schedule(d.tokens.TSLA, d.tokens.TQ, KIND.CLOSE, 480);
    await until(
      "auction 1 indexed",
      async () => (await indexed(B, a1.id)()) && (await indexed(S, a1.id)()),
    );
    const r = await ref("TSLA");
    await B.placeOrder(
      {
        auctionId: a1.id,
        side: "buy",
        sizeText: "1",
        limitText: (r * 1.02).toFixed(2),
        roll: false,
      },
      (s) => log("B", s),
    );
    await S.placeOrder(
      {
        auctionId: a1.id,
        side: "sell",
        sizeText: "1",
        limitText: (r * 0.98).toFixed(2),
        roll: false,
        selfSubmit: true,
      },
      (s) => log("S", s),
    );
    await until(
      "both orders indexed",
      async () => (await placed(B, a1.id, 1)()) && (await placed(S, a1.id, 1)()),
    );
    await until("seller change in the tree", spendable(S, "TSLA", 0.9));
    await S.placeOrder(
      {
        auctionId: a1.id,
        side: "sell",
        sizeText: "0.5",
        limitText: (r * 1.2).toFixed(2),
        roll: false,
        selfSubmit: true,
      },
      (s) => log("S", s),
    );
    // a buy placed and cancelled before the call (ReclaimProof)
    await until("buyer change in the tree", spendable(B, "TQ", 100));
    await until("second sell indexed", placed(S, a1.id, 2));
    await B.placeOrder(
      {
        auctionId: a1.id,
        side: "buy",
        sizeText: "0.1",
        limitText: (r * 0.5).toFixed(2),
        roll: false,
        selfSubmit: true,
      },
      (s) => log("B", s),
    );
    await until(
      "cancellable order visible",
      async () => (
        await B.sync(),
        orderOf(B, a1.id).some((o) => o.size === "0.1" && o.status === "open")
      ),
    );
    await B.cancel(orderOf(B, a1.id).find((o) => o.size === "0.1")!.id, (s) => log("B", s));
    await until(
      "cancel indexed",
      async () => (
        await B.sync(),
        orderOf(B, a1.id).find((o) => o.size === "0.1")?.status === "cancelled"
      ),
    );
    check(
      "cancel before the call",
      true,
      "ReclaimProof refunded the lock while the auction was collecting",
    );

    const p1 = await until("auction 1 printed", () => printOf(a1.id), 900_000);
    const row1 = (await auctionRow(a1.id))!;
    const [pStar, refUsd] = [BigInt(p1.pStar), BigInt(row1.refUsd!)];
    const inBand = pStar * 10_000n >= refUsd * 9_500n && pStar * 10_000n <= refUsd * 10_500n;
    check(
      "1 TSLA CLOSE clears at one p* in the band",
      inBand && p1.crossedQty === "1000000",
      `p* ${Number(pStar) / 1e6} vs ref ${Number(refUsd) / 1e6}, crossed ${Number(p1.crossedQty) / 1e6} TSLA`,
    );
    await until(
      "results readable by their owners",
      async () => (
        await B.sync(),
        await S.sync(),
        orderOf(B, a1.id).some((o) => o.status === "settled") &&
          orderOf(S, a1.id).every((o) => o.status === "settled")
      ),
    );
    const buy = orderOf(B, a1.id).find((o) => o.status === "settled")!;
    const sells = orderOf(S, a1.id);
    check(
      "owners read their fills",
      buy.filled === "1.0" &&
        sells.some((o) => o.filled === "1.0") &&
        sells.some((o) => o.size === "0.5" && o.filled === "0.0"),
      `buyer filled ${buy.filled} @ ${buy.pStar}; seller fills ${sells.map((o) => o.filled).join(", ")}`,
    );

    // ---- 2. the print is in the settle transaction; no order data on chain or in the DB ---------------------------
    const receipt = (await chain.getTransactionReceipt(p1.tx))!;
    const names = receipt.logs.map((l) => POOL_ABI.parseLog(l)?.name);
    check(
      "2 print lands in the settle block",
      row1.proofTx === p1.tx &&
        names.includes("Printed") &&
        names.includes("AuctionSettled") &&
        receipt.blockNumber === p1.block,
      `tx ${p1.tx} block ${receipt.blockNumber}: ${names.filter(Boolean).join(", ")}`,
    );
    const sealedOnly = (
      await api<{ events: { args: { sealedOrder: string } }[] }>(
        `/api/pool/events?names=OrderResting&after=${receipt.blockNumber - 20_000}`,
      )
    ).events.every((e) => {
      const text = Buffer.from(e.args.sealedOrder.slice(2), "hex").toString("utf8");
      return text === "" || Object.keys(JSON.parse(text)).sort().join() === "o,u";
    });
    check(
      "2 no plaintext order data",
      sealedOnly,
      "OrderResting carries only commitments and ciphertexts {o,u}",
    );
  }

  // ---- 3. NAV auction of TreasuryQuote uses NAV as its reference ----------------------------------------------
  if (FROM <= 3) {
    const reuse = process.env["NAV_ID"];
    const a3 = reuse
      ? { id: Number(reuse) }
      : await schedule(d.tokens.TQ, d.tokens.USDG, KIND.NAV, 420);
    if (!reuse) {
      await until(
        "NAV auction indexed",
        async () => (await indexed(B, a3.id)()) && (await indexed(S, a3.id)()),
      );
      const navNow =
        Number(
          await new Contract(
            d.tokens.TQ,
            ["function nav() view returns (uint256)"],
            chain,
          ).getFunction("nav")(),
        ) / 1e6;
      await B.placeOrder(
        {
          auctionId: a3.id,
          side: "sell",
          sizeText: "100",
          limitText: "",
          roll: false,
          selfSubmit: true,
        },
        (s) => log("B", s),
      );
      await S.placeOrder(
        {
          auctionId: a3.id,
          side: "buy",
          sizeText: "100",
          limitText: (navNow * 1.005).toFixed(6),
          lockText: (100 * navNow * 1.006).toFixed(6),
          roll: false,
          selfSubmit: true,
        },
        (s) => log("S", s),
      );
    }
    const p3 = await until("NAV auction printed", () => printOf(a3.id), 900_000);
    const row3 = (await auctionRow(a3.id))!;
    // AuctionPool's callBlock is the parent-chain block number on this Orbit chain; the pin's own L2 block is the event's
    const pin = (
      await api<{ events: { block: number; args: { id: string } }[] }>(
        `/api/pool/events?names=AuctionPinned&after=${d.deployBlock}`,
      )
    ).events.find((e) => Number(e.args.id) === a3.id)!;
    const navAtPin = await new Contract(
      d.tokens.TQ,
      ["function nav() view returns (uint256)"],
      chain,
    ).getFunction("nav")({ blockTag: pin.block });
    check(
      "3 NAV auction references NAV",
      BigInt(row3.refUsd!) === BigInt(navAtPin),
      `ref ${Number(row3.refUsd) / 1e6} = NAV ${Number(navAtPin) / 1e6} at the pin; p* ${Number(p3.pStar) / 1e6}, crossed ${Number(p3.crossedQty) / 1e6} TQ`,
    );
  }

  if (FROM <= 4) {
    // ---- 4. an RFQ block settles privately at the reference ------------------------------------------------------
    const [bs, ss] = [newSession(), newSession()];
    const request: RfqIntent = {
      kind: "request",
      asset: d.tokens.TSLA,
      side: "buy",
      qty: "500000",
      nonce: String(BigInt(keccak256(toUtf8Bytes(String(Date.now())))) >> 8n),
    };
    await sendIntent(bs, ss.pub, request);
    const got = await until("seller reads the request", async () =>
      (await readIntents(ss)).find((m) => m.intent.nonce === request.nonce),
    );
    await S.openRfq("TSLA", 240, (s) => log("S", s));
    const block = await until("RFQ auction indexed", async () => {
      await S.sync();
      return [...S.auctions.values()]
        .filter((a) => a.kind === "RFQ" && !a.pinned && !a.settled && !a.voided)
        .sort((a, b) => b.id - a.id)[0];
    });
    await sendIntent(ss, got.from, {
      ...request,
      kind: "accept",
      side: "sell",
      auctionId: block.id,
    });
    const rfq = S.rfqCommitmentOf({
      symbol: "TSLA",
      qty: request.qty,
      buyerPub: bs.pub,
      sellerPub: ss.pub,
      nonce: request.nonce,
    });
    await until("seller TSLA spendable", spendable(S, "TSLA", 0.5));
    await S.placeOrder(
      { auctionId: block.id, side: "sell", sizeText: "0.5", limitText: "", rfq, selfSubmit: true },
      (s) => log("S", s),
    );
    const accepted = await until("buyer reads the accept", async () =>
      (await readIntents(bs)).find(
        (m) => m.intent.kind === "accept" && m.intent.nonce === request.nonce,
      ),
    );
    const rfqB = B.rfqCommitmentOf({
      symbol: "TSLA",
      qty: accepted.intent.qty,
      buyerPub: bs.pub,
      sellerPub: accepted.from,
      nonce: accepted.intent.nonce,
    });
    await until("buyer indexed the RFQ auction", indexed(B, block.id));
    const r4 = await ref("TSLA");
    await B.placeOrder(
      {
        auctionId: block.id,
        side: "buy",
        sizeText: "0.5",
        limitText: "",
        lockText: (0.5 * r4 * 1.05).toFixed(6),
        rfq: rfqB,
        selfSubmit: true,
      },
      (s) => log("B", s),
    );
    const p4 = await until("RFQ block printed", () => printOf(block.id), 900_000);
    const row4 = (await auctionRow(block.id))!;
    check(
      "4 RFQ block settles at the reference",
      p4.pStar === row4.refUsd && p4.crossedQty === "500000",
      `p* ${Number(p4.pStar) / 1e6} = ref ${Number(row4.refUsd) / 1e6}, crossed ${Number(p4.crossedQty) / 1e6} TSLA`,
    );
  }

  // ---- 5. the schedule skips an asset's auctions on a seeded Ex-Date ------------------------------------------
  const day = new Date(Date.now() + 5 * 86_400_000);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  const iso = day.toISOString().slice(0, 10);
  const window = `/api/auctions?from=${iso}T12:00:00Z&to=${iso}T23:59:00Z`;
  const actionId = await db<number>("lum_corporate_action_put", {
    p_symbol: "PLTR",
    p_ex_date: iso,
    p_kind: "dividend",
    p_note: "acceptance test",
  });
  await cron("calendar");
  const paused = (await api<{ auctions: { symbol: string }[] }>(window)).auctions;
  await db("lum_corporate_action_delete", { p_id: actionId });
  await cron("calendar");
  const resumed = (await api<{ auctions: { symbol: string }[] }>(window)).auctions;
  check(
    "5 Ex-Date pauses the asset",
    !paused.some((a) => a.symbol === "PLTR") &&
      paused.some((a) => a.symbol === "TSLA") &&
      resumed.some((a) => a.symbol === "PLTR"),
    `${iso}: PLTR ${paused.filter((a) => a.symbol === "PLTR").length} calls with the Ex-Date, ${resumed.filter((a) => a.symbol === "PLTR").length} after removing it`,
  );

  // ---- withdraw: the bought TSLA out of the pool to the buyer's wallet ----------------------------------------
  // (runs when check 1 bought TSLA this run; a resumed run may have nothing left to withdraw)
  if (FROM > 2 && !(await spendable(B, "TSLA", 1)()))
    return log("withdraw skipped: no shielded TSLA to withdraw");
  await until("bought TSLA spendable", spendable(B, "TSLA", 1));
  const before = await new Contract(d.tokens.TSLA, ERC20, chain).getFunction("balanceOf")(
    bw.address,
  );
  await B.withdraw("TSLA", "1", bw.address, true, (s) => log("B", s));
  const after = await new Contract(d.tokens.TSLA, ERC20, chain).getFunction("balanceOf")(
    bw.address,
  );
  check(
    "withdraw to the wallet",
    after - before === parseUnits("1", 18),
    `wallet TSLA +${Number(after - before) / 1e18}`,
  );
}

main()
  .catch((e) => check("run", false, String((e as Error)?.stack ?? e).slice(0, 600)))
  .finally(async () => {
    ticking = false;
    await ticker.catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
    process.exit(failed.length ? 1 : 0);
  });
