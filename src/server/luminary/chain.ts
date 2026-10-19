import { JsonRpcProvider } from "ethers";
import { CONFIG } from "@/lib/luminary-config";

let cached: JsonRpcProvider | undefined;

/** The chain the app serves (4663, Robinhood Chain mainnet). */
export const chainId = () => CONFIG.chainId;

/** Robinhood Chain mainnet. RPC_URL (server) overrides the public RPC, e.g. with an Alchemy endpoint. */
export function provider(): JsonRpcProvider {
  cached ??= new JsonRpcProvider(process.env["RPC_URL"]?.trim() || CONFIG.rpcUrl, chainId(), { staticNetwork: true });
  return cached;
}
