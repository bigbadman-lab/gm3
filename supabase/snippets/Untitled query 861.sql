create table if not exists public.token_ath (
  mint text primary key references public.mint_entries(mint) on delete cascade,

  -- ATH since GM3 call
  ath_fdv_usd numeric,
  ath_ts timestamptz,

  -- optional but useful
  current_fdv_usd numeric,
  current_ts timestamptz,

  -- scheduling
  last_checked_ts timestamptz,
  next_check_ts timestamptz not null,
  status text not null default 'active', -- active | archived

  -- debug / audit
  source text default 'birdeye',
  updated_at timestamptz default now()
);

create index if not exists token_ath_next_check_idx
  on public.token_ath (status, next_check_ts);
