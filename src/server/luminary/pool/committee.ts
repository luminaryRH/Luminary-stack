// Sealing committee, operator side. On testnet the operator is a 1-of-1 committee: orders are sealed to SEAL_PUBLIC and
// opened with SEAL_KEY. With COMMITTEE set (the Feldman DKG output, src/shielded/committee.ts), orders are sealed to the
// committee's group key instead and the operator can open a pinned auction's orders only from members' partial
// decryptions, which members release once the auction is pinned on chain.
import { keccak256 } from "ethers";
import { openWithPartials, verifyPartial, type Committee, type Partial } from "@/shielded/committee";
import { open } from "@/shielded/crypto";
import { operatorCiphertext } from "@/shielded/orders";
import { rpc } from "../db";
import { env } from "../env";

export function committee(): Committee | null {
  const raw = process.env["COMMITTEE"]?.trim();
  return raw ? (JSON.parse(raw) as Committee) : null;
}

/** The key orders and rolled openings are sealed to: the committee's group key, or the operator's sealing key. */
export const sealingPublicKey = () => committee()?.groupKey ?? env("SEAL_PUBLIC");

const hashOf = (sealed: string) => keccak256(sealed).toLowerCase();

export interface OpenAuction {
  id: number;
  asset: string;
  quote: string;
  kind: number; // AuctionPool.Kind
  callTime: number;
  pinned: boolean;
  pin: { callBlock: string; refUsd: string; quoteUsd: string } | null;
  orders: { slot: number; commitment: string; sealed: string }[];
}

/** An order's ciphertext to the sealing key: from its placement, or the stored copy for a rolled order ("0x"). */
export async function orderCiphertexts(a: OpenAuction) {
  const rolled = await rpc<Record<string, string>>("lum_pool_openings", {
    p_commitments: a.orders.filter((o) => o.sealed === "0x").map((o) => o.commitment),
  });
  return a.orders.map((o) => ({ ...o, ciphertext: o.sealed === "0x" ? (rolled[o.commitment.toLowerCase()] ?? null) : operatorCiphertext(o.sealed) }));
}

/** Every order ciphertext of pinned, unsettled auctions that the committee has not yet opened. */
export async function pendingForCommittee() {
  const c = committee();
  if (!c) return [];
  const auctions = (await rpc<OpenAuction[]>("lum_pool_open_auctions", {})).filter((a) => a.pinned);
  const items = (await Promise.all(auctions.map(async (a) => (await orderCiphertexts(a)).map((o) => ({ id: a.id, commitment: o.commitment, sealed: o.ciphertext })))))
    .flat()
    .filter((x): x is { id: number; commitment: string; sealed: string } => x.sealed !== null);
  const partials = await rpc<Record<string, Partial[]>>("lum_pool_partials_for", { p_hashes: items.map((x) => hashOf(x.sealed)) });
  return items.filter((x) => (partials[hashOf(x.sealed)]?.length ?? 0) < c.threshold);
}

/** Stores the valid partials a member posts; invalid ones are dropped and counted. */
export async function acceptPartials(items: { sealed: string; partial: Partial }[]) {
  const c = committee();
  if (!c) return { accepted: 0, rejected: items.length };
  const valid = items.filter((x) => typeof x.sealed === "string" && verifyPartial(c, x.sealed, x.partial));
  const stored = valid.length
    ? await rpc<number>("lum_pool_put_partials", { p_rows: valid.map((x) => ({ sealed_hash: hashOf(x.sealed), member: x.partial.member, partial: x.partial })) })
    : 0;
  return { accepted: stored, rejected: items.length - valid.length };
}

/** Opens an order ciphertext: from the committee's partials when there is a committee, else with the operator key. */
export async function openOrder(sealed: string): Promise<string | null> {
  const c = committee();
  if (!c) return open(env("SEAL_KEY"), sealed);
  const partials = await rpc<Record<string, Partial[]>>("lum_pool_partials_for", { p_hashes: [hashOf(sealed)] });
  return openWithPartials(c, sealed, partials[hashOf(sealed)] ?? []);
}
