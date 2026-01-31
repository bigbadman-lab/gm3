create table if not exists public.mint_entries (
  mint text primary key,
  entry_ts timestamptz not null,
  entry_fdv_usd numeric not null,
  entry_net_sol_inflow numeric,
  created_at timestamptz default now()
);
