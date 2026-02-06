-- Free qualified feed: use latest 60s snapshot that has at least one qualified item,
-- so the API returns data even when the very latest minute has 0 items (e.g. ingest lag).

-- Return type matches layer_qualified (same columns as trending_items for feed).
create or replace function public.free_qualified_feed()
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
  with snap_with_qualified as (
    select ts.id, ts.window_end
    from public.trending_snapshots ts
    join public.trending_items ti on ti.snapshot_id = ts.id and ti.is_qualified = true
    where ts.window_seconds = 60
    group by ts.id, ts.window_end
  ),
  latest_with_data as (
    select id from snap_with_qualified order by window_end desc limit 1
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
  where ti.snapshot_id = (select id from latest_with_data)
    and ti.is_qualified = true
  order by ti.rank;
$$;

-- Meta: one row with window_end and count for the snapshot used by free_qualified_feed.
create or replace function public.free_qualified_feed_meta()
returns table (
  window_end timestamptz,
  item_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with snap_with_qualified as (
    select ts.id, ts.window_end
    from public.trending_snapshots ts
    join public.trending_items ti on ti.snapshot_id = ts.id and ti.is_qualified = true
    where ts.window_seconds = 60
    group by ts.id, ts.window_end
  ),
  latest_with_data as (
    select id, window_end from snap_with_qualified order by window_end desc limit 1
  )
  select
    l.window_end,
    count(ti.mint)::bigint
  from latest_with_data l
  left join public.trending_items ti on ti.snapshot_id = l.id and ti.is_qualified = true
  group by l.window_end;
$$;

grant execute on function public.free_qualified_feed() to anon, authenticated;
grant execute on function public.free_qualified_feed_meta() to anon, authenticated;
