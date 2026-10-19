// Price marks (every 5 minutes, from the nav job): the dashboard's reference prices, read from the same Chainlink feeds
// on Robinhood Chain that AuctionPool reads at each pin. Nothing is pushed anywhere: the pool prices every auction from
// Chainlink itself, so the operator has no say over the reference.
import { Contract } from "ethers";
import { provider } from "./chain";
import { rpc } from "./db";
import { FEED_ABI, deployment } from "./pool/contract";

/** Every 5 minutes: records each feed's latest answer (micro-USD) as a mark for the dashboard. */
export async function watchPrices() {
  const feeds = deployment().feeds as Record<string, string>;
  const marks: { symbol: string; usd: string; source: string }[] = [];
  const errors: string[] = [];
  await Promise.all(
    Object.entries(feeds).map(async ([symbol, address]) => {
      try {
        const [, answer] = (await new Contract(address, FEED_ABI, provider()).getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint, bigint];
        if (answer <= 0n) throw new Error("non-positive answer");
        marks.push({ symbol, usd: String(answer / 100n), source: "chainlink-4663" }); // 8 dp → micro-USD
      } catch (e) {
        errors.push(`${symbol}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
    }),
  );
  await rpc("lum_marks_put", { p_rows: marks, p_nav: null });
  return { marks: marks.length, ...(errors.length ? { error: errors.join("; ") } : {}) };
}
