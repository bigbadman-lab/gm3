select
  count(*) as signaled_rows
from trending_items
where coalesce(signal_touch_count, 0) > 0
   or coalesce(signal_points, 0) > 0;
