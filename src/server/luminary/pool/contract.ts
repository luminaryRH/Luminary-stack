// AuctionPool and its companions from the operator side. The operator wallet schedules auctions (AuctionPool
// scheduler), posts association roots, relays users' calls and submits the permissionless pin / settle / advanceTree.
// It owns nothing: the owner is a 48-hour timelock the Safe controls. Its sends go through the queue in sends.ts.
import { Contract, Interface, Wallet } from "ethers";
import { DEPLOYMENT, type Deployment } from "@/lib/luminary-config";
import { provider } from "../chain";
import { env } from "../env";

export const POOL_ABI = new Interface([
  "event Committed(uint256 indexed index, bytes32 commitment)",
  "event Deposited(address indexed from, address indexed asset, uint256 amount, bytes32 commitment, uint256 label)",
  "event TreeAdvanced(bytes32 root, uint256 size)",
  "event Transacted(bytes32 indexed nullifier0, bytes32 indexed nullifier1, address indexed asset, address to, uint256 released, address relayer, uint256 fee, bytes memo)",
  "event AuctionScheduled(uint256 indexed id, address indexed asset, address quote, uint8 kind, uint256 callTime, uint256 capBps)",
  "event OrderResting(uint256 indexed id, uint256 slot, bytes32 commitment, bytes sealedOrder)",
  "event OrderFeePaid(address indexed relayer, uint256 fee)",
  "event AuctionPinned(uint256 indexed id, uint256 callBlock, uint256 refUsd, uint256 quoteUsd)",
  "event AuctionSettled(uint256 indexed id, uint256 pStar, uint256 crossedQty, uint64 excluded, bytes notes)",
  "event AuctionVoided(uint256 indexed id)",
  "event OrderReclaimed(uint256 indexed id, uint256 slot, bytes32 commitment, bool cancelled)",
  "event Printed(uint256 indexed auctionId, address indexed asset, uint256 pStar, uint256 crossedQty, uint256 index)", // PrintRegistry
  "event Disclosed(bytes32 indexed auditor, address indexed from, bytes grant)", // DisclosureRegistry
  "event BlockOpened(uint256 indexed id, address indexed asset, address quote, uint256 callTime)", // RfqDesk
  "function commitmentCount() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function root() view returns (bytes32)",
  "function spent(bytes32) view returns (bool)",
  "function depositFee() view returns (uint256)",
  "function feeOwner() view returns (bytes32)",
  "function feeBps() view returns (uint16)",
  "function minLock(address) view returns (uint256)",
  "function excludedSlots(uint256) view returns (uint64)",
  "function SETTLE_DEADLINE() view returns (uint256)",
  "function markets(address) view returns (address feed, uint88 unit, bool listed, uint16 capBps, uint32 maxAge)",
  "function auctions(uint256 id) view returns ((address asset, uint64 callTime, uint8 kind, bool settled, bool voided, address quote, uint64 callBlock, uint16 capBps, uint16 feeBps, uint64 refUsd, uint64 quoteUsd, uint64 pinnedAt, uint16 live))",
  "function auctionCount() view returns (uint256)",
  "function orderList(uint256 id) view returns (bytes32[])",
  "function schedule(address asset, address quote, uint8 kind, uint64 callTime) returns (uint256)",
  "function pin(uint256 id)",
  "function abandon(uint256 id)",
  "function advanceTree(uint256 count, bytes32 newRoot, bytes proof)",
  "function settleAuction(uint256 id, (uint256 pStar, uint256 crossedQty, bytes32[64] fills, bytes32[64] residuals, bool[64] rolls, bytes32 feeNote, bool roll, uint64 excluded) c, uint256 rollInto, bytes proof, bytes notes)",
  "function transact((bytes32 root, bytes32 aspRoot, bytes32[2] nullifiers, bytes32[2] outputs, address asset, uint256 released, uint256 fee, address to, address relayer) t, bytes proof, bytes memo)",
  "function placeOrder(uint256 id, (bytes32 root, bytes32 nullifier, bytes32 feeNullifier, bytes32 change, bytes32 feeChange, bytes32 commitment, address relayer, uint256 fee, bytes32 aspRoot) p, bytes proof, bytes sealedOrder)",
  "function reclaim(uint256 id, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes proof)",
  "function ragequit((bytes32 root, bytes32 aspRoot, bytes32[2] nullifiers, bytes32[2] outputs, address asset, uint256 released, uint256 fee, address to, address relayer) t, uint256 nonce, bytes proof, bytes memo)",
]);

export const DESK_ABI = new Interface([
  "function open(address asset, address quote, uint256 delay) returns (uint256)",
  "function settle(uint256 id, bytes32[2] fills, bytes32[2] residuals, bytes32 feeNote, uint256 crossedQty, bytes proof, bytes notes)",
]);

export const GATE_ABI = new Interface([
  "function allowed(address) view returns (bool)",
  "function associationRequired() view returns (bool)",
  "function isAssociationRoot(bytes32) view returns (bool)",
  "function latestAssociationRoot() view returns (bytes32)",
  "function postAssociationRoot(bytes32 root)",
]);

export const FEED_ABI = new Interface(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

/** The deployment, or an error a worker step reports as waiting. */
export function deployment(): Deployment {
  if (!DEPLOYMENT) throw new Error("no deployment for chain 4663 (contracts/deployments/4663.json)");
  return DEPLOYMENT;
}

/** The AuctionPool address of the bundled deployment. */
export const poolAddress = () => deployment().AuctionPool;
/** A read-only AuctionPool contract on the chain provider. */
export const pool = () => new Contract(poolAddress(), POOL_ABI, provider());
/** A read-only ScreeningGate contract on the chain provider. */
export const gate = () => new Contract(deployment().ScreeningGate, GATE_ABI, provider());
/** The operator wallet (OPERATOR_PRIVATE_KEY): scheduler, root poster and relayer. */
export const operator = () => new Wallet(env("OPERATOR_PRIVATE_KEY"));
