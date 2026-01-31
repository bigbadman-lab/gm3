select
  mint,
  net_sol_inflow,
  inflow_score,
  fdv_usd,
  swap_count,
  unique_buyers,
  buy_ratio,
  updated_at
from public.trending_items_latest
where is_alertworthy = true
order by inflow_score desc, net_sol_inflow desc, updated_at desc;
