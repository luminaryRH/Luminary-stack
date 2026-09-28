-- Luminary threshold sealing committee and sealed RFQ intent exchange. Re-runnable.

-- Committee members' partial decryptions of sealed orders, verified by the operator before they are stored. A partial
-- reveals nothing on its own; `threshold` of them open one order.
create table if not exists lum_pool_partials (
  sealed_hash text not null, -- keccak256 of the ciphertext
  member int not null,
  partial jsonb not null,
  created_at timestamptz not null default now(),
  primary key (sealed_hash, member)
);
alter table lum_pool_partials enable row level security;

-- p_rows: [{sealed_hash, member, partial}]; returns how many were new.
create or replace function lum_pool_put_partials(p_rows jsonb) returns int
language plpgsql set search_path = public as $$
declare
  v_inserted int;
begin
  insert into lum_pool_partials (sealed_hash, member, partial)
  select lower(r->>'sealed_hash'), (r->>'member')::int, r->'partial' from jsonb_array_elements(p_rows) r
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

-- {sealed_hash: [partial, …]} for the given ciphertext hashes.
create or replace function lum_pool_partials_for(p_hashes text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(sealed_hash, partials), '{}')
    from (select sealed_hash, jsonb_agg(partial order by member) partials
            from lum_pool_partials
           where sealed_hash = any(select lower(h) from unnest(p_hashes) h)
           group by sealed_hash) p
$$;

revoke execute on function lum_pool_put_partials(jsonb), lum_pool_partials_for(text[]) from public, anon, authenticated;
grant execute on function lum_pool_put_partials(jsonb), lum_pool_partials_for(text[]) to service_role;

-- Sealed RFQ intents: two counterparties agree a block off-venue by trading messages sealed to each other's session
-- keys. The operator stores ciphertext addressed to a key hash and never reads it. Messages expire; posting is
-- rate-limited per sender key.

create table if not exists lum_rfq_messages (
  id bigserial primary key,
  to_key text not null, -- keccak256 of the recipient's compressed session public key
  from_pub text not null, -- the sender's compressed session public key (so the recipient can answer)
  ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists lum_rfq_messages_inbox on lum_rfq_messages (to_key, id);
alter table lum_rfq_messages enable row level security;

-- Returns the new id, or null when the sender posted too much in the last minute. Expired messages are dropped here.
create or replace function lum_rfq_post(p_to_key text, p_from_pub text, p_ciphertext text, p_ttl_seconds int) returns bigint
language plpgsql set search_path = public as $$
declare
  v_id bigint;
begin
  delete from lum_rfq_messages where expires_at < now();
  if (select count(*) from lum_rfq_messages where from_pub = lower(p_from_pub) and created_at > now() - interval '1 minute') >= 30 then
    return null;
  end if;
  insert into lum_rfq_messages (to_key, from_pub, ciphertext, expires_at)
  values (lower(p_to_key), lower(p_from_pub), p_ciphertext, now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 86400)))
  returning id into v_id;
  return v_id;
end $$;

-- Unexpired messages to a key hash after an id, oldest first.
create or replace function lum_rfq_inbox(p_to_key text, p_after_id bigint default 0) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'from', from_pub, 'ciphertext', ciphertext, 'expiresAt', expires_at) order by id), '[]')
    from (select * from lum_rfq_messages
           where to_key = lower(p_to_key) and id > p_after_id and expires_at > now()
           order by id limit 200) m
$$;

revoke execute on function lum_rfq_post(text, text, text, int), lum_rfq_inbox(text, bigint) from public, anon, authenticated;
grant execute on function lum_rfq_post(text, text, text, int), lum_rfq_inbox(text, bigint) to service_role;

revoke all on table lum_pool_partials, lum_rfq_messages from public, anon, authenticated;
grant all on table lum_pool_partials, lum_rfq_messages to service_role;
