-- AuctionPool reuses a cancelled slot for the next order (audit fix, 2026-10-16), so a slot can hold a cancelled order
-- and then a live one. OrderReclaimed now carries the order commitment: an order is left out of the open auction only
-- when its own commitment was cancelled, not when some earlier order in its slot was.

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
                                   and lower(x.args->>'commitment') = lower(r.args->>'commitment')
                                   and (x.args->>'cancelled')::boolean)), '[]'))
         order by o.call_time, o.id), '[]')
    from open o
    left join lateral (select args from lum_pool_events p
                        where p.name = 'AuctionPinned' and (p.args->>'id')::bigint = o.id limit 1) p on true
$$;

revoke execute on function lum_pool_open_auctions() from public, anon, authenticated;
grant execute on function lum_pool_open_auctions() to service_role;
