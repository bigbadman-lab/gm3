-- GM3: API keys (hashed) for terminal + iOS auth
-- Stores only SHA-256 hashes, supports revoke + expiry.
-- RLS enabled to prevent any client reads.

create extension if not exists pgcrypto;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,   -- sha256 hex of the plaintext key
  prefix text not null,            -- short prefix for display/revoke
  name text,
  tier text not null default 'paid',
  user_id uuid null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  expires_at timestamptz null
);

create index if not exists api_keys_active_idx
  on public.api_keys (revoked_at, expires_at);

alter table public.api_keys enable row level security;

-- Create a new API key and return the plaintext ONCE (server-side only)
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
  v_hash := encode(digest(v_raw, 'sha256'), 'hex');

  insert into public.api_keys (key_hash, prefix, name, tier, expires_at)
  values (v_hash, v_prefix, p_name, p_tier, p_expires_at);

  return query
    select v_raw, v_prefix, p_tier, p_expires_at;
end;
$$;

-- Revoke by prefix (server-side only)
create or replace function public.revoke_api_key_by_prefix(p_prefix text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.api_keys
  set revoked_at = now()
  where prefix = p_prefix and revoked_at is null;
$$;

-- IMPORTANT: do not allow public execution
revoke all on function public.create_api_key(text,text,timestamptz) from public;
revoke all on function public.revoke_api_key_by_prefix(text) from public;
