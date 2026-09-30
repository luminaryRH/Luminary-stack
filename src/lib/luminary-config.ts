// Public network and contract configuration, shared by the browser, the server and scripts. Addresses come from the
// deployment file Deploy.s.sol writes (contracts/deployments/46630.json).
import deployment from "../../contracts/deployments/46630.json";

export interface Deployment {
  chainId: number;
  deployBlock: number;
  operator: string;
  AuctionPool: string;
  PrintRegistry: string;
  RfqDesk: string;
  ScreeningGate: string;
  DisclosureRegistry: string;
  FeeVault: string;
  LUMI: string;
  feeds: Record<"TSLA" | "AMZN" | "AMD" | "PLTR" | "NFLX" | "ETH" | "USDG", string>;
  tokens: Record<"TSLA" | "AMZN" | "AMD" | "PLTR" | "NFLX" | "USDG" | "TQ", string>;
}

export const CHAIN_ID = 46630;
export const CHAIN_HEX = "0xb626";

export const DEPLOYMENT: Deployment | null = deployment.chainId === CHAIN_ID ? (deployment as Deployment) : null;

export const CONFIG = {
  chainId: CHAIN_ID,
  chainName: "Robinhood Chain Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  faucet: "https://faucet.testnet.chain.robinhood.com",
} as const;

/** The five stock tokens the testnet faucet hands out, all 18 decimals. */
export const STOCKS = ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"] as const;
export type Stock = (typeof STOCKS)[number];

export const txUrl = (hash: string) => `${CONFIG.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${CONFIG.explorer}/address/${address}`;
