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
          return ok({ cron, operator: { address: operator().address, eth: formatEther(wei) } });
        }),
    },
  },
});
