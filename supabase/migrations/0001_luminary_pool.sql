-- Luminary pool mirror. AuctionPool's public events (and PrintRegistry's, DisclosureRegistry's, RfqDesk's), indexed from
-- chain for the workers and the browser client, plus operator state derived from public data. Nothing here is a
-- plaintext order or balance: commitments, sealed ciphertexts and public prints only. Re-runnable.
-- Access: service role only, through these functions (PostgREST RPC); RLS on, no grants to anon / authenticated.

create table if not exists lum_chain_cursor (
  name text primary key,
  last_block bigint not null
);
alter table lum_chain_cursor enable row level security;

create or replace function lum_get_cursor(p_name text) returns bigint
language sql stable set search_path = public as $$
  select last_block from lum_chain_cursor where name = p_name
$$;

-- Never moves backwards.
create or replace function lum_set_cursor(p_name text, p_block bigint) returns void
language sql set search_path = public as $$
  insert into lum_chain_cursor (name, last_block) values (p_name, p_block)
  on conflict (name) do update set last_block = greatest(lum_chain_cursor.last_block, excluded.last_block)
$$;

-- Sets the cursor to just before the deploy block, once (scripts/set-deployment.mjs after a deploy).
create or replace function lum_init_cursor(p_name text, p_block bigint) returns void
language sql set search_path = public as $$
  insert into lum_chain_cursor (name, last_block) values (p_name, p_block) on conflict (name) do nothing
$$;

create table if not exists lum_pool_events (
  tx_hash text not null,
  log_index int not null,
  block bigint not null,
  name text not null,
  args jsonb not null,
  primary key (tx_hash, log_index)
);
create index if not exists lum_pool_events_by_name on lum_pool_events (name, block, log_index);
create index if not exists lum_pool_events_by_auction on lum_pool_events (((args->>'id')::bigint), name)
  where name in ('AuctionScheduled', 'OrderResting', 'AuctionPinned', 'AuctionSettled', 'AuctionVoided', 'OrderReclaimed');
alter table lum_pool_events enable row level security;

-- Leaves in a plain (idx, commitment) table, filled by a trigger from each Committed event, so the leaf list is a
-- primary-key range scan. Each row references its event, so clearing the mirror clears the leaves.
create table if not exists lum_pool_leaf (
  idx bigint primary key,
  commitment text not null,
  tx_hash text not null,
  log_index int not null,
  foreign key (tx_hash, log_index) references lum_pool_events (tx_hash, log_index) on delete cascade
);
alter table lum_pool_leaf enable row level security;

create or replace function lum_pool_leaf_from_event() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into lum_pool_leaf (idx, commitment, tx_hash, log_index)
  values ((new.args->>'index')::bigint, new.args->>'commitment', new.tx_hash, new.log_index)
  on conflict (idx) do update set commitment = excluded.commitment, tx_hash = excluded.tx_hash, log_index = excluded.log_index;
  return new;
end $$;

drop trigger if exists lum_pool_leaf_from_event on lum_pool_events;
create trigger lum_pool_leaf_from_event after insert on lum_pool_events
  for each row when (new.name = 'Committed') execute function lum_pool_leaf_from_event();

-- Idempotent: a re-scanned range inserts nothing twice. The cursor moves in the same transaction.
create or replace function lum_pool_record(p_events jsonb, p_to_block bigint) returns int
language plpgsql set search_path = public as $$
declare
  v_inserted int;
begin
  insert into lum_pool_events (tx_hash, log_index, block, name, args)
  select lower(e->>'tx_hash'), (e->>'log_index')::int, (e->>'block')::bigint, e->>'name', e->'args'
    from jsonb_array_elements(p_events) e
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  perform lum_set_cursor('pool_events', p_to_block);
  return v_inserted;
end $$;

-- Events with these names after (block, log_index), in chain order. Pages resume inside a block.
create or replace function lum_pool_events(p_names text[], p_after_block bigint default -1, p_after_log int default 2147483647, p_limit int default 5000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('block', block, 'log_index', log_index, 'tx_hash', tx_hash, 'name', name, 'args', args)
                            order by block, log_index), '[]')
    from (select * from lum_pool_events
           where name = any(p_names) and (block, log_index) > (p_after_block, p_after_log)
           order by block, log_index limit p_limit) e
$$;

-- Queued commitments in leaf order from p_from. Callers check lum_pool_leaf_stats for gaps first.
create or replace function lum_pool_leaves(p_from bigint default 0, p_limit int default 100000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(commitment order by idx), '[]')
    from (select idx, commitment from lum_pool_leaf where idx >= p_from order by idx limit p_limit) c
$$;

-- count = max + 1 means the indexed leaves have no gaps.
create or replace function lum_pool_leaf_stats() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('count', count(*), 'max', coalesce(max(idx), -1)) from lum_pool_leaf
$$;

-- Auctions neither settled nor voided, with their live orders in slot order (cancelled slots left out) and whether
-- they are pinned. From the chain mirror only.
create or replace function lum_pool_open_auctions() returns jsonb
language sql stable set search_path = public as $$
  with open as (
    select (args->>'id')::bigint id, lower(args->>'asset') asset, lower(args->>'quote') quote, (args->>'kind')::int kind,
           (args->>'callTime')::bigint call_time
      from lum_pool_events s
     where s.name = 'AuctionScheduled'
       and not exists (select 1 from lum_pool_events c
                        where c.name in ('AuctionSettled', 'AuctionVoided') and (c.args->>'id')::bigint = (s.args->>'id')::bigint)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'asset', o.asset, 'quote', o.quote, 'kind', o.kind, 'callTime', o.call_time,
           'pinned', p.args is not null, 'pin', p.args,
           'orders', coalesce((
             select jsonb_agg(jsonb_build_object('slot', (r.args->>'slot')::int, 'commitment', r.args->>'commitment', 'sealed', r.args->>'sealedOrder')
                              order by (r.args->>'slot')::int)
               from lum_pool_events r
              where r.name = 'OrderResting' and (r.args->>'id')::bigint = o.id
                and not exists (select 1 from lum_pool_events x
                                 where x.name = 'OrderReclaimed' and (x.args->>'id')::bigint = o.id
                                   and (x.args->>'slot')::int = (r.args->>'slot')::int and (x.args->>'cancelled')::boolean)), '[]'))
         order by o.call_time, o.id), '[]')
    from open o
    left join lateral (select args from lum_pool_events p
                        where p.name = 'AuctionPinned' and (p.args->>'id')::bigint = o.id limit 1) p on true
$$;

-- The operator's sealed openings of the orders a settlement rolls (ciphertext to the sealing key), stored before the
-- settlement that creates them is sent.
create table if not exists lum_pool_openings (
  commitment text primary key,
  sealed text not null,
  created_at timestamptz not null default now()
);
alter table lum_pool_openings enable row level security;

create or replace function lum_pool_put_openings(p_rows jsonb) returns void
language sql set search_path = public as $$
  insert into lum_pool_openings (commitment, sealed)
  select lower(r->>'commitment'), r->>'sealed' from jsonb_array_elements(p_rows) r
  on conflict (commitment) do nothing
$$;

create or replace function lum_pool_openings(p_commitments text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(commitment, sealed), '{}')
    from lum_pool_openings where commitment = any(select lower(c) from unnest(p_commitments) c)
$$;

-- Small operator caches (the commitment tree's frontier).
create table if not exists lum_pool_state (
  name text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table lum_pool_state enable row level security;

create or replace function lum_pool_get_state(p_name text) returns jsonb
language sql stable set search_path = public as $$
  select value from lum_pool_state where name = p_name
$$;

create or replace function lum_pool_put_state(p_name text, p_value jsonb) returns void
language sql set search_path = public as $$
  insert into lum_pool_state (name, value) values (p_name, p_value)
  on conflict (name) do update set value = excluded.value, updated_at = now()
$$;

-- Association roots the operator posted to the screening gate, with the label list each was built from (leaf order).
create table if not exists lum_pool_associations (
  root text primary key,
  labels jsonb not null,
  created_at timestamptz not null default now()
);
alter table lum_pool_associations enable row level security;

create or replace function lum_pool_deposit_labels() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('from', lower(args->>'from'), 'label', args->>'label') order by block, log_index), '[]')
    from lum_pool_events where name = 'Deposited'
$$;

create or replace function lum_pool_put_association(p_root text, p_labels jsonb) returns void
language sql set search_path = public as $$
  insert into lum_pool_associations (root, labels) values (lower(p_root), p_labels) on conflict (root) do nothing
$$;

create or replace function lum_pool_recent_associations(p_limit int default 8) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('root', root, 'labels', labels) order by created_at desc), '[]')
    from (select * from lum_pool_associations order by created_at desc limit p_limit) a
$$;

-- Settlement fee notes (owner FEE_OWNER), recorded before the settlement is sent, for the fee sweep.
create table if not exists lum_pool_fee_notes (
  commitment text primary key,
  quote text not null,
  auction_id bigint not null,
  amount numeric not null,
  spent boolean not null default false,
  created_at timestamptz not null default now()
);
alter table lum_pool_fee_notes enable row level security;

create or replace function lum_pool_put_fee_note(p_commitment text, p_quote text, p_auction_id bigint, p_amount numeric) returns void
language sql set search_path = public as $$
  insert into lum_pool_fee_notes (commitment, quote, auction_id, amount) values (lower(p_commitment), lower(p_quote), p_auction_id, p_amount)
  on conflict (commitment) do nothing
$$;

-- Unswept fee notes with their leaf index once committed (null before).
create or replace function lum_pool_fee_notes_indexed() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('commitment', f.commitment, 'quote', f.quote, 'auctionId', f.auction_id, 'amount', f.amount::text,
                                               'index', l.idx) order by f.auction_id), '[]')
    from lum_pool_fee_notes f
    left join lum_pool_leaf l on lower(l.commitment) = f.commitment
   where f.amount > 0 and not f.spent
$$;

create or replace function lum_pool_fee_notes_spent(p_commitments text[]) returns void
language sql set search_path = public as $$
  update lum_pool_fee_notes set spent = true where commitment = any(select lower(x) from unnest(p_commitments) x)
$$;

-- ---------------------------------------------------------------------------
revoke all on table lum_chain_cursor, lum_pool_events, lum_pool_leaf, lum_pool_openings, lum_pool_state, lum_pool_associations, lum_pool_fee_notes
  from public, anon, authenticated;
grant all on table lum_chain_cursor, lum_pool_events, lum_pool_leaf, lum_pool_openings, lum_pool_state, lum_pool_associations, lum_pool_fee_notes
  to service_role;
revoke execute on function lum_pool_leaf_from_event() from public, anon, authenticated;
revoke execute on function
  lum_get_cursor(text), lum_set_cursor(text, bigint), lum_init_cursor(text, bigint), lum_pool_record(jsonb, bigint),
  lum_pool_events(text[], bigint, int, int), lum_pool_leaves(bigint, int), lum_pool_leaf_stats(), lum_pool_open_auctions(),
  lum_pool_put_openings(jsonb), lum_pool_openings(text[]), lum_pool_get_state(text), lum_pool_put_state(text, jsonb),
  lum_pool_deposit_labels(), lum_pool_put_association(text, jsonb), lum_pool_recent_associations(int),
  lum_pool_put_fee_note(text, text, bigint, numeric), lum_pool_fee_notes_indexed(), lum_pool_fee_notes_spent(text[])
from public, anon, authenticated;
grant execute on function
  lum_get_cursor(text), lum_set_cursor(text, bigint), lum_init_cursor(text, bigint), lum_pool_record(jsonb, bigint),
  lum_pool_events(text[], bigint, int, int), lum_pool_leaves(bigint, int), lum_pool_leaf_stats(), lum_pool_open_auctions(),
  lum_pool_put_openings(jsonb), lum_pool_openings(text[]), lum_pool_get_state(text), lum_pool_put_state(text, jsonb),
  lum_pool_deposit_labels(), lum_pool_put_association(text, jsonb), lum_pool_recent_associations(int),
  lum_pool_put_fee_note(text, text, bigint, numeric), lum_pool_fee_notes_indexed(), lum_pool_fee_notes_spent(text[])
to service_role;
