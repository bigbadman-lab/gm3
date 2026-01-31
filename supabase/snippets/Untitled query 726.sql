select
  count(*) as latest_rows,
  count(*) filter (where mc_structure_ok is null) as mc_structure_null,
  count(*) filter (where capital_efficiency is null) as eff_null,
  count(*) filter (where mc_structure_reason is null) as reason_null
from public.trending_items_latest;
