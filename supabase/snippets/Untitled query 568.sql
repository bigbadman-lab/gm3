select mint, signal_touch_count, signal_points
from trending_items
where signal_touch_count > 0 or signal_points > 0
order by signal_points desc;
