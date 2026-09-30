import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized, runJob } from "@/server/luminary/cron";
import { fail, handle, ok } from "@/server/luminary/http";
import { publishAssociation } from "@/server/luminary/pool/association";
import { pinAuctions, scheduleAuctions, settleAuctions } from "@/server/luminary/pool/auctions";
import { indexPool } from "@/server/luminary/pool/indexer";
import { tendSends } from "@/server/luminary/pool/sends";
import { advancePoolTree } from "@/server/luminary/pool/tree";

// Every minute (Supabase pg_cron → pg_net): tend operator sends, index the chain, append queued commitments, put the
// calendar's auctions on chain, pin auctions at their call, clear + prove + settle pinned ones, publish the association set.
export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          if (!isCronAuthorized(request)) return fail("Unauthorized", 401);
          return ok(
            await runJob("tick", {
              sends: tendSends,
              index: indexPool,
              tree: advancePoolTree,
              schedule: scheduleAuctions,
              pin: pinAuctions,
              settle: settleAuctions,
              association: publishAssociation,
            }),
          );
        }),
    },
  },
});
