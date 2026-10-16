-- Hardening from the 2026-10-16 audit.
--
-- RFQ mailbox: the sender's key is now proven by a signature (checked in src/routes/api/rfq.ts), and posting has
-- global limits on top of the per-key one, so fresh keys cannot fill the table or one inbox: at most 600 messages a
-- minute in total, 200 unexpired messages per inbox and 50,000 unexpired messages overall. A post over any limit
-- returns null (HTTP 429).

create or replace function lum_rfq_post(p_to_key text, p_from_pub text, p_ciphertext text, p_ttl_seconds int) returns bigint
language plpgsql set search_path = public as $$
declare
  v_id bigint;
begin
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

create index if not exists lum_rfq_messages_created on lum_rfq_messages (created_at);
