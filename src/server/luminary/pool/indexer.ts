// Mirrors AuctionPool's events, and PrintRegistry's, DisclosureRegistry's and RfqDesk's, into lum_pool_events (0001).
// Everything indexed is already public on chain; lum_pool_record is idempotent and moves the cursor in the same
// transaction, so a partial run just continues. Printed events carry their block time (_ts) for the tape. Indexed
// auction events drive lum_auctions and lum_prints through a trigger (0004).
import { provider } from "../chain";
import { rpc } from "../db";
import { POOL_ABI, deployment } from "./contract";

const CONFIRMATIONS = 2;
const LOG_CHUNK = 2_000;
const CURSOR = "pool_events";

const plain = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v);

export async function indexPool(maxBlocks = 20_000) {
  const d = deployment();
  await rpc("lum_init_cursor", { p_name: CURSOR, p_block: d.deployBlock - 1 });
  const cursor = Number(await rpc<number>("lum_get_cursor", { p_name: CURSOR }));
  const p = provider();
  const safe = (await p.getBlockNumber()) - CONFIRMATIONS;
  const end = Math.min(safe, cursor + maxBlocks);
  const sources = [d.AuctionPool, d.PrintRegistry, d.DisclosureRegistry, d.RfqDesk];
  let from = cursor + 1;
  let recorded = 0;
  while (from <= end) {
    const to = Math.min(end, from + LOG_CHUNK - 1);
    const logs = await p.getLogs({ address: sources, fromBlock: from, toBlock: to });
    const times = new Map<number, number>();
    for (const n of new Set(logs.filter((l) => POOL_ABI.parseLog(l)?.name === "Printed").map((l) => l.blockNumber))) {
      times.set(n, (await p.getBlock(n))!.timestamp);
    }
    const events = logs.flatMap((log) => {
      const ev = POOL_ABI.parseLog(log);
      if (!ev) return [];
      const args: Record<string, unknown> = Object.fromEntries(ev.fragment.inputs.map((input, i) => [input.name, plain(ev.args[i])]));
      if (ev.name === "Printed") args["_ts"] = String(times.get(log.blockNumber));
      return [{ tx_hash: log.transactionHash, log_index: log.index, block: log.blockNumber, name: ev.name, args }];
    });
    recorded += await rpc<number>("lum_pool_record", { p_events: events, p_to_block: to });
    from = to + 1;
  }
  const behind = safe - Math.max(end, cursor);
  return { recorded, indexedTo: Math.max(end, cursor), ...(behind > 0 ? { waiting: `${behind} blocks behind the chain` } : {}) };
}
