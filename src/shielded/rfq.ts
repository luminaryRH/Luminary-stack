// Sealed RFQ intents: two counterparties negotiate a block with messages sealed to each other's session keys through
// /api/rfq. When they agree, one opens an RFQ auction on RfqDesk and both place orders into it carrying the same rfq
// commitment; the desk crosses them whole at the pinned reference (circuits/rfq_cross) or refunds both. Session keys
// are fresh per negotiation, not wallet keys.
import { AbiCoder, SigningKey, hexlify, keccak256, randomBytes } from "ethers";
import { open, seal } from "./crypto";
import { H } from "./protocol";

export interface RfqSession {
  priv: string;
  pub: string; // compressed; share it with the counterparty out of band or in the first message
}

/** What a party proposes or accepts. Quantities in token micro-units; the price is always the auction's reference. */
export interface RfqIntent {
  kind: "request" | "quote" | "accept" | "decline";
  asset: string; // token address
  side: "buy" | "sell"; // the sender's side
  qty: string;
  limitUsd?: string; // micro-USD per token the sender will not trade beyond
  auctionId?: number; // the RFQ auction both orders go into
  nonce: string; // the requester's, echoed by replies; binds the rfq commitment
}

/** A fresh RFQ session key pair. */
export const newSession = (): RfqSession => {
  const key = new SigningKey(hexlify(randomBytes(32)));
  return { priv: key.privateKey, pub: key.compressedPublicKey };
};

/** The mailbox inbox of a session public key. */
export const inboxOf = (pub: string) => keccak256(pub);

/** The commitment both agreed orders carry: asset, block size, buyer and seller session keys, nonce. */
export function rfqCommitment(i: { asset: bigint; qty: bigint; buyerPub: string; sellerPub: string; nonce: bigint }) {
  const key = (pub: string) => BigInt(keccak256(pub)) >> 8n; // 248 bits: below the field modulus
  return H(9n, i.asset, i.qty, key(i.buyerPub), key(i.sellerPub), i.nonce);
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => null)) as { ok: boolean; data: T; error?: string } | null;
  if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
  return body.data;
}

/** What the sender signs so the mailbox knows the message really comes from `from` (src/routes/api/rfq.ts checks it). */
export const postDigest = (to: string, ciphertext: string, ttlSeconds: number, ts: number) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes", "uint256", "uint256"], ["luminary-rfq-v1", to, ciphertext, ttlSeconds, ts]));

/** Seals `intent` to the counterparty's session key, signs it with this session's key, and posts it. */
export async function sendIntent(me: RfqSession, toPub: string, intent: RfqIntent, ttlSeconds = 3600, base = "") {
  const ciphertext = await seal(toPub, JSON.stringify(intent));
  const to = inboxOf(toPub);
  const ts = Math.floor(Date.now() / 1000);
  const sig = new SigningKey(me.priv).sign(postDigest(to, ciphertext, ttlSeconds, ts)).serialized;
  return call<{ id: number }>(base, "/api/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, from: me.pub, ciphertext, ttlSeconds, ts, sig }),
  });
}

/** Opens this session's messages after `after`; messages that do not open (not for this key) are skipped. */
export async function readIntents(me: RfqSession, after = 0, base = "") {
  const { messages } = await call<{ messages: { id: number; from: string; ciphertext: string; expiresAt: string }[] }>(base, `/api/rfq?to=${inboxOf(me.pub)}&after=${after}`);
  const out: { id: number; from: string; intent: RfqIntent }[] = [];
  for (const m of messages) {
    const text = await open(me.priv, m.ciphertext);
    if (!text) continue;
    try {
      out.push({ id: m.id, from: m.from, intent: JSON.parse(text) as RfqIntent });
    } catch {
      // not an intent
    }
  }
  return out;
}
