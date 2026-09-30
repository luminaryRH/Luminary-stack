import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

// GET ?symbol=TSLA&limit=100: the public print tape (p*, crossed volume, settle tx), newest first.
export const Route = createFileRoute("/api/prints")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const symbol = params.get("symbol")?.toUpperCase() || null;
          const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 100) || 100));
          const res = ok({ prints: await rpc<unknown[]>("lum_prints_list", { p_symbol: symbol, p_limit: limit }) });
          res.headers.set("Cache-Control", "public, max-age=10");
          return res;
        }),
    },
  },
});
