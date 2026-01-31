select
  mint,
  swap_count,
  unique_buyers,
  buy_ratio,
  net_sol_inflow,
  fdv_usd,
  updated_at
from trending_items
where is_qualified = true
  and fdv_usd is not null
order by updated_at desc
limit 50;
