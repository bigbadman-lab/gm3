select
  updated_at,
  mint,
  net_sol_inflow,
  inflow_band_reason,
  inflow_score,
  is_alertworthy
from public.trending_items
order by updated_at desc
limit 50;
