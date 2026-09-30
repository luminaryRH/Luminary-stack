// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const ISOLATED = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };

export default defineConfig({
  nitro: {
    // The provers load WASM (and bb.js worker threads) from files next to their modules, so they ship as traced
    // node_modules in the server function instead of being bundled; scripts/ship-provers.mjs copies in the files bb.js
    // loads by path. postgres.js is traced too: bundled, its type parsers break. (traceDeps is forwarded to nitro but
    // missing from the wrapper's narrow option type.)
    traceDeps: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi", "postgres"],
    // The tick can prove a tree batch and an auction in one run (~30 s each on one thread); 300 s is the Hobby maximum.
    vercel: { functions: { maxDuration: 300 } },
    // Cross-origin isolation, so bb.js can prove with threads (SharedArrayBuffer) in the browser. Only the dashboard
    // (every link to it is a full page load): elsewhere it would block the Sketchfab hero viewer. nitro's own /assets
    // rule ends routing there, so it carries the headers too (the proving worker needs COEP on its own script).
    routeRules: {
      "/dashboard": { headers: ISOLATED },
      "/dashboard/**": { headers: ISOLATED },
      "/assets/**": { headers: { ...ISOLATED, "cache-control": "public, max-age=31536000, immutable" } },
    },
  } as { preset?: string },
  // noir's WASM packages must not be pre-bundled in dev (their init fetches the .wasm next to the module). ES worker
  // output so the proving worker (src/shielded/prove.worker.ts) can code-split its WASM.
  vite: { optimizeDeps: { exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] }, worker: { format: "es" } },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
