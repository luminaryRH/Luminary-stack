-- Follow-ups from the 2026-10-16 rescore.
--
-- Relay claims are per spent note now (relay.ts). A claim whose transaction reverted or was replaced by a filler did
-- not spend its notes; lum_relay_forget drops it so the note can be relayed again (relay.ts checks the chain first).
create or replace function lum_relay_forget(p_client_id text) returns void
language sql set search_path = public as $$
  delete from lum_relays where client_id = p_client_id and status <> 'submitting'
$$;
revoke execute on function lum_relay_forget(text) from public, anon, authenticated;
grant execute on function lum_relay_forget(text) to service_role;

-- RFQ mailbox: posts are serialized, so concurrent posts cannot pass the limits together.
create or replace function lum_rfq_post(p_to_key text, p_from_pub text, p_ciphertext text, p_ttl_seconds int) returns bigint
language plpgsql set search_path = public as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('lum_rfq_post'));
  delete from lum_rfq_messages where expires_at < now();
  if (select count(*) from lum_rfq_messages where from_pub = lower(p_from_pub) and created_at > now() - interval '1 minute') >= 30
     or (select count(*) from lum_rfq_messages where created_at > now() - interval '1 minute') >= 600
     or (select count(*) from lum_rfq_messages where to_key = lower(p_to_key)) >= 200
     or (select count(*) from lum_rfq_messages) >= 50000 then
    return null;
  end if;
  insert into lum_rfq_messages (to_key, from_pub, ciphertext, expires_at)
  values (lower(p_to_key), lower(p_from_pub), p_ciphertext, now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 86400)))
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function lum_rfq_post(text, text, text, int) from public, anon, authenticated;
grant execute on function lum_rfq_post(text, text, text, int) to service_role;
