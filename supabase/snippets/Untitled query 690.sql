alter table public.trending_items
  add column if not exists mc_floor_ok boolean,
  add column if not exists mc_floor_reason text;
