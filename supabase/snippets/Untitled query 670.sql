select
  count(*) as total_mints,
  sum(case when is_qualified then 1 else 0 end) as qualified_mints
from trending_items
where snapshot_id = (
  select id
  from trending_snapshots
  order by created_at desc
  limit 1
);
