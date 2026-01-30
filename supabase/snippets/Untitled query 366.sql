select
  mint,
  swap_count,
  unique_buyers,
  buy_ratio,
  net_sol_inflow,
  signal_touch_count,
  signal_points,
  last_price_sol
from trending_items
where snapshot_id = 'f53c5fad-b7d3-4730-8597-d28b0aa3f8c7'
  and is_qualified = true
order by
  signal_points desc,
  swap_count desc;
