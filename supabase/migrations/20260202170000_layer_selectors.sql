-- Parameterized layer selectors for GM3: qualified, alertworthy (two consecutive snapshots), investable.
-- Uses trending_snapshots.window_end as discrete window key. Latest snapshot = MAX(window_end) for window_seconds.
-- Two consecutive = latest two snapshot IDs ordered by window_end DESC LIMIT 2.

-- Return type matches public.trending_items_latest columns (no price_usd, total_supply).
create or replace function public.layer_qualified(p_window_seconds int)
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
  select
    ti.snapshot_id,
    ti.rank,
    ti.mint,
    ti.swap_count,
    ti.fdv_usd,
    ti.signal_touch_count,
    ti.signal_points,
    ti.buy_count,
    ti.sell_count,
    ti.unique_buyers,
    ti.net_sol_inflow,
    ti.buy_ratio,
    ti.is_qualified,
    ti.inflow_band_ok,
    ti.inflow_band_reason,
    ti.inflow_score,
    ti.is_alertworthy,
    ti.updated_at,
    ti.mc_floor_ok,
    ti.mc_floor_reason,
    ti.capital_efficiency,
    ti.mc_structure_ok,
    ti.mc_structure_reason
  from public.trending_items ti
  join public.trending_snapshots ts on ts.id = ti.snapshot_id
  where ts.window_seconds = p_window_seconds
    and ts.window_end = (select max(s.window_end) from public.trending_snapshots s where s.window_seconds = p_window_seconds)
    and ti.is_qualified = true;
$$;

-- Alertworthy in the latest two consecutive snapshots for that window_seconds.
create or replace function public.layer_alertworthy(p_window_seconds int)
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
  with latest_two as (
    select id, window_end
    from public.trending_snapshots
    where window_seconds = p_window_seconds
    order by window_end desc
    limit 2
  ),
  alertworthy_in_both as (
    select ti.mint
    from public.trending_items ti
    where ti.snapshot_id in (select id from latest_two)
      and ti.is_alertworthy = true
    group by ti.mint
    having count(distinct ti.snapshot_id) = 2
  ),
  latest_snapshot_id as (
    select id from latest_two order by window_end desc limit 1
  )
  select
    ti.snapshot_id,
    ti.rank,
    ti.mint,
    ti.swap_count,
    ti.fdv_usd,
    ti.signal_touch_count,
    ti.signal_points,
    ti.buy_count,
    ti.sell_count,
    ti.unique_buyers,
    ti.net_sol_inflow,
    ti.buy_ratio,
    ti.is_qualified,
    ti.inflow_band_ok,
    ti.inflow_band_reason,
    ti.inflow_score,
    ti.is_alertworthy,
    ti.updated_at,
    ti.mc_floor_ok,
    ti.mc_floor_reason,
    ti.capital_efficiency,
    ti.mc_structure_ok,
    ti.mc_structure_reason
  from public.trending_items ti
  join alertworthy_in_both a on a.mint = ti.mint
  where ti.snapshot_id = (select id from latest_snapshot_id);
$$;

-- Investable: layer_alertworthy + unique_buyers > 25 + mint_entries.entry_fdv_usd > 15000
create or replace function public.layer_investable(p_window_seconds int)
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
  with latest_two as (
    select id, window_end
    from public.trending_snapshots
    where window_seconds = p_window_seconds
    order by window_end desc
    limit 2
  ),
  alertworthy_in_both as (
    select ti.mint
    from public.trending_items ti
    where ti.snapshot_id in (select id from latest_two)
      and ti.is_alertworthy = true
    group by ti.mint
    having count(distinct ti.snapshot_id) = 2
  ),
  latest_snapshot_id as (
    select id from latest_two order by window_end desc limit 1
  )
  select
    ti.snapshot_id,
    ti.rank,
    ti.mint,
    ti.swap_count,
    ti.fdv_usd,
    ti.signal_touch_count,
    ti.signal_points,
    ti.buy_count,
    ti.sell_count,
    ti.unique_buyers,
    ti.net_sol_inflow,
    ti.buy_ratio,
    ti.is_qualified,
    ti.inflow_band_ok,
    ti.inflow_band_reason,
    ti.inflow_score,
    ti.is_alertworthy,
    ti.updated_at,
    ti.mc_floor_ok,
    ti.mc_floor_reason,
    ti.capital_efficiency,
    ti.mc_structure_ok,
    ti.mc_structure_reason
  from public.trending_items ti
  join alertworthy_in_both a on a.mint = ti.mint
  join public.mint_entries me on me.mint = ti.mint and me.entry_fdv_usd > 15000
  where ti.snapshot_id = (select id from latest_snapshot_id)
    and ti.unique_buyers > 25;
$$;

-- Convenience views: _60 (paid), _600 and _900 (free)
create or replace view public.v_layer_qualified_60 as select * from public.layer_qualified(60);
create or replace view public.v_layer_alertworthy_60 as select * from public.layer_alertworthy(60);
create or replace view public.v_layer_investable_60 as select * from public.layer_investable(60);

create or replace view public.v_layer_qualified_600 as select * from public.layer_qualified(600);
create or replace view public.v_layer_alertworthy_600 as select * from public.layer_alertworthy(600);
create or replace view public.v_layer_investable_600 as select * from public.layer_investable(600);

create or replace view public.v_layer_qualified_900 as select * from public.layer_qualified(900);
create or replace view public.v_layer_alertworthy_900 as select * from public.layer_alertworthy(900);
create or replace view public.v_layer_investable_900 as select * from public.layer_investable(900);

-- Grants: readable by anon and authenticated
grant select on public.v_layer_qualified_60 to anon, authenticated;
grant select on public.v_layer_alertworthy_60 to anon, authenticated;
grant select on public.v_layer_investable_60 to anon, authenticated;
grant select on public.v_layer_qualified_600 to anon, authenticated;
grant select on public.v_layer_alertworthy_600 to anon, authenticated;
grant select on public.v_layer_investable_600 to anon, authenticated;
grant select on public.v_layer_qualified_900 to anon, authenticated;
grant select on public.v_layer_alertworthy_900 to anon, authenticated;
grant select on public.v_layer_investable_900 to anon, authenticated;
