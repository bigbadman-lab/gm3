select
  mint,
  net_sol_inflow,
  fdv_usd,
  swap_count,
  unique_buyers,
  buy_ratio,
  updated_at
from public.trending_items_latest
where is_alertworthy = true
order by net_sol_inflow desc, fdv_usd desc, updated_at desc;
