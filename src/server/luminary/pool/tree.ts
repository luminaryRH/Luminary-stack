// Appends queued commitments to the pool's tree with a TreeUpdateProof (no Poseidon on chain).
// Deposits, change notes and settlement outputs become spendable once their batch lands. The frontier after each batch
// is cached, so a run only reads and hashes the new leaves; without a matching cache it rebuilds from every leaf.
// A partial batch waits up to MAX_WAIT_SEC for more leaves (one proof and one operator tx per batch). A tree holds
// CAPACITY (2^20) leaves: a batch never crosses into the next tree, and the first batch after a full tree starts the
// new one from the empty root (AuctionPool.advanceTree does the same).
import treeUpdate from "@/shielded/circuits/tree_update.json";
import { BATCH, CAPACITY, appendLeaves, frontierOf, hex, ready, rootOf } from "@/shielded/protocol";
import { prove } from "@/shielded/prove";
import { rpc } from "../db";
import { pool } from "./contract";
import { sendPool } from "./sends";

const MAX_WAIT_SEC = 120;

interface TreeQueue {
  size: number;
  since: number;
}

interface TreeCache {
  size: number;
  root: string;
  frontier: string[];
}

/** Appends the next batch of queued commitments to the note tree with a TreeUpdateProof. */
export async function advancePoolTree() {
  const c = pool();
  const [count, size] = (await Promise.all([c.getFunction("commitmentCount")(), c.getFunction("treeSize")()])).map(Number) as [number, number];
  if (count === size) return { idle: true, size };

  const stats = await rpc<{ count: number; max: number }>("lum_pool_leaf_stats", {});
  if (stats.count !== stats.max + 1 || stats.count < count) return { waiting: `indexed ${stats.count} of ${count} commitments` };

  const index = size % CAPACITY; // the next leaf's position in its tree
  const base = size - index; // where that tree starts
  // a partial batch waits up to MAX_WAIT_SEC from when the tree first fell behind, so busy periods share one tx; a batch
  // that ends a tree is complete as it is
  const n = Math.min(BATCH, count - size, CAPACITY - index);
  if (n < BATCH && n < CAPACITY - index) {
    const now = Math.floor(Date.now() / 1000);
    const q = await rpc<TreeQueue | null>("lum_pool_get_state", { p_name: "treeQueue" });
    if (q?.size !== size) await rpc("lum_pool_put_state", { p_name: "treeQueue", p_value: { size, since: now } satisfies TreeQueue });
    const waited = q?.size === size ? now - q.since : 0;
    if (waited < MAX_WAIT_SEC) return { batching: n, waitSec: MAX_WAIT_SEC - waited };
  }

  await ready();
  const onChainRoot = String(await c.getFunction("root")()).toLowerCase();
  const cache = await rpc<TreeCache | null>("lum_pool_get_state", { p_name: "tree" });
  let frontier: bigint[];
  let batch: bigint[];
  let oldRoot = BigInt(onChainRoot);
  if (index === 0) {
    // a new tree (the first, or the next after a full one): it starts empty, whatever the pool's last root was
    frontier = frontierOf([]);
    oldRoot = rootOf([]);
    batch = (await rpc<string[]>("lum_pool_leaves", { p_from: size, p_limit: n })).map((x) => BigInt(x));
  } else if (cache && cache.size === size && cache.root === onChainRoot) {
    frontier = cache.frontier.map((x) => BigInt(x));
    batch = (await rpc<string[]>("lum_pool_leaves", { p_from: size, p_limit: n })).map((x) => BigInt(x));
  } else {
    const leaves = (await rpc<string[]>("lum_pool_leaves", { p_from: base, p_limit: index + n })).map((x) => BigInt(x));
    if (hex(rootOf(leaves.slice(0, index))) !== onChainRoot) {
      console.error("tree: indexed leaves do not reproduce the on-chain root", { size, count, onChainRoot });
      return { error: "indexed leaves do not reproduce the on-chain root" };
    }
    frontier = frontierOf(leaves.slice(0, index));
    batch = leaves.slice(index, index + n);
  }
  const next = appendLeaves(frontier, index, batch);
  const inputs = {
    frontier,
    old_root: oldRoot,
    next_index: index,
    leaves: [...batch, ...Array<bigint>(BATCH - n).fill(0n)],
    count: n,
    new_root: next.root,
  };
  const { proof } = await prove(treeUpdate as never, inputs, 2);
  const tx = await sendPool("advanceTree", [n, hex(next.root), proof], "advanceTree");
  if (!tx) return { waiting: "an operator transaction is still pending" };
  await rpc("lum_pool_put_state", { p_name: "tree", p_value: { size: size + n, root: hex(next.root), frontier: next.frontier.map(hex) } satisfies TreeCache });
  return { appended: n, size: size + n, tx };
}
