import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized, runJob } from "@/server/luminary/cron";
import { fail, handle, ok } from "@/server/luminary/http";
import { watchPrices } from "@/server/luminary/nav";

// Every 5 minutes: mirror mainnet prices into the testnet feeds and accrue TreasuryQuote's NAV.
export const Route = createFileRoute("/api/cron/nav")({
  server: {
    handlers: {
      GET: ({ request }) => handle(async () => (isCronAuthorized(request) ? ok(await runJob("nav", { prices: watchPrices })) : fail("Unauthorized", 401))),
    },
  },
});
