import { createFileRoute } from "@tanstack/react-router";
import { formatEther } from "ethers";
import { provider } from "@/server/luminary/chain";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";
import { operator } from "@/server/luminary/pool/contract";

// Worker health: each cron step's last run and stall streak, and the operator wallet's gas balance.
export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const [cron, wei] = await Promise.all([rpc<unknown>("lum_cron_status", {}), provider().getBalance(operator().address)]);
          // worker errors are public here: keep their shape, drop any long number they quote (amounts, keys, salts)
          const scrub = (v: unknown, inError: boolean): unknown =>
            typeof v === "string"
              ? inError ? v.replace(/\d{7,}/g, "#") : v
              : Array.isArray(v)
                ? v.map((x) => scrub(x, inError))
                : v && typeof v === "object"
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, inError || k === "error" || k === "errors")]))
                  : v;
          const redacted = scrub(cron, false);
          return ok({ cron: redacted, operator: { address: operator().address, eth: formatEther(wei) } });
        }),
    },
  },
});
