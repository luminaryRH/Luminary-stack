// bun src/server/luminary/nav.check.ts — the Robinhood quote guard refuses halted, one-sided, crossed, wide and undated quotes.
import { quoteMid } from "./nav";

const now = new Date().toISOString();
const good = quoteMid({ bid: "70.24", ask: "70.25", tokenBid: "70.24", tokenAsk: "70.25", generatedAt: now });
if (good.answer !== 7_024_500_000n) throw new Error(`mid ${good.answer}`);
const bad = [
  { bid: "0", ask: "70", generatedAt: now },
  { bid: "71", ask: "70", generatedAt: now },
  { bid: "60", ask: "70", generatedAt: now },
  { bid: "70", ask: "70.1", isTradingHalt: true, generatedAt: now },
  { bid: "70", ask: "70.1" },
];
for (const q of bad) {
  let threw = false;
  try {
    quoteMid(q);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`accepted ${JSON.stringify(q)}`);
}
console.log("nav.check: ok");
