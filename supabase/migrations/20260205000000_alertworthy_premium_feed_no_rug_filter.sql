-- Option 3: alertworthy feed includes high buy_ratio mints; rug warning is exposed in API (rug_risk, rug_risk_reason).
-- This migration ensures layer_alertworthy_premium_feed exists and does NOT filter out rows by buy_ratio.
-- If prod already has this function with a "BUY RATIO RUG FILTER" (e.g. AND (total_trades < 15 OR buy_ratio <= 0.70)),
-- you can either: (1) run this migration to replace with this implementation (single latest snapshot in lookback), or
-- (2) manually edit the function in prod to only remove that AND clause and keep the rest of the body unchanged.

create or replace function public.layer_alertworthy_premium_feed(
  p_window_seconds int,
  p_lookback_time text default '06:00:00',
  p_limit int default 25
)
returns table (
  snapshot_id uuid,
  rank int,
  mint text,
  swap_count int,
  fdv_usd numeric,
  signal_touch_count int,
  signal_points int,
  buy_count int,
  sell_count int,
  unique_buyers int,
  net_sol_inflow numeric,
  buy_ratio numeric,
  is_qualified boolean,
  inflow_band_ok boolean,
  inflow_band_reason text,
  inflow_score numeric,
  is_alertworthy boolean,
  updated_at timestamptz,
  mc_floor_ok boolean,
  mc_floor_reason text,
  capital_efficiency numeric,
  mc_structure_ok boolean,
  mc_structure_reason text
)
language sql
security definer
set search_path = public
stable
as $$
  with lookback_cutoff as (
    select (now() - (p_lookback_time::interval)) as cutoff
  ),
  latest_in_lookback as (
    select id, window_end
    from public.trending_snapshots
    where window_seconds = p_window_seconds
      and window_end >= (select cutoff from lookback_cutoff)
    order by window_end desc
    limit 1
  ),
  alertworthy_in_latest as (
    select ti.snapshot_id, ti.rank, ti.mint, ti.swap_count, ti.fdv_usd,
           ti.signal_touch_count, ti.signal_points, ti.buy_count, ti.sell_count,
           ti.unique_buyers, ti.net_sol_inflow, ti.buy_ratio, ti.is_qualified,
           ti.inflow_band_ok, ti.inflow_band_reason, ti.inflow_score,
           ti.is_alertworthy, ti.updated_at, ti.mc_floor_ok, ti.mc_floor_reason,
           ti.capital_efficiency, ti.mc_structure_ok, ti.mc_structure_reason
    from public.trending_items ti
    where ti.snapshot_id = (select id from latest_in_lookback)
      and ti.is_alertworthy = true
    order by ti.rank
    limit p_limit
  )
  select
    snapshot_id, rank, mint, swap_count, fdv_usd,
    signal_touch_count, signal_points, buy_count, sell_count,
    unique_buyers, net_sol_inflow, buy_ratio, is_qualified,
    inflow_band_ok, inflow_band_reason, inflow_score,
    is_alertworthy, updated_at, mc_floor_ok, mc_floor_reason,
    capital_efficiency, mc_structure_ok, mc_structure_reason
  from alertworthy_in_latest;
$$;

-- Optional: wire v_layer_alertworthy_60 to premium feed (6h lookback, limit 25). Uncomment if your deployment uses premium feed for this view.
-- drop view if exists public.v_layer_alertworthy_60 cascade;
-- create view public.v_layer_alertworthy_60 as
-- select * from public.layer_alertworthy_premium_feed(60, '06:00:00', 25);
-- grant select on public.v_layer_alertworthy_60 to anon, authenticated;
