// What an AuctionClearProof costs through bb.js (WASM), the prover the Vercel function would run, against native bb.
// bb.js hangs under Bun on Windows, so bundle and run with Node:
//   bun build src/shielded/prove.bench.ts --target=node --outfile=node_modules/.cache/bench/bench.mjs \
//     --external @aztec/bb.js --external @noir-lang/noir_js && node node_modules/.cache/bench/bench.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type InputMap } from "@noir-lang/noir_js";
import auctionClear from "./circuits/auction_clear.json";
import { ownerPub, PLAIN, ready } from "./protocol";
import { settleAuction, type OrderOpening } from "./settle";

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const v = await fn();
  console.log(`  ${label.padEnd(34)} ${String(Date.now() - t).padStart(7)} ms`);
  return v;
};
const toInput = (v: unknown): unknown =>
  typeof v === "bigint" ? "0x" + v.toString(16) : Array.isArray(v) ? v.map(toInput) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toInput(x)])) : v;

await ready();
const U = 1_000_000n;
const TSLA = 0xc9f9n;
const TQ = 0x7e7en;
// a full auction: 32 buys and 32 sells at scattered limits
const slots: OrderOpening[] = Array.from({ length: 64 }, (_, i) => {
  const buy = i % 2 === 0;
  const limitUsd = (240n + BigInt((i * 7) % 21)) * U;
  const qty = BigInt(1 + (i % 5)) * U;
  return { owner: ownerPub(BigInt(1000 + i)), salt: BigInt(5000 + i), buy, qty, hasLimit: i % 9 !== 0, limitUsd: i % 9 !== 0 ? limitUsd : 0n,
    lock: buy ? 2000n * U : qty, roll: i % 3 === 0, rollsLeft: i % 3 === 0 ? 5 : 0, label: BigInt(900 + i), terms: PLAIN, viewPub: "0x" };
});
const s = settleAuction({ asset: TSLA, unit: 10n ** 12n, quote: TQ, quoteUnit: 1n, refUsd: 250n * U, capBps: 500n, quoteUsd: U, feeBps: 5n, feeOwner: ownerPub(424242n) }, slots, 777n);
console.log(`64-order auction: p* ${s.onchain.pStar}, crossed ${s.onchain.crossedQty}`);
const circuit = auctionClear as never as { bytecode: string };
const witness = await ms("witness (noir_js)", async () => (await new Noir(auctionClear as never).execute(toInput(s.inputs) as InputMap)).witness);

for (const threads of [1, Math.min(cpus().length, 16)]) {
  console.log(`\n${threads} thread${threads > 1 ? "s" : ""}:`);
  const api = await Barretenberg.new({ threads });
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const { proof, publicInputs } = await ms("proof", () => backend.generateProof(witness, { verifierTarget: "evm" }));
  // saved for contracts/test/AuctionClearVerifier.t.sol: a bb.js proof must verify in the bb-generated Solidity verifier
  const dir = "circuits/target/fixtures/bbjs_settle";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/proof`, proof);
  writeFileSync(`${dir}/public_inputs`, Buffer.concat(publicInputs.map((x) => Buffer.from(x.replace(/^0x/, "").padStart(64, "0"), "hex"))));
  await api.destroy();
}
process.exit(0);
