import { JsonRpcProvider } from "ethers";
import { CONFIG } from "@/lib/luminary-config";
import { env } from "./env";

let cached: JsonRpcProvider | undefined;

export const chainId = () => CONFIG.chainId;

/** Robinhood Chain testnet. RPC_URL (server) overrides the public RPC, e.g. with an Alchemy endpoint. */
export function provider(): JsonRpcProvider {
  cached ??= new JsonRpcProvider(process.env["RPC_URL"]?.trim() || CONFIG.rpcUrl, chainId(), { staticNetwork: true });
  return cached;
}

let mainnet: JsonRpcProvider | undefined;

/** Robinhood Chain mainnet (4663), read only: the Chainlink feeds the nav-watcher mirrors. */
export function mainnetProvider(): JsonRpcProvider {
  mainnet ??= new JsonRpcProvider(env("MAINNET_RPC_URL"), 4663, { staticNetwork: true });
  return mainnet;
}
