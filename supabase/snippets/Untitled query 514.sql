alter table public.trending_items
  add column if not exists capital_efficiency numeric,
  add column if not exists mc_structure_ok boolean,
  add column if not exists mc_structure_reason text;
