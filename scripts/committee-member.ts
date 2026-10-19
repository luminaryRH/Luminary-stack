// A sealing-committee member: posts this member's partial decryptions (src/shielded/committee.ts) of the order
// ciphertexts of pinned auctions. A member trusts the operator for nothing: the app only proposes work, and before
// computing a partial the member checks on chain, through its own RPC, that the auction is pinned (and neither voided nor
// settled), that the ciphertext is the one an order in that auction rests with, and that the order's envelope proves
// knowledge of the ciphertext's ephemeral key, bound to this chain, pool, auction and commitment. A partial depends only
// on that key, so without the proof a copy of someone's ciphertext (or a related key such as k·R) placed in an auction
// that pins earlier would open the original; with it, only the sealer's own order can be served. A rolled order rests
// without a ciphertext on chain, so members skip it; the settlement leaves it out and its owner reclaims the lock.
// Run one per member, on a host the operator does not control:
//   MEMBER=<index> KEY_SHARE=<0x… from the DKG> RPC_URL=<your own Robinhood Chain RPC> BASE_URL=https://luminariesrh.com \
//     bun scripts/committee-member.ts [--once]
import { Contract, JsonRpcProvider } from "ethers";
import { DEPLOYMENT } from "@/lib/luminary-config";
import { orderKeyContext, partialOf, verifyEphemeral, type KeyProof } from "@/shielded/committee";
import { operatorCiphertext, operatorKeyProof } from "@/shielded/orders";

export interface Member {
  member: number; // 1..n
  keyShare: string; // this member's DKG key share (0x hex)
  base: string; // the app, e.g. https://luminariesrh.com ("" for same-origin fetch)
  rpcUrl: string; // the member's own RPC, so the chain check does not depend on the operator
  pool?: string; // AuctionPool (default: the bundled deployment)
  fromBlock?: number; // where to look for OrderResting events (default: the deployment block)
}

const POOL = [
  "event OrderResting(uint256 indexed id, uint256 slot, bytes32 commitment, bytes sealedOrder)",
  "function auctions(uint256 id) view returns ((address asset, uint64 callTime, uint8 kind, bool settled, bool voided, address quote, uint64 callBlock, uint16 capBps, uint16 feeBps, uint64 refUsd, uint64 quoteUsd, uint64 pinnedAt, uint16 live))",
];
const LOG_CHUNK = 5_000_000; // public RPCs cap a log query's block range
const POLL_MS = 15_000;

type Resting = Map<string, { commitment: string; proof: KeyProof | null }>; // operator ciphertext → its order

/** The orders auction `id` rests on chain (by operator ciphertext), if it is pinned and unsettled; null otherwise. */
async function restingIn(pool: Contract, provider: JsonRpcProvider, id: number, fromBlock: number): Promise<Resting | null> {
  const a = await pool.getFunction("auctions")(id);
  if (a.callBlock === 0n || a.voided || a.settled) return null;
  const head = await provider.getBlockNumber();
  const out: Resting = new Map();
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    for (const log of await pool.queryFilter(pool.filters["OrderResting"]!(id), from, Math.min(head, from + LOG_CHUNK - 1))) {
      const args = (log as unknown as { args: unknown[] }).args;
      const envelope = String(args[3]);
      const sealed = operatorCiphertext(envelope);
      if (sealed) out.set(sealed.toLowerCase(), { commitment: String(args[2]).toLowerCase(), proof: operatorKeyProof(envelope) });
    }
  }
  return out;
}

/** One round: every proposed ciphertext that checks out on chain gets this member's partial. Returns how many the app
 * accepted and how many were skipped. */
export async function round(m: Member, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const res = await fetchImpl(`${m.base}/api/pool/partials`);
  const body = (await res.json()) as { ok: boolean; data?: { pending: { id: number; sealed: string }[] }; error?: string };
  if (!body.ok) throw new Error(body.error ?? `GET ${res.status}`);
  const poolAddress = m.pool ?? DEPLOYMENT?.AuctionPool;
  if (!poolAddress) throw new Error("no AuctionPool address");
  const provider = new JsonRpcProvider(m.rpcUrl, undefined, { staticNetwork: true });
  const chainId = (await provider.getNetwork()).chainId;
  const pool = new Contract(poolAddress, POOL, provider);
  const resting = new Map<number, Resting | null>();
  const items: { sealed: string; partial: ReturnType<typeof partialOf> }[] = [];
  let skipped = 0;
  for (const x of body.data!.pending) {
    if (!Number.isSafeInteger(x.id) || typeof x.sealed !== "string") {
      skipped++;
      continue;
    }
    if (!resting.has(x.id)) resting.set(x.id, await restingIn(pool, provider, x.id, m.fromBlock ?? DEPLOYMENT?.deployBlock ?? 0));
    const order = resting.get(x.id)?.get(x.sealed.toLowerCase());
    if (!order || !verifyEphemeral(x.sealed, order.proof, orderKeyContext(chainId, poolAddress, x.id, order.commitment))) {
      skipped++; // not pinned, settled, not on chain in this auction, or no proof of the key for this order
      continue;
    }
    items.push({ sealed: x.sealed, partial: partialOf(m.member, m.keyShare, x.sealed) });
  }
  if (items.length === 0) return { accepted: 0, skipped };
  const post = await fetchImpl(`${m.base}/api/pool/partials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const r = (await post.json()) as { ok: boolean; data?: { accepted: number; rejected: number }; error?: string };
  if (!r.ok) throw new Error(r.error ?? `POST ${post.status}`);
  return { accepted: r.data!.accepted, skipped };
}

if (import.meta.main) {
  const m: Member = {
    member: Number(process.env["MEMBER"]),
    keyShare: process.env["KEY_SHARE"]?.trim() ?? "",
    base: (process.env["BASE_URL"] ?? "https://luminariesrh.com").replace(/\/$/, ""),
    rpcUrl: process.env["RPC_URL"]?.trim() ?? "",
  };
  if (!Number.isInteger(m.member) || m.member < 1 || !m.keyShare || !m.rpcUrl) throw new Error("set MEMBER (1..n), KEY_SHARE and RPC_URL");
  const once = process.argv.includes("--once");
  do {
    await round(m).then(
      (r) => (r.accepted || r.skipped) && console.log(new Date().toISOString(), `${r.accepted} partial(s) accepted, ${r.skipped} skipped`),
      (e) => console.error(new Date().toISOString(), String((e as Error)?.message ?? e)),
    );
    if (!once) await Bun.sleep(POLL_MS);
  } while (!once);
}
