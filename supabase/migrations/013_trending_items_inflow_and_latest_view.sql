-- Add inflow/alert columns to trending_items (for v1/today response)
alter table public.trending_items
  add column if not exists inflow_band_ok boolean,
  add column if not exists inflow_band_reason text,
  add column if not exists inflow_score numeric,
  add column if not exists is_alertworthy boolean;

-- View: one row per mint, the row with the latest updated_at
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
  updated_at
from public.trending_items
order by mint, updated_at desc;
