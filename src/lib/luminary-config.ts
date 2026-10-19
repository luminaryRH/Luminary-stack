// Public network and contract configuration, shared by the browser, the server and scripts. Addresses come from the
// deployment file Deploy.s.sol writes (contracts/deployments/4663.json). Until it holds a deployment (chainId 4663),
// DEPLOYMENT is null and the app says the pool is not deployed.
import deployment from "../../contracts/deployments/4663.json";

export interface Deployment {
  chainId: number;
  deployBlock: number;
  operator: string;
  deployer: string;
  owner: string; // the TimelockController (48 h) that owns the pool and the gate
  safe: string; // the Safe that controls the timelock
  safeSigners: string[];
  AuctionPool: string;
  PrintRegistry: string;
  RfqDesk: string;
  ScreeningGate: string;
  DisclosureRegistry: string;
  feeds: Record<"TSLA" | "AMZN" | "AMD" | "PLTR" | "ETH" | "USDG", string>;
  tokens: Record<"TSLA" | "AMZN" | "AMD" | "PLTR" | "USDG", string>;
}

export const CHAIN_ID = 4663;
export const CHAIN_HEX = "0x1237";

export const DEPLOYMENT: Deployment | null = deployment.chainId === CHAIN_ID ? (deployment as unknown as Deployment) : null;

export const CONFIG = {
  chainId: CHAIN_ID,
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
} as const;

/** The stock tokens with a Chainlink feed on Robinhood Chain, all 18 decimals. */
export const STOCKS = ["TSLA", "AMZN", "AMD", "PLTR"] as const;
export type Stock = (typeof STOCKS)[number];

export const txUrl = (hash: string) => `${CONFIG.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${CONFIG.explorer}/address/${address}`;
