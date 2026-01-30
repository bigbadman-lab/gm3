select
  mint,
  swap_count,
  signal_touch_count,
  signal_points
from trending_items
where snapshot_id = '<6a91a587-7a16-424e-b42e-7a58dd5c66eb>'
order by signal_points desc nulls last, signal_touch_count desc nulls last;