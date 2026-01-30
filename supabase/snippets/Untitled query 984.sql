select
  mint,
  swap_count,
  buy_count,
  sell_count,
  unique_buyers,
  net_sol_inflow,
  buy_ratio,
  is_qualified
from trending_items
where snapshot_id = '9f4773a5-14a8-4e46-ada0-dd373527aa02'
order by swap_count desc;
