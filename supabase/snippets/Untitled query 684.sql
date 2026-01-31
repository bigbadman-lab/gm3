select
  inflow_band_reason,
  is_qualified,
  count(*) as n
from public.trending_items_latest
group by inflow_band_reason, is_qualified
order by inflow_band_reason, is_qualified desc;
