// nav-watcher (every 5 minutes): mirrors real prices into the testnet MockAggregators and accrues TreasuryQuote's NAV.
// Prices come from Chainlink on Robinhood Chain mainnet (4663); it has no NFLX feed, so NFLX is Robinhood's public
// quote midpoint. A feed is pushed when the price moved or its last round is getting old (AuctionPool.MAX_STALENESS is
// 1 hour). NAV per share follows a fixed APY from the deployment block.
import { Contract } from "ethers";
import { mainnetProvider, provider } from "./chain";
import { rpc } from "./db";
import { FEED_ABI, TQ_ABI, deployment } from "./pool/contract";
import { inFlightKeys, sendOperator } from "./pool/sends";

const MAINNET_FEEDS: Record<string, string> = {
  TSLA: "0x4A1166a659A55625345e9515b32adECea5547C38",
  AMZN: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
  AMD: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72",
  PLTR: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c",
  ETH: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  USDG: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
};
const MOVE_BPS = 10n; // push on a 0.1% move
const REFRESH_SEC = 30 * 60; // or when the round is this old
const APY_BPS = 450n; // TreasuryQuote's accrual
const YEAR_SEC = 365n * 86_400n;

/** Robinhood's quote midpoint in 8 decimals. */
async function robinhoodMid(symbol: string): Promise<bigint> {
  const res = await fetch(`https://api.robinhood.com/rhj/prices/${symbol}`, { signal: AbortSignal.timeout(10_000) });
  const q = ((await res.json()) as { quotes?: { bid: string; ask: string }[] }).quotes?.[0];
  if (!q) throw new Error(`no Robinhood quote for ${symbol}`);
  const e8 = (v: string) => BigInt(Math.round(Number(v) * 1e8));
  return (e8(q.bid) + e8(q.ask)) / 2n;
}

async function sourcePrice(symbol: string): Promise<{ answer: bigint; source: string }> {
  const feed = MAINNET_FEEDS[symbol];
  if (!feed) return { answer: await robinhoodMid(symbol), source: "robinhood-quote" };
  const [, answer] = (await new Contract(feed, FEED_ABI, mainnetProvider()).getFunction("latestRoundData")()) as [bigint, bigint];
  return { answer, source: "chainlink-4663" };
}

export async function watchPrices() {
  const d = deployment();
  const p = provider();
  const now = BigInt((await p.getBlock("latest"))!.timestamp);
  const busy = await inFlightKeys();
  const marks: { symbol: string; usd: string; source: string }[] = [];
  const pushed: string[] = [];
  const errors: string[] = [];
  for (const [symbol, address] of Object.entries(d.feeds)) {
    try {
      const { answer, source } = await sourcePrice(symbol);
      marks.push({ symbol, usd: String(answer / 100n), source }); // 8 dp → micro-USD
      const [, current, , updatedAt] = (await new Contract(address, FEED_ABI, p).getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint];
      const moved = (answer > current ? answer - current : current - answer) * 10_000n >= current * MOVE_BPS;
      if (!moved && now - updatedAt < REFRESH_SEC) continue;
      if (busy.has(`push:${symbol}`)) continue;
      const tx = await sendOperator(address, FEED_ABI.encodeFunctionData("push", [answer]), `push:${symbol}`);
      if (tx) pushed.push(symbol);
    } catch (e) {
      errors.push(`${symbol}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  // NAV = 1.000000 × (1 + APY × elapsed / year) since the deployment, raised in steps the contract accepts (≤ 1%)
  const tq = new Contract(d.tokens.TQ, TQ_ABI, p);
  const nav = BigInt(await tq.getFunction("nav")());
  const t0 = BigInt((await p.getBlock(d.deployBlock))!.timestamp);
  const target = 1_000_000n + (1_000_000n * APY_BPS * (now - t0)) / (10_000n * YEAR_SEC);
  let navTx: string | null = null;
  if (target > nav && !busy.has("nav")) {
    const next = target < (nav * 10_100n) / 10_000n ? target : (nav * 10_100n) / 10_000n;
    navTx = await sendOperator(d.tokens.TQ, TQ_ABI.encodeFunctionData("raiseNav", [next]), "nav").catch((e) => {
      errors.push(`nav: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      return null;
    });
  }
  await rpc("lum_marks_put", { p_rows: marks, p_nav: String(nav) });
  return { pushed, marks: marks.length, nav: String(nav), ...(navTx ? { navTx } : {}), ...(errors.length ? { error: errors.join("; ") } : {}) };
}
