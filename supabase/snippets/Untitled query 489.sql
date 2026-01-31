select
  count(*) as total_latest,
  count(*) filter (where inflow_band_reason='ok') as ok_inflow_band,
  count(*) filter (where mc_structure_ok) as ok_mc_structure,
  count(*) filter (where is_alertworthy) as alertworthy
from public.trending_items_latest;
