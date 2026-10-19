// A local Luminary for the end-to-end test: anvil (chain 4663) with the contracts deployed behind a verifier that
// accepts every proof, the Supabase schema in PGlite behind a fake `postgres` driver, and the API routes answering the
// client's fetch() in-process. Proving runs prove.ts for real up to the witness (so every circuit's constraints are
// checked on the inputs the app builds); only bb.js's proof itself is faked. The real proofs are checked in forge
// (contracts/test, bbjs fixtures) and nargo.
import { PGlite } from "@electric-sql/pglite";
import { mock } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ContractFactory, HDNodeWallet, JsonRpcProvider, NonceManager, Wallet, getBytes, type Contract } from "ethers";
import * as bb from "@aztec/bb.js";
import * as realConfig from "@/lib/luminary-config";
import type { Deployment } from "@/lib/luminary-config";

const ROOT = join(import.meta.dir, "..");
// anvil's default accounts (its public test mnemonic): 0 operator, 1 buyer, 2 seller
export const account = (i: number) => HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`);

/** A foundry binary: ~/.foundry/bin when installed there, else from PATH. */
function foundry(tool: "anvil" | "forge") {
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? `${tool}.exe` : tool);
  return existsSync(local) ? local : tool;
}

function artifact(file: string, name: string) {
  const a = JSON.parse(readFileSync(join(ROOT, "contracts", "out", file, `${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object as string };
}

/** The app's database: every migration applied to an in-memory PGlite. */
async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;`);
  const dir = join(ROOT, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  return db;
}

/** postgres.js, as much of it as db.ts uses: tagged queries, unsafe(text, params), end(). */
function fakePostgres(db: PGlite) {
  return () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      db.query<Record<string, unknown>>(strings.reduce((text, s, i) => `${text}$${i}${s}`), values).then((r) => r.rows);
    sql.unsafe = (text: string, params: unknown[] = []) => db.query<Record<string, unknown>>(text, params).then((r) => r.rows);
    sql.end = async () => {};
    return sql;
  };
}

export interface Local {
  url: string;
  chain: JsonRpcProvider;
  operator: Wallet; // deploys only: the app sends from the same key through its queue
  deployment: Deployment;
  db: PGlite;
  webhook: string[];
  relayed: Record<string, unknown>[]; // every body the client POSTed to /api/pool/relay
  sanctioned: Set<string>; // lower-case addresses the fake Chainalysis API identifies
  stop(): void;
}

/** Starts anvil, deploys, and installs the module fakes. Import app modules only after this resolves. */
export async function startLocal(): Promise<Local> {
  const build = spawnSync(foundry("forge"), ["build"], { cwd: join(ROOT, "contracts"), encoding: "utf8" });
  if (build.status !== 0) throw Error(`forge build failed: ${build.stderr}`);

  const port = 18_545 + Math.floor(Math.random() * 1000);
  const anvil: ChildProcess = spawn(foundry("anvil"), ["--port", String(port), "--chain-id", "4663", "--silent", "--code-size-limit", "100000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const chain = new JsonRpcProvider(url, 4663, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  for (let i = 0; ; i++) {
    if (await chain.getBlockNumber().then(() => true, () => false)) break;
    if (i > 100) throw Error("anvil did not start");
    await Bun.sleep(100);
  }

  const op = new Wallet(account(0).privateKey, chain);
  const opAddress = await op.getAddress();
  const deploy = async (file: string, name: string, ...args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const c = await new ContractFactory(abi, bytecode, op).deploy(...args);
    await c.waitForDeployment();
    return c as Contract;
  };
  const send = async (c: Contract, fn: string, ...args: unknown[]) => (await c.getFunction(fn)(...args)).wait();

  const { ownerPub, ready } = await import("@/shielded/protocol");
  await ready();
  const feeSecret = 0x5eed_f00dn;
  const deployBlock = await chain.getBlockNumber();

  const accept = await deploy("Halmos.t.sol", "AcceptAll");
  const v = await accept.getAddress();
  const prints = await deploy("PrintRegistry.sol", "PrintRegistry");
  const pool = await deploy("AuctionPool.sol", "AuctionPool", opAddress, [v, v, v, v, v, v], await prints.getAddress(), "0x" + ownerPub(feeSecret).toString(16).padStart(64, "0"), 5);
  const poolAddress = await pool.getAddress();
  await send(prints, "setWriter", poolAddress);
  const desk = await deploy("RfqDesk.sol", "RfqDesk", poolAddress, v);
  await send(pool, "setDesk", await desk.getAddress());
  await send(pool, "setScheduler", opAddress, true);
  const gate = await deploy("ScreeningGate.sol", "ScreeningGate", opAddress, opAddress);
  await send(pool, "setGate", await gate.getAddress());
  const disclosure = await deploy("DisclosureRegistry.sol", "DisclosureRegistry");
  // withdrawals and orders must prove their deposit is in the screened association set, as on mainnet
  await send(gate, "setAssociationRequired", true);
  // the owner chain the alerts watch: an OpenZeppelin timelock (no delay here) with the operator as proposer and
  // executor, standing in for the Safe
  const timelock = await deploy("TimelockController.sol", "TimelockController", 0, [opAddress], [opAddress], opAddress);

  const usdg = await deploy("MockUSDG.sol", "MockUSDG");
  await send(usdg, "setMinter", opAddress);
  const PRICES = { ETH: 2_500e8, USDG: 1e8, TSLA: 250e8, AMZN: 200e8, AMD: 150e8, PLTR: 30e8 } as const;
  const feeds: Record<string, string> = {};
  const tokens: Record<string, string> = { USDG: await usdg.getAddress() };
  for (const [symbol, price] of Object.entries(PRICES)) {
    const feed = await deploy("MockAggregator.sol", "MockAggregator", `${symbol} / USD`, opAddress, BigInt(price));
    feeds[symbol] = await feed.getAddress();
    if (symbol === "ETH") continue;
    if (symbol === "USDG") {
      await send(pool, "setMarket", tokens["USDG"], feeds[symbol], 1, false, 0, 25 * 3_600);
      await send(pool, "setMinLock", tokens["USDG"], 25_000_000);
      continue;
    }
    const stock = await deploy("AuctionPool.t.sol", "MockStock");
    tokens[symbol] = await stock.getAddress();
    await send(pool, "setMarket", tokens[symbol], feeds[symbol], 10n ** 12n, true, 500, 3_600);
    await send(pool, "setMinLock", tokens[symbol], 50_000);
  }

  const deployment: Deployment = {
    chainId: 4663,
    deployBlock,
    operator: opAddress,
    deployer: opAddress,
    owner: await timelock.getAddress(),
    safe: opAddress,
    safeSigners: [opAddress],
    AuctionPool: poolAddress,
    PrintRegistry: await prints.getAddress(),
    RfqDesk: await desk.getAddress(),
    ScreeningGate: await gate.getAddress(),
    DisclosureRegistry: await disclosure.getAddress(),
    feeds: feeds as Deployment["feeds"],
    tokens: tokens as Deployment["tokens"],
  };

  const db = await database();
  const seal = Wallet.createRandom();
  Object.assign(process.env, {
    RPC_URL: url,
    CHAINALYSIS_API_KEY: "local-key",
    DATABASE_URL: "postgres://local:5432/luminary",
    OPERATOR_PRIVATE_KEY: account(0).privateKey,
    SEAL_KEY: seal.privateKey,
    SEAL_PUBLIC: seal.signingKey.compressedPublicKey,
    FEE_SECRET: String(feeSecret),
    CRON_SECRET: "local-cron-secret",
  });

  // snapshots: mock.module swaps the live module namespaces
  const [config, bbjs] = [{ ...realConfig }, { ...bb }];
  mock.module("postgres", () => ({ default: fakePostgres(db) }));
  mock.module("@/lib/luminary-config", () => ({ ...config, DEPLOYMENT: deployment, CONFIG: { ...config.CONFIG, rpcUrl: url } }));
  // bb.js's prover is the one slow part: a fixed-size dummy proof (the verifier accepts any); hashing stays real
  class FakeBackend {
    async generateProof() {
      return { proof: new Uint8Array(512).fill(7), publicInputs: [] as string[] };
    }
  }
  mock.module("@aztec/bb.js", () => ({ ...bbjs, Barretenberg: { new: async () => ({}) }, UltraHonkBackend: FakeBackend }));

  const [webhook, relayed, sanctioned]: [string[], Record<string, unknown>[], Set<string>] = [[], [], new Set()];
  await routeFetch(webhook, relayed, sanctioned);

  return { url, chain, operator: op, deployment, db, webhook, relayed, sanctioned, stop: () => anvil.kill() };
}

/** fetch() of "/api/..." goes to the route handlers in-process; the alert webhook (http://hook.local, /fail answers 500)
 * and the Chainalysis sanctions API are faked. */
async function routeFetch(webhook: string[], relayed: Record<string, unknown>[], sanctioned: Set<string>) {
  const native = globalThis.fetch;
  const routes = new Map<string, Record<string, (ctx: { request: Request }) => Promise<Response>>>();
  const handlers = async (path: string) => {
    // "/api/pool/events" is the route file pool_.events.ts (TanStack's non-nested route)
    const file = path.replace(/^\/api\//, "").replace(/^pool\//, "pool_.");
    if (!routes.has(file)) {
      const mod = await import(join(ROOT, "src", "routes", "api", `${file}.ts`));
      routes.set(file, mod.Route.options.server.handlers);
    }
    return routes.get(file)!;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith("/api/")) {
      const request = new Request(`http://local${href}`, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/pool/relay" && request.method === "POST") relayed.push(await request.clone().json());
      const h = (await handlers(path))[request.method];
      if (!h) return Response.json({ ok: false, error: "method" }, { status: 405 });
      return h({ request });
    }
    if (href.startsWith("http://hook.local")) {
      if (href.endsWith("/fail")) return new Response("down", { status: 500 });
      webhook.push(String(init?.body ?? ""));
      return new Response("ok");
    }
    if (href.startsWith("https://public.chainalysis.com/api/v1/address/")) {
      const address = href.split("/").pop()!.toLowerCase();
      if (new Headers(init?.headers).get("X-API-Key") !== "local-key") return new Response("unauthorized", { status: 403 });
      return Response.json({ identifications: sanctioned.has(address) ? [{ category: "sanctions", name: "test" }] : [] });
    }
    return native(input, init);
  }) as typeof fetch;
}

/** An EIP-1193 provider over a local key, the way scripts/acceptance.ts drives ShieldedAccount. */
export function eth(w: Wallet, chain: JsonRpcProvider) {
  const signer = new NonceManager(w.connect(chain));
  return {
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      if (method === "eth_requestAccounts") return [w.address];
      if (method === "personal_sign") return w.signMessage(getBytes(params[0] as string));
      if (method.startsWith("wallet_")) return null;
      if (method === "eth_sendTransaction") {
        const tx = params[0] as { to: string; data?: string; value?: string };
        return (await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n })).hash;
      }
      return chain.send(method, params);
    },
  };
}
