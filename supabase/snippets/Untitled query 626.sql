select
  count(*) as total_mints,
  sum(case when coalesce(signal_touch_count,0) > 0 then 1 else 0 end) as mints_with_signal,
  sum(coalesce(signal_touch_count,0)) as total_signal_touches,
  sum(coalesce(signal_points,0)) as total_signal_points
from trending_items
where snapshot_id = '7d01da80-df4c-47f6-b9ba-cefe6b09728f';
