import { createFileRoute } from "@tanstack/react-router";
import { chainId } from "@/server/luminary/chain";
import { rpc } from "@/server/luminary/db";
import { handle, ok } from "@/server/luminary/http";
import { sealingPublicKey } from "@/server/luminary/pool/committee";
import { deployment, gate, operator, pool } from "@/server/luminary/pool/contract";
import { relayQuote } from "@/server/luminary/pool/relay";
import { unitOf } from "@/shielded/protocol";

interface Asset {
  symbol: string;
  address: string;
  feed: string | null;
  decimals: number;
  kind: "stock" | "quote";
}

// Public pool configuration for the browser client: contracts, the key to seal orders to, relayer, markets, tree.
export const Route = createFileRoute("/api/pool")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const d = deployment();
          const c = pool();
          const [assets, treeSize, commitmentCount, root, feeBps, depositFee, associationRequired, transactFee, orderFee] = await Promise.all([
            rpc<Asset[]>("lum_assets_list", {}),
            c.getFunction("treeSize")(),
            c.getFunction("commitmentCount")(),
            c.getFunction("root")(),
            c.getFunction("feeBps")(),
            c.getFunction("depositFee")(),
            gate().getFunction("associationRequired")(),
            relayQuote("transact"),
            relayQuote("order"),
          ]);
          const res = ok({
            chainId: chainId(),
            pool: d.AuctionPool,
            gate: d.ScreeningGate,
            disclosure: d.DisclosureRegistry,
            desk: d.RfqDesk,
            depositFeeWei: String(depositFee),
            associationRequired: Boolean(associationRequired),
            sealPublic: sealingPublicKey(), // the committee group key when there is one
            relayer: operator().address,
            relayFees: { transactWei: String(transactFee), orderWei: String(orderFee) },
            feeBps: Number(feeBps),
            markets: assets.map((a) => ({ symbol: a.symbol, token: a.address, decimals: a.decimals, unit: String(unitOf(a.decimals)), kind: a.kind, feed: a.feed })),
            tree: { size: Number(treeSize), queued: Number(commitmentCount), root },
          });
          res.headers.set("Cache-Control", "public, max-age=10");
          return res;
        }),
    },
  },
});
