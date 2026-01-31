select
  count(*) filter (where fdv_usd is not null) as with_fdv,
  count(*) as total
from trending_items;
