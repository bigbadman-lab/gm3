select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trending_items'
      and column_name = 'mc_floor_reason'
  ) as mc_floor_reason_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trending_items'
      and column_name = 'mc_floor_ok'
  ) as mc_floor_ok_exists;
