import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

const day = (v: string | null, fallback: Date) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback.toISOString().slice(0, 10));

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD: NYSE holidays / early closes and corporate actions (Ex-Dates pause an asset).
export const Route = createFileRoute("/api/calendar")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const now = Date.now();
          const res = ok(
            await rpc<unknown>("lum_calendar_between", {
              p_from: day(params.get("from"), new Date(now - 7 * 86_400_000)),
              p_to: day(params.get("to"), new Date(now + 60 * 86_400_000)),
            }),
          );
          res.headers.set("Cache-Control", "public, max-age=300");
          return res;
        }),
    },
  },
});
