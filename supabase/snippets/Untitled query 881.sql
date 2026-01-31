select exists (
  select 1
  from information_schema.views
  where table_schema='public'
    and table_name='trending_items_latest'
) as view_exists;
