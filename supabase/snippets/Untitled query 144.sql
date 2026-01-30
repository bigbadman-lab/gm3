select
  count(*) as total_mints,
  sum(case when is_qualified then 1 else 0 end) as qualified_mints,
  sum(coalesce(signal_touch_count,0)) as total_signal_touches
from trending_items
where snapshot_id = '4c630a69-2365-425e-a902-77515b75997f';
