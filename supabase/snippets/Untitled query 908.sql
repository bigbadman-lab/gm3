-- 008_api_keys.sql
-- API key access model: trial (7 days) + paid tiers.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),

  -- Store ONLY a hash of the key (never plaintext).
  key_hash text not null unique,

  -- trial | basic | unlimited
  tier text not null,

  -- For trial keys; null for paid keys.
  trial_expires_at timestamptz null,

  active boolean not null default true,

  -- Optional: bind to payer wallet (or last known wallet) for auditing.
  wallet_address text null,

  created_at timestamptz not null default now(),
  last_used_at timestamptz null
);

-- Simple, explicit tier constraint
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_keys_tier_check'
  ) then
    alter table public.api_keys
      add constraint api_keys_tier_check
      check (tier in ('trial', 'basic', 'unlimited'));
  end if;
end $$;

-- Helpful indexes
create index if not exists api_keys_active_idx
  on public.api_keys (active);

create index if not exists api_keys_tier_idx
  on public.api_keys (tier);

create index if not exists api_keys_trial_expires_idx
  on public.api_keys (trial_expires_at);

create index if not exists api_keys_last_used_idx
  on public.api_keys (last_used_at desc);
