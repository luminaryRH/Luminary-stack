// bun supabase/checks/pool.check.ts
// The Luminary schema (0001–0004) in PGlite: idempotent event recording with the cursor, the leaf table, open auctions
// with a cancelled slot, the auction lifecycle and print tape driven by events, calendar planning, the operator send
// queue, relay idempotency and the worker run log.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
const dir = new URL("../migrations/", import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const text = readFileSync(new URL(f, dir), "utf8");
  await db.exec(text);
  await db.exec(text); // re-runnable
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const TSLA = "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e";
const TQ = "0x00000000000000000000000000000000000007e7";
await q(`select lum_assets_put($1::jsonb)`, [JSON.stringify([
  { symbol: "TSLA", address: TSLA.toUpperCase().replace("0X", "0x"), feed: "0x01", decimals: 18, kind: "stock" },
  { symbol: "TQ", address: TQ, feed: TQ, decimals: 6, kind: "quote" },
])]);
await q(`select lum_init_cursor('pool_events', 99)`);

// a planned CLOSE auction, then the chain schedules it
const call = 1_790_000_000;
await q(`select lum_auctions_plan($1::jsonb)`, [JSON.stringify([{ key: `TSLA:CLOSE:${call}`, symbol: "TSLA", kind: "CLOSE", callTime: new Date(call * 1000).toISOString() }])]);
const ev = (tx: string, logIndex: number, block: number, name: string, args: Record<string, unknown>) => ({ tx_hash: tx, log_index: logIndex, block, name, args });
const record = (events: unknown[], to: number) => val(`select lum_pool_record($1::jsonb, $2)`, [JSON.stringify(events), to]);
const batch = [
  ev("0xT1", 0, 100, "AuctionScheduled", { id: "0", asset: TSLA, quote: TQ, kind: "1", callTime: String(call), capBps: "500" }),
  ev("0xT2", 1, 101, "Committed", { index: "1", commitment: "0xc1" }),
  ev("0xT2", 0, 101, "Committed", { index: "0", commitment: "0xc0" }),
  ev("0xT3", 0, 102, "OrderResting", { id: "0", slot: "0", commitment: "0xo0", sealedOrder: "0xs0" }),
  ev("0xT4", 0, 103, "OrderResting", { id: "0", slot: "1", commitment: "0xo1", sealedOrder: "0xs1" }),
  ev("0xT5", 0, 104, "OrderReclaimed", { id: "0", slot: "0", cancelled: true }),
];
assert.equal(await record(batch, 110), 6);
assert.equal(await record(batch, 105), 0, "idempotent");
assert.equal(Number(await val(`select lum_get_cursor('pool_events')`)), 110, "cursor never moves back");
assert.deepEqual(await val(`select lum_pool_leaves(0, 10)`), ["0xc0", "0xc1"]);
assert.deepEqual(await val(`select lum_pool_leaf_stats()`), { count: 2, max: 1 });

let open = await val(`select lum_pool_open_auctions()`);
assert.equal(open.length, 1);
assert.deepEqual(open[0].orders.map((o: any) => o.slot), [1], "the cancelled slot is left out");
assert.equal(open[0].pinned, false);
let a = (await q(`select * from lum_auctions`))[0]!;
assert.equal(a.status, "collecting");
assert.equal(Number(a.chain_id), 0);

// pin, settle, print
await record([
  ev("0xT6", 0, 120, "AuctionPinned", { id: "0", callBlock: "120", refUsd: "250000000", quoteUsd: "1000000" }),
], 120);
open = await val(`select lum_pool_open_auctions()`);
assert.equal(open[0].pinned, true);
await record([
  ev("0xT7", 3, 130, "AuctionSettled", { id: "0", pStar: "245000000", crossedQty: "3000000", notes: "0x" }),
  ev("0xT7", 4, 130, "Printed", { auctionId: "0", asset: TSLA, pStar: "245000000", crossedQty: "3000000", index: "0", _ts: String(call + 60) }),
], 130);
a = (await q(`select * from lum_auctions`))[0]!;
assert.equal(a.status, "cleared");
assert.equal(String(a.p_star), "245000000");
assert.equal(a.proof_tx, "0xt7");
assert.deepEqual(await val(`select lum_pool_open_auctions()`), []);
const prints = await val(`select lum_prints_list('TSLA', 10)`);
assert.equal(prints.length, 1);
assert.equal(prints[0].pStar, "245000000");
assert.equal(prints[0].kind, "CLOSE");

// an RFQ auction the desk opened has no plan row: one is created from the event
await record([ev("0xT8", 0, 140, "AuctionScheduled", { id: "1", asset: TSLA, quote: TQ, kind: "4", callTime: String(call + 300), capBps: "500" })], 140);
assert.equal(await val(`select status from lum_auctions where chain_id = 1`), "collecting");

// the calendar drops a planned auction that never reached the chain
const future = Math.floor(Date.now() / 1000) + 86_400;
const plan = (keys: number[]) => JSON.stringify(keys.map((t) => ({ key: `TSLA:OPEN:${t}`, symbol: "TSLA", kind: "OPEN", callTime: new Date(t * 1000).toISOString() })));
assert.equal(await val(`select lum_auctions_plan($1::jsonb)`, [plan([future, future + 86_400])]), 2);
await q(`select lum_auctions_plan($1::jsonb)`, [plan([future + 86_400])]);
assert.equal(await val(`select status from lum_auctions where key = $1`, [`TSLA:OPEN:${future}`]), "void");
assert.equal((await val(`select lum_auctions_to_schedule(60, 3 * 86400)`)).length, 1);

// operator send queue: keyed sends never race, a pending unknown tx blocks
const W = "0xAbC";
const claim = (key: string | null, nonce: number, pending: number) => val(`select lum_claim_operator_send($1, $2, '0xpool', '0x', $3, $4, 6)`, [W, key, nonce, pending]);
assert.equal(await claim(null, 5, 6), null, "an unknown pending transaction blocks the queue");
assert.equal(Number(await claim("tree", 5, 5)), 5);
assert.equal(await claim("tree", 5, 5), null);
assert.equal(Number(await claim("settle:0", 5, 5)), 6);
await q(`select lum_operator_send_signed($1, 5, '0xpool', '0x', '0xh5', '0xraw', 100, 1)`, [W]);
assert.equal((await val(`select lum_operator_sends_active($1, 6)`, [W])).length, 1, "nonce 5 mined");

// relays: one id, one broadcast
const ID = "ab".repeat(16);
assert.deepEqual(await val(`select lum_relay_claim($1, 'order', 10)`, [ID]), { claimed: true });
assert.equal((await val(`select lum_relay_claim($1, 'order', 10)`, [ID])).claimed, false);
await q(`select lum_relay_sent($1, '0xTX')`, [ID]);
assert.equal((await val(`select lum_relay_status($1)`, [ID])).tx, "0xtx");

// run log streaks
const log = (status: string) => val(`select lum_cron_log('tick', $1::jsonb)`, [JSON.stringify([{ step: "tree", status, ms: 5, detail: {} }])]);
await log("error");
assert.deepEqual(await log("error"), { tree: 2 });
assert.deepEqual(await log("ok"), {});

// marks and calendar
await q(`select lum_marks_put($1::jsonb, 1004000)`, [JSON.stringify([{ symbol: "TSLA", usd: "250000000", source: "chainlink" }])]);
const marks = await val(`select lum_marks_latest()`);
assert.equal(marks.prices.TSLA.usd, "250000000");
assert.equal(marks.nav.nav, "1004000");
assert.equal((await val(`select lum_calendar_between('2026-11-01', '2026-11-30')`)).days.length, 2);

// no anonymous access
assert.equal(await val(`select has_table_privilege('anon', 'lum_pool_events', 'select')`), false);
assert.equal(await val(`select has_function_privilege('anon', 'lum_pool_record(jsonb, bigint)', 'execute')`), false);

console.log("pool.check: ok");
