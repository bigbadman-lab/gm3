select
  count(*) as total_mints,
  sum(case when is_qualified then 1 else 0 end) as qualified_mints,
  sum(coalesce(signal_touch_count, 0)) as total_signal_touches
from trending_items
where snapshot_id = 'f53c5fad-b7d3-4730-8597-d28b0aa3f8c7';
