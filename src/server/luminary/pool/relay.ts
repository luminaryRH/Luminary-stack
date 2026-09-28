// Relayer: submits users' shielded transactions and orders from the operator wallet, so neither a withdrawal's recipient
// nor an order is linked to the wallet that deposited. Every proof binds its relayer and fee, so the relayer can only
// forward it. Fees are ETH: transactions of ETH notes, and orders (fee from a separate ETH note).
import { Interface, ZeroAddress, getAddress, isHexString } from "ethers";
import { provider } from "../chain";
import { rpc } from "../db";
import { UserError } from "../http";
import { operator } from "./contract";
import { sendPool } from "./sends";

// Gas each relayed call uses, Orbit L1 data included (measured on the forge flow: placeOrder ~3.8M, transact ~3.7M).
const RELAY_GAS = { transact: 4_000_000n, order: 4_200_000n } as const;
export type RelayKind = keyof typeof RELAY_GAS;

/** Minimum relayer fee in wei: the call's gas at the current base fee (what the chain charges) + 0.01 gwei, plus 30%. */
export async function relayQuote(kind: RelayKind) {
  const base = (await provider().getBlock("latest"))!.baseFeePerGas ?? 0n;
  return (RELAY_GAS[kind] * (base + 10_000_000n) * 13n) / 10n;
}

const bytes32 = (v: unknown, name: string) => {
  if (!isHexString(v, 32)) throw new UserError(`${name} must be 32 bytes of hex`);
  return (v as string).toLowerCase();
};
const uint = (v: unknown, name: string) => {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new UserError(`${name} must be a decimal string`);
  return BigInt(v);
};
const address = (v: unknown, name: string) => {
  try {
    return getAddress(String(v));
  } catch {
    throw new UserError(`${name} must be an address`);
  }
};
const hexBytes = (v: unknown, name: string, max: number) => {
  if (!isHexString(v) || (v as string).length > 2 + 2 * max) throw new UserError(`${name} must be hex, at most ${max} bytes`);
  return v as string;
};

// The custom errors a relayed transact / placeOrder can revert with: AuctionPool's and the bb-generated verifiers'.
const REVERTS = new Interface(
  [
    ...["BadFee", "BadAmount", "BadCount", "BadAuction", "ZeroAddress", "NotInField", "InvalidProof", "UnknownRoot", "NoteSpent", "TreeFull"],
    ...["AuctionFull", "NotCollecting", "UnknownAssociationRoot", "AssociationRequired", "TransferFailed", "Reentrancy"],
    ...["ConsistencyCheckFailed", "GeminiChallengeInSubgroup", "InvertOfZero", "ModExpFailed", "NotPowerOfTwo", "PointAtInfinity", "ProofLengthWrong"],
    ...["PublicInputsLengthWrong", "ShpleminiFailed", "SumcheckFailed", "ValueGeFieldOrder", "ValueGeGroupOrder", "ValueGeLimbMax"],
  ]
    .map((name) => `error ${name}()`)
    .concat("error ProofLengthWrongWithLogN(uint256 logN, uint256 actualLength, uint256 expectedLength)"),
);

/** Revert data from an ethers call error, wherever the provider put it. */
const revertData = (e: unknown) => {
  const x = e as { data?: unknown; error?: { data?: unknown }; info?: { error?: { data?: unknown } } } | null;
  return [x?.data, x?.error?.data, x?.info?.error?.data].find((d): d is string => typeof d === "string" && /^0x[0-9a-f]{8}/i.test(d)) ?? null;
};

/** A pool revert as a sentence the user can act on; null when the failure is not a revert (network, gas). */
export function rejection(e: unknown): UserError | null {
  const data = revertData(e);
  if (!data) return null;
  let name: string | undefined;
  try {
    name = REVERTS.parseError(data)?.name;
  } catch {
    // malformed arguments: treat as unknown
  }
  switch (name) {
    case "NoteSpent":
      return new UserError("One of these notes was already spent. Your balance is refreshing; try again in a minute.");
    case "UnknownRoot":
      return new UserError("The pool has not added these notes to its tree yet. Try again in about a minute.");
    case "AuctionFull":
      return new UserError("This market already holds the most open orders one auction can clear. Try the next auction.");
    case "NotCollecting":
      return new UserError("This auction is no longer taking orders. Choose the next one.");
    case "BadAuction":
      return new UserError("This auction does not exist or cannot take this order.");
    case "UnknownAssociationRoot":
    case "AssociationRequired":
      return new UserError("The pool needs a current association set for this withdrawal. Refresh the page and try again.");
    case "BadFee":
      return new UserError("The relayer fee in this order does not match what the pool expects. Refresh the page and try again.");
    case "TreeFull":
      return new UserError("The pool's note tree is full, so it cannot create new notes.");
    case "TransferFailed":
      return new UserError("The pool could not complete the payout. Try again later.");
    case "Reentrancy":
      return new UserError("The pool was busy with another transaction. Try again.");
    case "BadAmount":
    case "BadCount":
    case "ZeroAddress":
      return new UserError("The pool refused this request's amounts or addresses. Refresh the page and try again.");
    case undefined:
      console.error("unrecognised pool revert", data.slice(0, 10));
      return new UserError("The pool rejected this request. Refresh the page and try again.");
    default: // NotInField, InvalidProof and every verifier error
      return new UserError("The proof did not verify. Refresh the page and try again.");
  }
}

/** The node refused the relayer's send because the operator wallet cannot cover its gas. */
export const outOfGas = (e: unknown) =>
  (e as { code?: string } | null)?.code === "INSUFFICIENT_FUNDS" ||
  /insufficient funds/i.test(String((e as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (e as Error)?.message ?? e));

async function checkFee(kind: RelayKind, relayer: string, fee: bigint) {
  if (relayer !== operator().address) throw new UserError(`relayer must be ${operator().address}`);
  const quote = await relayQuote(kind);
  if (fee * 5n < quote * 4n) throw new UserError(`relayer fee below ${quote} wei`);
}

/** The browser's random id for one relayed call. */
const clientId = (v: unknown) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) throw new UserError("id must be 32 lowercase hex characters");
  return v;
};

interface RelayRow {
  tx: string | null;
  status: "submitting" | "sent" | "mined" | "reverted" | "replaced" | "unknown";
  age_sec: number;
  hashes: string[];
  filler: boolean;
}

/** GET /api/relay?id=: what became of a relayed call, for a browser whose reply never came. */
export async function relayStatus(idParam: unknown) {
  const id = clientId(idParam);
  if (!id) throw new UserError("id required");
  const r = await rpc<RelayRow | null>("lum_relay_status", { p_client_id: id });
  if (!r) return { status: "none", tx: null };
  if (r.status === "submitting") return { status: r.age_sec > 300 ? "unknown" : "submitting", tx: null };
  for (const hash of [...r.hashes].reverse()) {
    const receipt = await provider().getTransactionReceipt(hash);
    if (!receipt) continue;
    const status = r.filler && receipt.hash === r.hashes.at(-1) ? "replaced" : receipt.status === 1 ? "mined" : "reverted";
    return { status, tx: receipt.hash };
  }
  return { status: r.status, tx: r.hashes.at(-1) ?? r.tx };
}

async function submit(kind: RelayKind, fee: bigint, fn: string, args: unknown[], id: string | null) {
  if (id) {
    // two requests with one id race here; the loser gets the winner's tx, or null while the winner is still sending
    const claim = await rpc<{ claimed: boolean; tx?: string | null }>("lum_relay_claim", { p_client_id: id, p_kind: kind, p_fee: String(fee) });
    if (!claim.claimed) return { tx: claim.tx ?? null };
  }
  // nothing reached the chain on any path that throws below, so the id is freed for an honest retry
  const release = () => (id ? rpc("lum_relay_release", { p_client_id: id }).catch((e) => console.error("relay release failed", String(e))) : null);
  let tx: string | null;
  try {
    tx = await sendPool(fn, args);
  } catch (e) {
    await release();
    if (outOfGas(e)) {
      console.error("relayer out of gas", operator().address);
      throw new UserError("The relayer is temporarily out of gas, so nothing was sent and your notes are untouched. Try again later, or submit from your wallet.");
    }
    const rejected = rejection(e);
    if (rejected) throw rejected;
    const reason = (e as { shortMessage?: string; message?: string }).shortMessage ?? String(e);
    throw new UserError(`the pool rejects this ${fn === "transact" ? "transaction" : "order"}: ${reason.slice(0, 160)}`);
  }
  if (!tx) {
    await release();
    throw new UserError("the relayer has too many transactions in flight; try again in a minute");
  }
  if (id) await rpc("lum_relay_sent", { p_client_id: id, p_tx: tx }).catch((e) => console.error("relay record failed", String(e)));
  return { tx };
}

/**
 * POST { kind: "transact", transaction, proof, memo, id? } | { kind: "order", auctionId, placement, proof, sealedOrder, id? }
 * → { tx }. With an id seen before, nothing is sent again: tx is the first call's hash, or null while it is being sent.
 */
export async function relay(body: Record<string, unknown>) {
  const proof = body["proof"];
  if (!isHexString(proof) || (proof as string).length < 1000) throw new UserError("proof must be hex");
  const id = clientId(body["id"]);
  if (id) {
    const prior = await rpc<RelayRow | null>("lum_relay_status", { p_client_id: id });
    if (prior) return { tx: prior.tx };
  }

  if (body["kind"] === "transact") {
    const t = (body["transaction"] ?? {}) as Record<string, unknown>;
    const pair = (v: unknown, name: string) => {
      if (!Array.isArray(v) || v.length !== 2) throw new UserError(`${name} must be two values`);
      return [bytes32(v[0], name), bytes32(v[1], name)];
    };
    const transaction = {
      root: bytes32(t["root"], "root"),
      aspRoot: bytes32(t["aspRoot"], "aspRoot"),
      nullifiers: pair(t["nullifiers"], "nullifiers"),
      outputs: pair(t["outputs"], "outputs"),
      asset: address(t["asset"], "asset"),
      released: uint(t["released"], "released"),
      fee: uint(t["fee"], "fee"),
      to: address(t["to"], "to"),
      relayer: address(t["relayer"], "relayer"),
    };
    if (transaction.asset !== ZeroAddress) throw new UserError("the relayer takes ETH transactions only (its fee is paid in the note's asset)");
    await checkFee("transact", transaction.relayer, transaction.fee);
    return submit("transact", transaction.fee, "transact", [Object.values(transaction), proof, hexBytes(body["memo"] ?? "0x", "memo", 8_192)], id);
  }

  if (body["kind"] === "order") {
    const p = (body["placement"] ?? {}) as Record<string, unknown>;
    const placement = {
      root: bytes32(p["root"], "root"),
      nullifier: bytes32(p["nullifier"], "nullifier"),
      feeNullifier: bytes32(p["feeNullifier"], "feeNullifier"),
      change: bytes32(p["change"], "change"),
      feeChange: bytes32(p["feeChange"], "feeChange"),
      commitment: bytes32(p["commitment"], "commitment"),
      relayer: address(p["relayer"], "relayer"),
      fee: uint(p["fee"], "fee"),
    };
    await checkFee("order", placement.relayer, placement.fee);
    const auctionId = uint(String(body["auctionId"] ?? ""), "auctionId");
    return submit("order", placement.fee, "placeOrder", [auctionId, Object.values(placement), proof, hexBytes(body["sealedOrder"], "sealedOrder", 16_384)], id);
  }

  throw new UserError('kind must be "transact" or "order"');
}
