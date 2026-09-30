import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized, runJob } from "@/server/luminary/cron";
import { fail, handle, ok } from "@/server/luminary/http";
import { planCalendar, seedAssets } from "@/server/luminary/pool/auctions";

// Daily (and hourly is harmless): the assets from the deployment, then the next week of calendar auctions.
export const Route = createFileRoute("/api/cron/calendar")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => (isCronAuthorized(request) ? ok(await runJob("calendar", { assets: seedAssets, plan: () => planCalendar() })) : fail("Unauthorized", 401))),
    },
  },
});
