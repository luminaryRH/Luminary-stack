// nav-watcher (every 5 minutes): mirrors real prices into the testnet MockAggregators.
// Prices come from Chainlink on Robinhood Chain mainnet (4663); it has no NFLX feed, so NFLX is Robinhood's public
// quote midpoint. Only AuctionPool.pin reads the feeds, so a feed is pushed only while an auction on it calls within
// NEEDED_SEC, when the price moved or its last round is getting old (MAX_STALENESS is 1 hour); pinAuctions refreshes
// it once more at the call if needed. The mirror never re-stamps a frozen source as new: a source round older than its
// heartbeat (SOURCE_MAX_AGE) is not pushed, so the pool's own staleness check (MAX_STALENESS) still voids on it, and a
// halted, one-sided or wide Robinhood quote is refused. TreasuryQuote's NAV is no longer raised (auctions quote in USDG
// since 2026-10-16); it is still recorded for old TQ balances. The dashboard's marks come from the database every
// 5 minutes, whatever is pushed.
import { Contract } from "ethers";
import { mainnetProvider, provider } from "./chain";
import { rpc } from "./db";
import { FEED_ABI, TQ_ABI, deployment } from "./pool/contract";
import type { OpenAuction } from "./pool/committee";
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
const NEEDED_SEC = 15 * 60; // feeds of auctions calling this soon are kept current (three watcher runs)
// A source round older than its own heartbeat is frozen and is never mirrored as fresh. Chainlink heartbeats on 4663 are
// at most 24 h (USDG/USD updates on deviation and every 24 h; stock feeds pause outside trading), so 25 h; the Robinhood
// quote is generated live, so 10 minutes.
const SOURCE_MAX_AGE: Record<string, number> = { "chainlink-4663": 25 * 3_600, "robinhood-quote": 10 * 60 };
const MAX_SPREAD_BPS = 200n; // a Robinhood quote wider than 2% is not a price
const MAX_JUMP_BPS = 2_000n; // a push more than 20% from the mirrored price waits for a person (logged)

export interface SourcePrice {
  answer: bigint; // 8 decimals, USD per token
  updatedAt: bigint; // unix seconds of the source round
  source: string;
}

interface RobinhoodQuote {
  bid: string;
  ask: string;
  tokenBid?: string;
  tokenAsk?: string;
  isTradingHalt?: boolean;
  generatedAt?: string;
}

/** Robinhood's per-token quote midpoint in 8 decimals, refused when halted, one-sided, crossed or wide. */
export function quoteMid(q: RobinhoodQuote): { answer: bigint; updatedAt: bigint } {
  if (q.isTradingHalt) throw new Error("trading halt");
  // per token (any split multiplier applied), which is what one token in the pool is worth
  const e8 = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad quote side ${v}`);
    return BigInt(Math.round(n * 1e8));
  };
  const [bid, ask] = [e8(q.tokenBid ?? q.bid), e8(q.tokenAsk ?? q.ask)];
  if (ask < bid) throw new Error("crossed quote");
  const mid = (bid + ask) / 2n;
  if ((ask - bid) * 10_000n > mid * MAX_SPREAD_BPS) throw new Error("quote spread above 2%");
  const at = Date.parse(q.generatedAt ?? "");
  if (!Number.isFinite(at)) throw new Error("quote has no time");
  return { answer: mid, updatedAt: BigInt(Math.floor(at / 1000)) };
}

async function sourcePrice(symbol: string): Promise<SourcePrice> {
  const feed = MAINNET_FEEDS[symbol];
  if (!feed) {
    const res = await fetch(`https://api.robinhood.com/rhj/prices/${symbol}`, { signal: AbortSignal.timeout(10_000) });
    const q = ((await res.json()) as { quotes?: RobinhoodQuote[] }).quotes?.[0];
    if (!q) throw new Error(`no Robinhood quote for ${symbol}`);
    return { ...quoteMid(q), source: "robinhood-quote" };
  }
  const [, answer, , updatedAt] = (await new Contract(feed, FEED_ABI, mainnetProvider()).getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint];
  if (answer <= 0n) throw new Error("non-positive source answer");
  return { answer, updatedAt, source: "chainlink-4663" };
}

/** Feed symbols (asset and quote) of the unpinned auctions calling before `until`. */
export function feedsOf(open: OpenAuction[], until: number) {
  const feeds: Record<string, string> = deployment().feeds;
  const symbolOf = new Map(Object.entries(deployment().tokens).map(([symbol, token]) => [token.toLowerCase(), symbol] as const));
  const symbols = open.filter((a) => !a.pinned && a.callTime <= until).flatMap((a) => [symbolOf.get(a.asset), symbolOf.get(a.quote)]);
  return new Set(symbols.filter((s): s is string => s !== undefined && s in feeds));
}

/**
 * Pushes `symbol`'s source price when it moved or the feed's round is older than `maxAge` (`answer` when already
 * fetched). "current" when nothing was needed, "pending" when a push is in flight or was just sent.
 */
export async function refreshFeed(symbol: string, now: bigint, busy: Set<string>, maxAge = REFRESH_SEC, price?: SourcePrice) {
  if (busy.has(`push:${symbol}`)) return "pending";
  const address = (deployment().feeds as Record<string, string>)[symbol]!;
  const [, current, , updatedAt] = (await new Contract(address, FEED_ABI, provider()).getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint];
  price ??= await sourcePrice(symbol);
  const answer = price.answer;
  // never re-stamp an old source round: the pool must see a frozen source as stale and void the auction
  if (now - price.updatedAt > BigInt(SOURCE_MAX_AGE[price.source] ?? 0)) return "stale";
  const delta = answer > current ? answer - current : current - answer;
  if (current > 0n && delta * 10_000n > current * MAX_JUMP_BPS && now - updatedAt < BigInt(maxAge)) {
    console.error("price jump above 20% not mirrored; check the source", symbol, String(current), String(answer));
    return "current";
  }
  const moved = delta * 10_000n >= current * MOVE_BPS;
  if (!moved && now - updatedAt < BigInt(maxAge)) return "current";
  return (await sendOperator(address, FEED_ABI.encodeFunctionData("push", [answer]), `push:${symbol}`)) ? "pending" : "current";
}

export async function watchPrices() {
  const d = deployment();
  const p = provider();
  const now = BigInt((await p.getBlock("latest"))!.timestamp);
  const busy = await inFlightKeys();
  const needed = feedsOf(await rpc<OpenAuction[]>("lum_pool_open_auctions", {}), Number(now) + NEEDED_SEC);
  const marks: { symbol: string; usd: string; source: string }[] = [];
  const pushed: string[] = [];
  const errors: string[] = [];
  for (const symbol of Object.keys(d.feeds)) {
    try {
      const price = await sourcePrice(symbol);
      marks.push({ symbol, usd: String(price.answer / 100n), source: price.source }); // 8 dp → micro-USD
      if (needed.has(symbol) && !busy.has(`push:${symbol}`) && (await refreshFeed(symbol, now, busy, REFRESH_SEC, price)) === "pending") pushed.push(symbol);
    } catch (e) {
      errors.push(`${symbol}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  const nav = BigInt(await new Contract(d.tokens.TQ, TQ_ABI, p).getFunction("nav")());
  await rpc("lum_marks_put", { p_rows: marks, p_nav: String(nav) });
  return { pushed, marks: marks.length, nav: String(nav), ...(errors.length ? { error: errors.join("; ") } : {}) };
}
