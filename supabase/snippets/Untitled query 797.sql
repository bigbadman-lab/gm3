select
  is_qualified,
  inflow_band_reason,
  mc_structure_ok,
  count(*) as n
from public.trending_items_latest
group by is_qualified, inflow_band_reason, mc_structure_ok
order by mc_structure_ok desc, inflow_band_reason, is_qualified desc;
