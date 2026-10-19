// bun src/shielded/committee.check.ts
// An order's proof of its ephemeral key verifies only for that order: not in another auction, pool, chain or commitment,
// not for a negated or multiplied key (whose partials would open the original), and not when tampered with.
import { SigningKey, concat, getBytes, hexlify } from "ethers";
import { committeeOf, deal, keyShareOf, openWithPartials, orderKeyContext, partialOf, proveEphemeral, verifyEphemeral } from "./committee";
import { sealKeyed } from "./crypto";

const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(`committee.check: ${msg}`);
};
const POOL = "0x" + "11".repeat(20);
const C1 = "0x" + "aa".repeat(32);
const members = [1, 2, 3];
const dealings = members.map((m) => deal(m, 2, members));
const c = committeeOf(2, members, dealings);

const { sealed, ephemeral } = await sealKeyed(c.groupKey, "an order");
const ctx = orderKeyContext(4663, POOL, 7, C1);
const proof = proveEphemeral(ephemeral, ctx);
assert(verifyEphemeral(sealed, proof, ctx), "the sealer's proof verifies");
assert(!verifyEphemeral(sealed, proof, orderKeyContext(4663, POOL, 6, C1)), "a copy in another auction");
assert(!verifyEphemeral(sealed, proof, orderKeyContext(4663, POOL, 7, "0x" + "bb".repeat(32))), "another commitment");
assert(!verifyEphemeral(sealed, proof, orderKeyContext(46630, POOL, 7, C1)), "another chain");
assert(!verifyEphemeral(sealed, proof, orderKeyContext(4663, "0x" + "22".repeat(20), 7, C1)), "another pool");
assert(!verifyEphemeral(sealed, null, ctx) && !verifyEphemeral(sealed, { c: "0x1", z: "0x1" }, ctx), "no or junk proof");
assert(!verifyEphemeral(sealed, { ...proof, z: "0x" + (BigInt(proof.z) + 1n).toString(16) }, ctx), "a tampered proof");

// related keys: −R (the other parity byte) and 2·R; a partial for either would open the original
const bytes = getBytes(sealed);
const negated = hexlify(concat([new Uint8Array([bytes[0] === 2 ? 3 : 2]), bytes.slice(1)]));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const doubled = hexlify(concat([new SigningKey("0x" + ((BigInt(ephemeral) * 2n) % N).toString(16).padStart(64, "0")).compressedPublicKey, bytes.slice(33)]));
assert(!verifyEphemeral(negated, proof, ctx) && !verifyEphemeral(doubled, proof, ctx), "a related key reuses the proof");
assert(!verifyEphemeral("0x" + "ff".repeat(80), proof, ctx), "not a curve point");

// and the order still opens from two members' partials
const partials = [1, 3].map((m) => partialOf(m, keyShareOf(m, dealings), sealed));
assert((await openWithPartials(c, sealed, partials)) === "an order", "two partials open the order");
console.log("committee.check: ok");
