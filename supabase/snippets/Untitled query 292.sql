select
  mint,
  net_sol_inflow,
  fdv_usd,
  capital_efficiency,
  mc_structure_reason,
  swap_count,
  unique_buyers,
  buy_ratio,
  updated_at
from public.trending_items_latest
where is_alertworthy = true
order by fdv_usd desc, net_sol_inflow desc, updated_at desc;
