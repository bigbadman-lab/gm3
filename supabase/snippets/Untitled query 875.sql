select
  mint,
  swap_count,
  signal_touch_count,
  signal_points
from trending_items
where snapshot_id = (
  select id
  from trending_snapshots
  order by created_at desc
  limit 1
)
and coalesce(signal_touch_count,0) > 0
order by signal_points desc, signal_touch_count desc;
