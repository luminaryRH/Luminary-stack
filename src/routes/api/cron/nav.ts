import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized, runJob } from "@/server/luminary/cron";
import { fail, handle, ok } from "@/server/luminary/http";
import { watchAlerts } from "@/server/luminary/alerts";
import { watchPrices } from "@/server/luminary/nav";

// Every 5 minutes: record the Chainlink price marks for the dashboard, then check the alert conditions (alerts.ts).
export const Route = createFileRoute("/api/cron/nav")({
  server: {
    handlers: {
      GET: ({ request }) => handle(async () => (isCronAuthorized(request) ? ok(await runJob("nav", { prices: watchPrices, alerts: watchAlerts })) : fail("Unauthorized", 401))),
    },
  },
});
