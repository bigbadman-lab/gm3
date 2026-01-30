select
  mint,
  swap_count,
  signal_touch_count,
  signal_points
from trending_items
where snapshot_id = '867ee999-03c9-42a2-a657-f73aca757a11'
order by
  signal_points desc nulls last,
  signal_touch_count desc nulls last,
  swap_count desc;
