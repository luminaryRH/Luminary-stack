import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

const PAGE_ROWS = 5_000;
const PAGE_BYTES = 2_500_000;
const NAMES = new Set(["Deposited", "Transacted", "OrderResting", "OrderFeePaid", "AuctionScheduled", "AuctionPinned", "AuctionSettled", "AuctionVoided", "OrderReclaimed", "TreeAdvanced", "Disclosed"]);

// Indexed pool events (all public on chain) for the browser client to find its notes and settlement results.
export const Route = createFileRoute("/api/pool_/events")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const names = (params.get("names") ?? "").split(",").filter((n) => NAMES.has(n));
          // The cursor is (after, afterLog): the block and log index of the last event the caller holds. A caller that
          // sends only `after` resumes after that whole block, which is what the endpoint has always meant.
          const int = (v: string | null, fallback: number) => (v !== null && v !== "" && Number.isInteger(Number(v)) ? Number(v) : fallback);
          const after = int(params.get("after"), -1);
          const afterLog = int(params.get("afterLog"), 2_147_483_647);
          const rows = names.length ? await rpc<unknown[]>("lum_pool_events", { p_names: names, p_after_block: after, p_after_log: afterLog, p_limit: PAGE_ROWS }) : [];
          // a page stays well under Vercel's 4.5 MB response limit: cut it by size, and say that more follows
          const events: unknown[] = [];
          let bytes = 0;
          for (const e of rows) {
            bytes += JSON.stringify(e).length;
            if (events.length > 0 && bytes > PAGE_BYTES) break;
            events.push(e);
          }
          const res = ok({ events, more: events.length < rows.length || rows.length === PAGE_ROWS });
          res.headers.set("Cache-Control", "public, max-age=5");
          return res;
        }),
    },
  },
});
