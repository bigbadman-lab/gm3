-- Fix view column order: drop and recreate so column list can change (CREATE OR REPLACE cannot rename/reorder columns).
drop view if exists public.trending_items_latest;

create view public.trending_items_latest as
select distinct on (mint)
  snapshot_id,
  rank,
  mint,
  swap_count,
  fdv_usd,
  signal_touch_count,
  signal_points,
  buy_count,
  sell_count,
  unique_buyers,
  net_sol_inflow,
  buy_ratio,
  is_qualified,
  inflow_band_ok,
  inflow_band_reason,
  inflow_score,
  is_alertworthy,
  updated_at,
  mc_floor_ok,
  mc_floor_reason,
  capital_efficiency,
  mc_structure_ok,
  mc_structure_reason
from public.trending_items
order by mint, updated_at desc;
