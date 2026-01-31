select
  count(*) as rows_in_view,
  (select count(distinct mint) from public.trending_items) as distinct_mints
from public.trending_items_latest;
