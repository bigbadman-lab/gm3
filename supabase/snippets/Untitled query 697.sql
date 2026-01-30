select
  mint,
  swap_count,
  volume_sol
from trending_items
where snapshot_id = '<PASTE_SNAPSHOT_ID_HERE>'
order by swap_count desc;
