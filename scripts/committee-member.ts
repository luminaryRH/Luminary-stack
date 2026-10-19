// A sealing-committee member: posts this member's partial decryptions (src/shielded/committee.ts) of the order
// ciphertexts of pinned auctions. A member trusts the operator for nothing: the app only proposes work, and before
// computing a partial the member checks on chain, through its own RPC, that the auction is pinned (and neither voided nor
// settled) and that the ciphertext is the one that auction's OrderResting event carries. Anything else is skipped, so an
// operator cannot get an order opened before its call. A rolled order rests without a ciphertext on chain, so members
// skip it; the settlement leaves it out and its owner reclaims the lock. Run one per member, on a host the operator does
// not control:
//   MEMBER=<index> KEY_SHARE=<0x… from the DKG> RPC_URL=<your own Robinhood Chain RPC> BASE_URL=https://luminariesrh.com \
//     bun scripts/committee-member.ts [--once]
import { Contract, JsonRpcProvider } from "ethers";
import { DEPLOYMENT } from "@/lib/luminary-config";
import { partialOf } from "@/shielded/committee";
import { operatorCiphertext } from "@/shielded/orders";

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

/** The operator ciphertexts auction `id` rests on chain, if it is pinned and still unsettled; null otherwise. */
async function onChainCiphertexts(pool: Contract, provider: JsonRpcProvider, id: number, fromBlock: number) {
  const a = await pool.getFunction("auctions")(id);
  if (a.callBlock === 0n || a.voided || a.settled) return null;
  const head = await provider.getBlockNumber();
  const filter = pool.filters["OrderResting"]!(id);
  const out = new Set<string>();
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    for (const log of await pool.queryFilter(filter, from, Math.min(head, from + LOG_CHUNK - 1))) {
      const sealed = operatorCiphertext(String((log as unknown as { args: unknown[] }).args[3]));
      if (sealed) out.add(sealed.toLowerCase());
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
  const pool = new Contract(poolAddress, POOL, provider);
  const verified = new Map<number, Set<string> | null>();
  const items: { sealed: string; partial: ReturnType<typeof partialOf> }[] = [];
  let skipped = 0;
  for (const x of body.data!.pending) {
    if (!Number.isSafeInteger(x.id) || typeof x.sealed !== "string") {
      skipped++;
      continue;
    }
    if (!verified.has(x.id)) verified.set(x.id, await onChainCiphertexts(pool, provider, x.id, m.fromBlock ?? DEPLOYMENT?.deployBlock ?? 0));
    if (!verified.get(x.id)?.has(x.sealed.toLowerCase())) {
      skipped++; // not pinned, already settled, or not this auction's ciphertext on chain
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
