select
  (select count(*) from public.trending_items_latest) as latest_rows,
  (select count(distinct mint) from public.trending_items) as distinct_mints_in_table;
