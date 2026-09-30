// Post-build: bb.js loads its WASM (barretenberg-threads.wasm.gz) and worker scripts by file path, which nitro's
// dependency trace does not follow. Copy bb.js's Node build next to the traced package in the server output (the Vercel
// function, or .output/server for a local node-server build).
import { cpSync, existsSync } from "node:fs";

let shipped = 0;
for (const fn of [".vercel/output/functions/__server.func", ".output/server"]) {
  if (!existsSync(`${fn}/node_modules/@aztec/bb.js`)) continue;
  const target = `${fn}/node_modules/@aztec/bb.js/dest/node`;
  cpSync("node_modules/@aztec/bb.js/dest/node", target, { recursive: true });
  const wasm = `${target}/barretenberg_wasm/barretenberg-threads.wasm.gz`;
  if (!existsSync(wasm)) throw new Error(`ship-provers: ${wasm} missing after copy`);
  shipped++;
  console.log(`ship-provers: bb.js WASM and workers copied into ${fn}`);
}
if (!shipped) console.log("ship-provers: no traced bb.js in a server output, nothing to do");
