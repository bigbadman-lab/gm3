-- Promo code redemption for POST /v1/auth/mint/promo
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  tier text not null default 'investable',
  duration_days integer not null default 30,
  used boolean not null default false,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_promo_codes_code on public.promo_codes (code);
create index if not exists idx_promo_codes_used on public.promo_codes (used);

comment on table public.promo_codes is 'One-time promo codes for minting gm3_sess_* access tokens via POST /v1/auth/mint/promo';
