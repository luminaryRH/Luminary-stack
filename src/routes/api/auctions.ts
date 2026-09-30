import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";

const DAY = 86_400_000;

// GET ?from=ISO&to=ISO (default: the last day through the next seven): planned and on-chain auctions, all public.
export const Route = createFileRoute("/api/auctions")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const at = (v: string | null, fallback: number) => {
            const t = v ? Date.parse(v) : NaN;
            return new Date(Number.isFinite(t) ? t : fallback).toISOString();
          };
          const from = at(params.get("from"), Date.now() - DAY);
          const to = at(params.get("to"), Date.now() + 7 * DAY);
          const res = ok({ auctions: await rpc<unknown[]>("lum_auctions_between", { p_from: from, p_to: to }) });
          res.headers.set("Cache-Control", "public, max-age=10");
          return res;
        }),
    },
  },
});
