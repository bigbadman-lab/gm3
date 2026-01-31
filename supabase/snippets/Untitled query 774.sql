select
  mint,
  is_alertworthy,
  inflow_score,
  net_sol_inflow,
  inflow_band_reason,
  fdv_usd,
  updated_at
from public.trending_items_latest
order by
  is_alertworthy desc,
  inflow_score desc nulls last,
  net_sol_inflow desc nulls last,
  updated_at desc
limit 50;
