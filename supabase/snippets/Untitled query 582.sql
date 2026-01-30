select
  mint,
  swap_count,
  unique_buyers,
  buy_ratio,
  net_sol_inflow,
  (unique_buyers >= 20) as pass_buyers,
  (buy_ratio >= 0.65) as pass_ratio,
  (net_sol_inflow >= 3) as pass_inflow,
  (swap_count >= 25) as pass_swaps
from trending_items
where snapshot_id = (
  select id
  from trending_snapshots
  order by created_at desc
  limit 1
)
order by
  (unique_buyers >= 20)::int +
  (buy_ratio >= 0.65)::int +
  (net_sol_inflow >= 3)::int +
  (swap_count >= 25)::int desc,
  swap_count desc;
