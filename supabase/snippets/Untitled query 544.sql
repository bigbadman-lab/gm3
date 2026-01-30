select
  buy_count,
  sell_count,
  unique_buyers,
  net_sol_inflow,
  buy_ratio,
  time_to_25_swaps_seconds,
  top_buyer_share,
  repeat_buyer_ratio,
  is_qualified
from trending_items
limit 1;
