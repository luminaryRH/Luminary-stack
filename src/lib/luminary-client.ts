// The dashboard's public data (auctions, prints, marks) from our API, and the injected wallet. The account itself
// (notes, orders, proofs) is src/shielded/client.ts.
import type { Eth } from "@/shielded/client";

export interface LiveAuction {
  key: string;
  symbol: string;
  kind: "OPEN" | "CLOSE" | "MIDNIGHT" | "NAV" | "RFQ";
  callTime: string; // ISO
  id: number | null; // AuctionPool id once on chain
  status: "scheduled" | "collecting" | "pinned" | "cleared" | "void";
  refUsd: string | null; // micro-USD
  pStar: string | null;
  crossedQty: string | null; // micro-tokens
  proofTx: string | null;
}

export interface LivePrint {
  auctionId: number;
  symbol: string;
  pStar: string; // micro-USD
  crossedQty: string; // micro-tokens
  block: number;
  tx: string;
  at: string;
  kind: LiveAuction["kind"] | null;
  refUsd: string | null;
}

export interface Marks {
  prices: Record<string, { usd: string; at: string; source: string }>;
  nav: { nav: string; at: string } | null; // micro-USDG per TQ share
  navHistory: { at: string; nav: string }[];
}

export interface Live {
  auctions: LiveAuction[];
  prints: LivePrint[];
  marks: Marks | null;
}

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json().catch(() => null)) as { ok: boolean; data: T; error?: string } | null;
  if (!body?.ok) throw Error(body?.error || `Request failed (${res.status})`);
  return body.data;
}

export async function loadLive(): Promise<Live> {
  const [a, p, marks] = await Promise.all([
    api<{ auctions: LiveAuction[] }>("/api/auctions"),
    api<{ prints: LivePrint[] }>("/api/prints?limit=200"),
    api<Marks>("/api/marks").catch(() => null),
  ]);
  return { auctions: a.auctions, prints: p.prints, marks };
}

/** micro-units (decimal string) → number */
export const micro = (v: string | null | undefined) => (v ? Number(v) / 1e6 : 0);

/** The browser wallet (EIP-1193), or null when none is installed. */
export const injectedWallet = (): Eth | null => (typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eth }).ethereum ?? null));
