import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

// The latest reference marks the nav-watcher mirrored (micro-USD per token), TreasuryQuote's NAV and its 30-day history.
export const Route = createFileRoute("/api/marks")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const [latest, history] = await Promise.all([rpc<unknown>("lum_marks_latest", {}), rpc<unknown[]>("lum_nav_history", { p_days: 30 })]);
          const res = ok({ ...(latest as object), navHistory: history });
          res.headers.set("Cache-Control", "public, max-age=30");
          return res;
        }),
    },
  },
});
