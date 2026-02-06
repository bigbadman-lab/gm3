-- Rename preferred_deployers to alpha_wallets for existing DBs (fresh installs create alpha_wallets in 000000).
-- alpha_wallets = allowlist the system filters against: if a mint's deployer is in this list, it is alertworthy (runner path).

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'preferred_deployers') then
    alter table public.preferred_deployers rename to alpha_wallets;
  end if;
end $$;

comment on table public.alpha_wallets is 'Alpha deployer wallets; mints from these wallets are treated as alertworthy and included in the paid feed (runner path).';

grant select on public.alpha_wallets to anon, authenticated;

-- Layer function must reference alpha_wallets (table was renamed from preferred_deployers)
create or replace function public.layer_alertworthy_with_runners(p_window_seconds int)
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
  mc_structure_reason text,
  in_feed_reason text,
  deployer_wallet text
)
language sql
security definer
set search_path = public
stable
as $$
  with latest_two as (
    select id, window_end from public.trending_snapshots
    where window_seconds = p_window_seconds
    order by window_end desc limit 2
  ),
  latest_snapshot_id as (select id from latest_two order by window_end desc limit 1),
  alertworthy_in_both as (
    select ti.mint from public.trending_items ti
    where ti.snapshot_id in (select id from latest_two) and ti.is_alertworthy = true
    group by ti.mint having count(distinct ti.snapshot_id) = 2
  ),
  strict_rows as (
    select ti.snapshot_id, ti.rank, ti.mint, ti.swap_count, ti.fdv_usd, ti.signal_touch_count, ti.signal_points,
      ti.buy_count, ti.sell_count, ti.unique_buyers, ti.net_sol_inflow, ti.buy_ratio, ti.is_qualified,
      ti.inflow_band_ok, ti.inflow_band_reason, ti.inflow_score, ti.is_alertworthy, ti.updated_at,
      ti.mc_floor_ok, ti.mc_floor_reason, ti.capital_efficiency, ti.mc_structure_ok, ti.mc_structure_reason,
      'alertworthy'::text as in_feed_reason, tc.deployer_wallet
    from public.trending_items ti
    join alertworthy_in_both a on a.mint = ti.mint
    left join public.token_cache tc on tc.mint = ti.mint
    where ti.snapshot_id = (select id from latest_snapshot_id)
  ),
  runner_rows as (
    select ti.snapshot_id, ti.rank, ti.mint, ti.swap_count, ti.fdv_usd, ti.signal_touch_count, ti.signal_points,
      ti.buy_count, ti.sell_count, ti.unique_buyers, ti.net_sol_inflow, ti.buy_ratio, ti.is_qualified,
      ti.inflow_band_ok, ti.inflow_band_reason, ti.inflow_score, ti.is_alertworthy, ti.updated_at,
      ti.mc_floor_ok, ti.mc_floor_reason, ti.capital_efficiency, ti.mc_structure_ok, ti.mc_structure_reason,
      'runner'::text as in_feed_reason, tc.deployer_wallet
    from public.trending_items ti
    join public.token_cache tc on tc.mint = ti.mint and tc.deployer_wallet is not null
    join public.alpha_wallets aw on aw.wallet = tc.deployer_wallet and aw.is_active = true
    where ti.snapshot_id = (select id from latest_snapshot_id)
      and ti.is_qualified = true and ti.net_sol_inflow between 5 and 100 and ti.mc_structure_ok = true
      and ti.mint not in (select mint from strict_rows)
  )
  select * from strict_rows union all select * from runner_rows;
$$;
