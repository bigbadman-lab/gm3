select
  mint,
  signal_touch_count,
  signal_points
from trending_items
order by signal_points desc nulls last, signal_touch_count desc nulls last
limit 30;
