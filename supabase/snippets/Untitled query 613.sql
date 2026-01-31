select
  count(*) filter (where fdv_usd is not null) as with_fdv,
  count(*) as total,
  round(100.0 * count(*) filter (where fdv_usd is not null) / nullif(count(*),0), 2) as pct_with_fdv
from trending_items;
