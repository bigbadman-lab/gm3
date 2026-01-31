insert into public.mint_entries (mint, entry_ts, entry_fdv_usd, entry_net_sol_inflow)
select
  mint,
  updated_at as entry_ts,
  fdv_usd as entry_fdv_usd,
  net_sol_inflow
from public.trending_items_latest
where is_alertworthy is true
on conflict (mint) do nothing;
