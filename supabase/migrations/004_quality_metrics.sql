-- 004_quality_metrics.sql
-- Adds creator-agnostic quality metrics for pump.fun tokens
-- Used for hard filters (qualification) + soft ranking signals.

alter table public.trending_items
  add column if not exists buy_count integer not null default 0,
  add column if not exists sell_count integer not null default 0,
  add column if not exists unique_buyers integer not null default 0,
  add column if not exists net_sol_inflow numeric not null default 0,
  add column if not exists buy_ratio numeric not null default 0,
  add column if not exists time_to_25_swaps_seconds integer,
  add column if not exists top_buyer_share numeric not null default 0,
  add column if not exists repeat_buyer_ratio numeric not null default 0,
  add column if not exists is_qualified boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trending_items_buy_ratio_range'
  ) then
    alter table public.trending_items
      add constraint trending_items_buy_ratio_range
      check (buy_ratio >= 0 and buy_ratio <= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'trending_items_top_buyer_share_range'
  ) then
    alter table public.trending_items
      add constraint trending_items_top_buyer_share_range
      check (top_buyer_share >= 0 and top_buyer_share <= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'trending_items_repeat_buyer_ratio_range'
  ) then
    alter table public.trending_items
      add constraint trending_items_repeat_buyer_ratio_range
      check (repeat_buyer_ratio >= 0 and repeat_buyer_ratio <= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'trending_items_nonnegative_counts'
  ) then
    alter table public.trending_items
      add constraint trending_items_nonnegative_counts
      check (
        buy_count >= 0 and
        sell_count >= 0 and
        unique_buyers >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'trending_items_nonnegative_inflow'
  ) then
    alter table public.trending_items
      add constraint trending_items_nonnegative_inflow
      check (net_sol_inflow >= 0);
  end if;
end $$;

create index if not exists trending_items_snapshot_qualified_idx
  on public.trending_items (snapshot_id, is_qualified);

create index if not exists trending_items_snapshot_signal_points_idx
  on public.trending_items (snapshot_id, signal_points desc);

create index if not exists trending_items_snapshot_swap_count_idx
  on public.trending_items (snapshot_id, swap_count desc);
