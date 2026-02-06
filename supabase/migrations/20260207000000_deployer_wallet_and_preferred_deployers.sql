-- Deployer wallet and alpha_wallets for alertworthy (Option A).
-- token_cache.deployer_wallet: populated by backfill; used to match alpha_wallets.
-- alpha_wallets: allowlist of "alpha" deployer wallets; the system filters for mints whose deployer is in this list (runner path = alertworthy).

alter table public.token_cache
  add column if not exists deployer_wallet text;

create index if not exists idx_token_cache_deployer_wallet
  on public.token_cache (deployer_wallet)
  where deployer_wallet is not null;

create table if not exists public.alpha_wallets (
  wallet text primary key,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  label text
);

comment on table public.alpha_wallets is 'Alpha deployer wallets; mints from these are treated as alertworthy and included in the paid feed (runner path).';

grant select on public.alpha_wallets to anon, authenticated;
