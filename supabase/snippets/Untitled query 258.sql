select column_name, data_type
from information_schema.columns
where table_name = 'trending_items'
  and column_name in ('inflow_band_ok','inflow_band_reason','inflow_score','is_alertworthy');
