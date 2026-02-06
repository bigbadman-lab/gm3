-- Capital efficiency and MC structure gating: derived metric + is_alertworthy gated by mc_structure_ok.

-- 1) Add columns
alter table public.trending_items
  add column if not exists capital_efficiency numeric,
  add column if not exists mc_structure_ok boolean,
  add column if not exists mc_structure_reason text;

-- 2) Backfill existing rows (SOL/USD placeholder 200.0)
update public.trending_items
set
  capital_efficiency = case
    when fdv_usd is null or fdv_usd <= 0 then null
    else (net_sol_inflow * 200.0) / fdv_usd
  end,
  mc_structure_ok = case
    when fdv_usd is null or fdv_usd < 8000 then false
    when fdv_usd < 15000 then (coalesce((net_sol_inflow * 200.0) / nullif(fdv_usd, 0), 1e9) <= 0.7)
    else (coalesce((net_sol_inflow * 200.0) / nullif(fdv_usd, 0), 1e9) <= 1.0)
  end,
  mc_structure_reason = case
    when fdv_usd is null then 'missing'
    when fdv_usd < 8000 then 'fdv_too_low'
    when fdv_usd < 15000 and (net_sol_inflow * 200.0) / nullif(fdv_usd, 0) > 0.7 then 'eff_too_high_lowfdv'
    when fdv_usd >= 15000 and (net_sol_inflow * 200.0) / nullif(fdv_usd, 0) > 1.0 then 'eff_too_high'
    else 'ok'
  end,
  is_alertworthy = (
    is_qualified is true
    and net_sol_inflow between 10 and 70
    and case
      when fdv_usd is null or fdv_usd < 8000 then false
      when fdv_usd < 15000 then (coalesce((net_sol_inflow * 200.0) / nullif(fdv_usd, 0), 1e9) <= 0.7)
      else (coalesce((net_sol_inflow * 200.0) / nullif(fdv_usd, 0), 1e9) <= 1.0)
    end
  )
where true;

-- 3) Trigger function: inflow + MC floor + capital efficiency + mc_structure + is_alertworthy
create or replace function public.set_inflow_signal_fields()
returns trigger
language plpgsql
as $$
declare
  eff numeric;
begin
  -- Inflow-derived fields (inflow band 10–70 SOL)
  if new.net_sol_inflow is null then
    new.inflow_band_ok := null;
    new.inflow_band_reason := 'missing';
    new.inflow_score := null;
  else
    new.inflow_band_ok := (new.net_sol_inflow >= 10 and new.net_sol_inflow <= 70);
    new.inflow_band_reason :=
      case
        when new.net_sol_inflow < 10 then 'too_low'
        when new.net_sol_inflow > 70 then 'too_high'
        else 'ok'
      end;
    new.inflow_score :=
      case
        when new.net_sol_inflow between 10 and 70 then 1.0
        when new.net_sol_inflow < 10 then greatest(0, 1 - ((10 - new.net_sol_inflow) / 10.0))
        else greatest(0, 1 - ((new.net_sol_inflow - 70) / 20.0))
      end;
  end if;

  -- Market-cap floor (fdv_usd as MC proxy; < 8000 = likely sniped/noise)
  if new.fdv_usd is null then
    new.mc_floor_ok := null;
    new.mc_floor_reason := 'missing';
  else
    new.mc_floor_ok := (new.fdv_usd >= 8000);
    new.mc_floor_reason :=
      case
        when new.fdv_usd < 8000 then 'too_low'
        else 'ok'
      end;
  end if;

  -- Capital efficiency: (net_sol_inflow * 200) / fdv_usd (placeholder SOL/USD). Use 0 when fdv missing (column may be NOT NULL).
  if new.fdv_usd is null or new.fdv_usd <= 0 then
    new.capital_efficiency := 0;
    new.mc_structure_ok := false;
    new.mc_structure_reason := 'missing';
  else
    eff := (new.net_sol_inflow * 200.0) / new.fdv_usd;
    new.capital_efficiency := eff;
    if new.fdv_usd < 8000 then
      new.mc_structure_ok := false;
      new.mc_structure_reason := 'fdv_too_low';
    elsif new.fdv_usd < 15000 then
      if eff is not null and eff <= 0.7 then
        new.mc_structure_ok := true;
        new.mc_structure_reason := 'ok';
      else
        new.mc_structure_ok := false;
        new.mc_structure_reason := 'eff_too_high_lowfdv';
      end if;
    else
      if eff is not null and eff <= 1.0 then
        new.mc_structure_ok := true;
        new.mc_structure_reason := 'ok';
      else
        new.mc_structure_ok := false;
        new.mc_structure_reason := 'eff_too_high';
      end if;
    end if;
  end if;

  -- Alertworthy = qualified AND inflow band OK (10–70 SOL) AND mc_structure_ok
  new.is_alertworthy :=
    (new.is_qualified is true)
    and (new.net_sol_inflow between 10 and 70)
    and (new.mc_structure_ok is true);

  return new;
end;
$$;

-- 4) Trigger: fire on insert/update of net_sol_inflow, is_qualified, fdv_usd (unchanged)
drop trigger if exists trg_set_inflow_signal_fields on public.trending_items;
create trigger trg_set_inflow_signal_fields
  before insert or update of net_sol_inflow, is_qualified, fdv_usd
  on public.trending_items
  for each row
  execute function public.set_inflow_signal_fields();

-- 5) View: include capital_efficiency, mc_structure_ok, mc_structure_reason for /v1/today
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
  mc_floor_ok,
  mc_floor_reason,
  capital_efficiency,
  mc_structure_ok,
  mc_structure_reason,
  updated_at
from public.trending_items
order by mint, updated_at desc;
