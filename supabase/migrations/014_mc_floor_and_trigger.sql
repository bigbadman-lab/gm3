-- Market-cap floor: fdv_usd < 10000 treated as likely sniped/noise; not alertworthy.

-- 1) Add columns
alter table public.trending_items
  add column if not exists mc_floor_ok boolean,
  add column if not exists mc_floor_reason text;

-- 2) Backfill existing rows
update public.trending_items
set
  mc_floor_ok = case
    when fdv_usd is null then null
    else (fdv_usd >= 10000)
  end,
  mc_floor_reason = case
    when fdv_usd is null then 'missing'
    when fdv_usd < 10000 then 'too_low'
    else 'ok'
  end,
  is_alertworthy = (
    is_qualified is true
    and net_sol_inflow between 20 and 70
    and fdv_usd is not null
    and fdv_usd >= 10000
  )
where true;

-- 3) Trigger function: inflow band + MC floor + is_alertworthy
create or replace function public.set_inflow_signal_fields()
returns trigger
language plpgsql
as $$
begin
  -- Inflow-derived fields (unchanged)
  if new.net_sol_inflow is null then
    new.inflow_band_ok := null;
    new.inflow_band_reason := 'missing';
    new.inflow_score := null;
  else
    new.inflow_band_ok := (new.net_sol_inflow >= 20 and new.net_sol_inflow <= 70);
    new.inflow_band_reason :=
      case
        when new.net_sol_inflow < 20 then 'too_low'
        when new.net_sol_inflow > 70 then 'too_high'
        else 'ok'
      end;
    new.inflow_score :=
      case
        when new.net_sol_inflow between 20 and 70 then 1.0
        when new.net_sol_inflow < 20 then greatest(0, 1 - ((20 - new.net_sol_inflow) / 10.0))
        else greatest(0, 1 - ((new.net_sol_inflow - 70) / 20.0))
      end;
  end if;

  -- Market-cap floor (fdv_usd as MC proxy; < 10000 = likely sniped/noise)
  if new.fdv_usd is null then
    new.mc_floor_ok := null;
    new.mc_floor_reason := 'missing';
  else
    new.mc_floor_ok := (new.fdv_usd >= 10000);
    new.mc_floor_reason :=
      case
        when new.fdv_usd < 10000 then 'too_low'
        else 'ok'
      end;
  end if;

  -- Alertworthy = qualified AND inflow band OK AND MC floor OK (fdv_usd >= 10000)
  new.is_alertworthy :=
    (new.is_qualified is true)
    and (new.net_sol_inflow between 20 and 70)
    and (new.fdv_usd is not null and new.fdv_usd >= 10000);

  return new;
end;
$$;

-- 4) Trigger: fire on insert/update of net_sol_inflow, is_qualified, fdv_usd
drop trigger if exists trg_set_inflow_signal_fields on public.trending_items;
create trigger trg_set_inflow_signal_fields
  before insert or update of net_sol_inflow, is_qualified, fdv_usd
  on public.trending_items
  for each row
  execute function public.set_inflow_signal_fields();

-- 5) View: include mc_floor_ok, mc_floor_reason for /v1/today
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
  mc_floor_ok,
  mc_floor_reason,
  updated_at
from public.trending_items
order by mint, updated_at desc;
