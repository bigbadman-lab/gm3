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
where snapshot_id = (
  select id
  from trending_snapshots
  order by created_at desc
  limit 1
)
order by swap_count desc;
