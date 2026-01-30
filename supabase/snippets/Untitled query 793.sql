select
  mint,
  swap_count,
  unique_buyers,
  buy_ratio,
  net_sol_inflow,
  is_qualified,
  signal_touch_count,
  signal_points
from trending_items
where snapshot_id = '4c630a69-2365-425e-a902-77515b75997f'
order by
  is_qualified desc,
  signal_points desc,
  swap_count desc;
