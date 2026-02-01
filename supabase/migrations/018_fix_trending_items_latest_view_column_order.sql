-- Fix view column order: preserve exact order from 013, append new columns at the end.
-- CREATE OR REPLACE VIEW is positional; 014/015 inserted columns before updated_at and broke the view.

create or replace view public.trending_items_latest as
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
