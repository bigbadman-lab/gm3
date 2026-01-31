-- 1) Add columns
alter table public.trending_items
  add column if not exists inflow_band_ok boolean,
  add column if not exists inflow_band_reason text,
  add column if not exists inflow_score numeric,
  add column if not exists is_alertworthy boolean;

-- 2) Backfill for existing rows
update public.trending_items
set
  inflow_band_ok =
    case
      when net_sol_inflow is null then null
      when net_sol_inflow >= 20 and net_sol_inflow <= 70 then true
      else false
    end,
  inflow_band_reason =
    case
      when net_sol_inflow is null then 'missing'
      when net_sol_inflow < 20 then 'too_low'
      when net_sol_inflow > 70 then 'too_high'
      else 'ok'
    end,
  -- Smooth score: 1.0 inside band; decays outside band.
  -- Adjust decay widths (10 and 20) to taste.
  inflow_score =
    case
      when net_sol_inflow is null then null
      when net_sol_inflow between 20 and 70 then 1.0
      when net_sol_inflow < 20 then greatest(0, 1 - ((20 - net_sol_inflow) / 10.0))
      else greatest(0, 1 - ((net_sol_inflow - 70) / 20.0))
    end,
  -- Alertworthy = qualified AND inflow is in the healthy band
  is_alertworthy =
    case
      when is_qualified is true and net_sol_inflow between 20 and 70 then true
      else false
    end
where true;
