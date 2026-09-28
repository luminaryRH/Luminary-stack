-- Luminary auctions: the calendar's planned auctions and their on-chain lifecycle, the public print tape, the market
-- calendar and corporate actions the schedule pauses around, and the price / NAV marks the nav-watcher mirrors.
-- Every column is public information. Re-runnable.

-- Tokens the pool knows: the five stock tokens, the quote tokens (TQ, USDG).
create table if not exists lum_assets (
  symbol text primary key,
  address text not null unique,
  feed text, -- testnet MockAggregator (TQ reads as its own feed)
  decimals int not null,
  kind text not null check (kind in ('stock', 'quote'))
);

-- scheduled (planned, not on chain) → collecting (on chain, before its call) → pinned → cleared | void
create table if not exists lum_auctions (
  key text primary key, -- '<SYMBOL>:<KIND>:<call time ISO>'
  symbol text not null references lum_assets (symbol),
  kind text not null check (kind in ('OPEN', 'CLOSE', 'MIDNIGHT', 'NAV', 'RFQ')),
  call_time timestamptz not null,
  chain_id bigint unique, -- AuctionPool auction id once scheduled on chain
  status text not null default 'scheduled' check (status in ('scheduled', 'collecting', 'pinned', 'cleared', 'void')),
  call_block bigint,
  ref_usd numeric,
  quote_usd numeric,
  p_star numeric,
  crossed_qty numeric,
  proof_tx text,
  updated_at timestamptz not null default now()
);
create index if not exists lum_auctions_by_time on lum_auctions (call_time);
create index if not exists lum_auctions_by_status on lum_auctions (status, call_time);

-- One print per settled auction, from PrintRegistry's Printed event.
create table if not exists lum_prints (
  auction_id bigint primary key,
  symbol text,
  asset text not null,
  p_star numeric not null,
  crossed_qty numeric not null,
  block bigint not null,
  tx_hash text not null,
  printed_at timestamptz not null
);
create index if not exists lum_prints_by_symbol on lum_prints (symbol, printed_at desc);

-- NYSE holidays and early closes (close_time in America/New_York).
create table if not exists lum_market_calendar (
  day date primary key,
  kind text not null check (kind in ('holiday', 'early_close')),
  close_time time,
  note text not null default ''
);

-- Corporate actions; the schedule pauses an asset's auctions on its Ex-Date.
create table if not exists lum_corporate_actions (
  id bigint generated always as identity primary key,
  symbol text not null references lum_assets (symbol),
  ex_date date not null,
  kind text not null check (kind in ('dividend', 'split', 'reverse_split', 'other')),
  note text not null default '',
  unique (symbol, ex_date, kind)
);

create table if not exists lum_price_marks (
  symbol text not null,
  at timestamptz not null,
  usd numeric not null, -- micro-USD per token
  source text not null,
  primary key (symbol, at)
);

create table if not exists lum_nav_marks (
  at timestamptz primary key,
  nav numeric not null -- micro-USDG per TQ share
);

-- ---------------------------------------------------------------------------
-- The chain drives the lifecycle: indexed pool and registry events update the auctions and the tape.

create or replace function lum_symbol_of(p_address text) returns text
language sql stable set search_path = public as $$
  select symbol from lum_assets where address = lower(p_address)
$$;

create or replace function lum_auction_from_event() returns trigger
language plpgsql set search_path = public as $$
declare
  v_id bigint := (new.args->>'id')::bigint;
  v_kind text;
  v_symbol text;
begin
  if new.name = 'AuctionScheduled' then
    v_kind := (array['OPEN', 'CLOSE', 'MIDNIGHT', 'NAV', 'RFQ'])[(new.args->>'kind')::int + 1];
    v_symbol := lum_symbol_of(new.args->>'asset');
    if v_symbol is null then return new; end if;
    update lum_auctions set chain_id = v_id, status = 'collecting', updated_at = now()
     where chain_id is null and symbol = v_symbol and kind = v_kind and call_time = to_timestamp((new.args->>'callTime')::bigint);
    if not found then
      insert into lum_auctions (key, symbol, kind, call_time, chain_id, status)
      values (v_symbol || ':' || v_kind || ':' || v_id, v_symbol, v_kind, to_timestamp((new.args->>'callTime')::bigint), v_id, 'collecting')
      on conflict do nothing;
    end if;
  elsif new.name = 'AuctionPinned' then
    update lum_auctions set status = 'pinned', call_block = (new.args->>'callBlock')::bigint, ref_usd = (new.args->>'refUsd')::numeric,
                            quote_usd = (new.args->>'quoteUsd')::numeric, updated_at = now()
     where chain_id = v_id and status in ('scheduled', 'collecting');
  elsif new.name = 'AuctionSettled' then
    update lum_auctions set status = 'cleared', p_star = (new.args->>'pStar')::numeric, crossed_qty = (new.args->>'crossedQty')::numeric,
                            proof_tx = new.tx_hash, updated_at = now()
     where chain_id = v_id;
  elsif new.name = 'AuctionVoided' then
    update lum_auctions set status = 'void', updated_at = now() where chain_id = v_id;
  elsif new.name = 'Printed' then
    insert into lum_prints (auction_id, symbol, asset, p_star, crossed_qty, block, tx_hash, printed_at)
    values ((new.args->>'auctionId')::bigint, lum_symbol_of(new.args->>'asset'), lower(new.args->>'asset'), (new.args->>'pStar')::numeric,
            (new.args->>'crossedQty')::numeric, new.block, new.tx_hash, coalesce(to_timestamp((new.args->>'_ts')::bigint), now()))
    on conflict (auction_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists lum_auction_from_event on lum_pool_events;
create trigger lum_auction_from_event after insert on lum_pool_events
  for each row when (new.name in ('AuctionScheduled', 'AuctionPinned', 'AuctionSettled', 'AuctionVoided', 'Printed'))
  execute function lum_auction_from_event();

-- ---------------------------------------------------------------------------
-- Assets

create or replace function lum_assets_put(p_rows jsonb) returns void
language sql set search_path = public as $$
  insert into lum_assets (symbol, address, feed, decimals, kind)
  select r->>'symbol', lower(r->>'address'), lower(r->>'feed'), (r->>'decimals')::int, r->>'kind' from jsonb_array_elements(p_rows) r
  on conflict (symbol) do update set address = excluded.address, feed = excluded.feed, decimals = excluded.decimals, kind = excluded.kind
$$;

create or replace function lum_assets_list() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.kind desc, a.symbol), '[]') from lum_assets a
$$;

-- ---------------------------------------------------------------------------
-- Auctions

-- Planned auctions from the calendar; an existing key is left alone (its chain state is the chain's).
create or replace function lum_auctions_plan(p_rows jsonb) returns int
language plpgsql set search_path = public as $$
declare
  v_inserted int;
begin
  insert into lum_auctions (key, symbol, kind, call_time)
  select r->>'key', r->>'symbol', r->>'kind', (r->>'callTime')::timestamptz from jsonb_array_elements(p_rows) r
  on conflict (key) do nothing;
  get diagnostics v_inserted = row_count;
  -- a planned auction the calendar no longer produces (a holiday or Ex-Date entered later) never goes on chain
  update lum_auctions a set status = 'void', updated_at = now()
   where a.status = 'scheduled' and a.chain_id is null and a.kind <> 'NAV' and a.call_time > now()
     and a.call_time <= (select max((r->>'callTime')::timestamptz) from jsonb_array_elements(p_rows) r)
     and not exists (select 1 from jsonb_array_elements(p_rows) r where r->>'key' = a.key);
  return v_inserted;
end $$;

-- Planned auctions to put on chain now: calls from p_min_lead to p_horizon ahead.
create or replace function lum_auctions_to_schedule(p_min_lead_sec int, p_horizon_sec int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'symbol', symbol, 'kind', kind, 'callTime', extract(epoch from call_time)::bigint)
                            order by call_time), '[]')
    from lum_auctions
   where status = 'scheduled' and chain_id is null
     and call_time > now() + make_interval(secs => p_min_lead_sec) and call_time <= now() + make_interval(secs => p_horizon_sec)
$$;

-- The next collecting auction of a pair after a call time, where a settlement's rolled orders rest.
create or replace function lum_auction_roll_target(p_symbol text, p_after timestamptz) returns bigint
language sql stable set search_path = public as $$
  select chain_id from lum_auctions
   where symbol = p_symbol and kind in ('OPEN', 'CLOSE', 'MIDNIGHT') and status = 'collecting' and call_time > greatest(p_after, now() + interval '2 minutes')
   order by call_time limit 1
$$;

create or replace function lum_auctions_between(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', key, 'symbol', symbol, 'kind', kind, 'callTime', call_time, 'id', chain_id, 'status', status, 'callBlock', call_block,
      'refUsd', ref_usd::text, 'quoteUsd', quote_usd::text, 'pStar', p_star::text, 'crossedQty', crossed_qty::text, 'proofTx', proof_tx)
      order by call_time, symbol), '[]')
    from lum_auctions
   where call_time >= p_from and call_time < p_to
     and (status <> 'void' or chain_id is not null) -- a plan dropped before it reached the chain is not shown
$$;

-- ---------------------------------------------------------------------------
-- Prints

create or replace function lum_prints_list(p_symbol text default null, p_limit int default 100) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'auctionId', p.auction_id, 'symbol', p.symbol, 'asset', p.asset, 'pStar', p.p_star::text, 'crossedQty', p.crossed_qty::text,
      'block', p.block, 'tx', p.tx_hash, 'at', p.printed_at, 'kind', a.kind, 'refUsd', a.ref_usd::text)
      order by p.printed_at desc), '[]')
    from (select * from lum_prints where p_symbol is null or symbol = p_symbol order by printed_at desc limit least(p_limit, 500)) p
    left join lum_auctions a on a.chain_id = p.auction_id
$$;

-- ---------------------------------------------------------------------------
-- Calendar and corporate actions

create or replace function lum_calendar_between(p_from date, p_to date) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'kind', kind, 'closeTime', close_time, 'note', note) order by day)
                        from lum_market_calendar where day between p_from and p_to), '[]'),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'symbol', symbol, 'exDate', ex_date, 'kind', kind, 'note', note) order by ex_date, symbol)
                           from lum_corporate_actions where ex_date between p_from and p_to), '[]'))
$$;

create or replace function lum_calendar_put(p_rows jsonb) returns void
language sql set search_path = public as $$
  insert into lum_market_calendar (day, kind, close_time, note)
  select (r->>'day')::date, r->>'kind', (r->>'closeTime')::time, coalesce(r->>'note', '') from jsonb_array_elements(p_rows) r
  on conflict (day) do update set kind = excluded.kind, close_time = excluded.close_time, note = excluded.note
$$;

create or replace function lum_corporate_action_put(p_symbol text, p_ex_date date, p_kind text, p_note text) returns bigint
language sql set search_path = public as $$
  insert into lum_corporate_actions (symbol, ex_date, kind, note) values (upper(p_symbol), p_ex_date, p_kind, coalesce(p_note, ''))
  on conflict (symbol, ex_date, kind) do update set note = excluded.note
  returning id
$$;

create or replace function lum_corporate_action_delete(p_id bigint) returns void
language sql set search_path = public as $$
  delete from lum_corporate_actions where id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Marks: latest per symbol, and history pruned to 30 days.

create or replace function lum_marks_put(p_rows jsonb, p_nav numeric) returns void
language plpgsql set search_path = public as $$
begin
  insert into lum_price_marks (symbol, at, usd, source)
  select r->>'symbol', now(), (r->>'usd')::numeric, r->>'source' from jsonb_array_elements(p_rows) r
  on conflict do nothing;
  if p_nav is not null then
    insert into lum_nav_marks (at, nav) values (now(), p_nav) on conflict do nothing;
  end if;
  delete from lum_price_marks where at < now() - interval '30 days';
  delete from lum_nav_marks where at < now() - interval '365 days';
end $$;

create or replace function lum_marks_latest() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'prices', coalesce((select jsonb_object_agg(symbol, jsonb_build_object('usd', usd::text, 'at', at, 'source', source))
                          from (select distinct on (symbol) * from lum_price_marks order by symbol, at desc) m), '{}'),
    'nav', (select jsonb_build_object('nav', nav::text, 'at', at) from lum_nav_marks order by at desc limit 1))
$$;

create or replace function lum_nav_history(p_days int default 30) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'nav', nav::text) order by at), '[]')
    from (select distinct on (date_trunc('hour', at)) at, nav from lum_nav_marks
           where at > now() - make_interval(days => p_days) order by date_trunc('hour', at), at desc) h
$$;

-- ---------------------------------------------------------------------------
-- NYSE 2026–2027 holidays and early closes (13:00 ET).
insert into lum_market_calendar (day, kind, close_time, note) values
  ('2026-01-01', 'holiday', null, 'New Year''s Day'), ('2026-01-19', 'holiday', null, 'Martin Luther King Jr. Day'),
  ('2026-02-16', 'holiday', null, 'Washington''s Birthday'), ('2026-04-03', 'holiday', null, 'Good Friday'),
  ('2026-05-25', 'holiday', null, 'Memorial Day'), ('2026-06-19', 'holiday', null, 'Juneteenth'),
  ('2026-07-03', 'holiday', null, 'Independence Day (observed)'), ('2026-09-07', 'holiday', null, 'Labor Day'),
  ('2026-11-26', 'holiday', null, 'Thanksgiving Day'), ('2026-11-27', 'early_close', '13:00', 'Day after Thanksgiving'),
  ('2026-12-24', 'early_close', '13:00', 'Christmas Eve'), ('2026-12-25', 'holiday', null, 'Christmas Day'),
  ('2027-01-01', 'holiday', null, 'New Year''s Day'), ('2027-01-18', 'holiday', null, 'Martin Luther King Jr. Day'),
  ('2027-02-15', 'holiday', null, 'Washington''s Birthday'), ('2027-03-26', 'holiday', null, 'Good Friday'),
  ('2027-05-31', 'holiday', null, 'Memorial Day'), ('2027-06-18', 'holiday', null, 'Juneteenth (observed)'),
  ('2027-07-05', 'holiday', null, 'Independence Day (observed)'), ('2027-09-06', 'holiday', null, 'Labor Day'),
  ('2027-11-25', 'holiday', null, 'Thanksgiving Day'), ('2027-11-26', 'early_close', '13:00', 'Day after Thanksgiving'),
  ('2027-12-24', 'holiday', null, 'Christmas Day (observed)')
on conflict (day) do nothing;

-- ---------------------------------------------------------------------------
alter table lum_assets enable row level security;
alter table lum_auctions enable row level security;
alter table lum_prints enable row level security;
alter table lum_market_calendar enable row level security;
alter table lum_corporate_actions enable row level security;
alter table lum_price_marks enable row level security;
alter table lum_nav_marks enable row level security;
revoke all on table lum_assets, lum_auctions, lum_prints, lum_market_calendar, lum_corporate_actions, lum_price_marks, lum_nav_marks
  from public, anon, authenticated;
grant all on table lum_assets, lum_auctions, lum_prints, lum_market_calendar, lum_corporate_actions, lum_price_marks, lum_nav_marks
  to service_role;

revoke execute on function lum_auction_from_event() from public, anon, authenticated;
revoke execute on function
  lum_symbol_of(text), lum_assets_put(jsonb), lum_assets_list(), lum_auctions_plan(jsonb), lum_auctions_to_schedule(int, int),
  lum_auction_roll_target(text, timestamptz), lum_auctions_between(timestamptz, timestamptz), lum_prints_list(text, int),
  lum_calendar_between(date, date), lum_calendar_put(jsonb), lum_corporate_action_put(text, date, text, text),
  lum_corporate_action_delete(bigint), lum_marks_put(jsonb, numeric), lum_marks_latest(), lum_nav_history(int)
from public, anon, authenticated;
grant execute on function
  lum_symbol_of(text), lum_assets_put(jsonb), lum_assets_list(), lum_auctions_plan(jsonb), lum_auctions_to_schedule(int, int),
  lum_auction_roll_target(text, timestamptz), lum_auctions_between(timestamptz, timestamptz), lum_prints_list(text, int),
  lum_calendar_between(date, date), lum_calendar_put(jsonb), lum_corporate_action_put(text, date, text, text),
  lum_corporate_action_delete(bigint), lum_marks_put(jsonb, numeric), lum_marks_latest(), lum_nav_history(int)
to service_role;
