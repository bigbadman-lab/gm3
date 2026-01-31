select
  count(*) as total_latest,
  count(*) filter (where is_alertworthy) as alertworthy,
  count(*) filter (where inflow_band_reason='too_low') as too_low,
  count(*) filter (where inflow_band_reason='too_high') as too_high,
  count(*) filter (where inflow_band_reason='ok') as ok_band
from public.trending_items_latest;
