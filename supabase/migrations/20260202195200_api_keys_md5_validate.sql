-- Gateway delegates hashing to Postgres (md5). New keys use md5; validate by plaintext.

-- Validate API key by plaintext: md5(plaintext) = key_hash, update last_used_at, return tier/prefix.
create or replace function public.validate_api_key(p_plaintext text)
returns table (tier text, prefix text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.api_keys k
  set last_used_at = now()
  where k.key_hash = md5(p_plaintext)
    and k.revoked_at is null
    and (k.expires_at is null or k.expires_at > now())
  returning k.tier, k.prefix;
end;
$$;

-- New keys: store md5 hex so validate_api_key (md5) matches.
create or replace function public.create_api_key(
  p_name text default null,
  p_tier text default 'paid',
  p_expires_at timestamptz default null
)
returns table (
  api_key text,
  prefix text,
  tier text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw text;
  v_prefix text;
  v_hash text;
begin
  v_raw := 'gm3_live_' || encode(gen_random_bytes(24), 'hex');
  v_prefix := left(v_raw, 14);
  v_hash := md5(v_raw);

  insert into public.api_keys (key_hash, prefix, name, tier, expires_at)
  values (v_hash, v_prefix, p_name, p_tier, p_expires_at);

  return query
    select v_raw, v_prefix, p_tier, p_expires_at;
end;
$$;
