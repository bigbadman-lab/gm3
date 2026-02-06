-- Alertworthy: MC floor 8000 (fdv_usd), inflow band 10–70 SOL. Aligns with live DB.
-- Replaces the trigger function only; if a manual edit broke it, this restores a valid trigger.

create or replace function public.set_inflow_signal_fields()
returns trigger
language plpgsql
as $$
declare
  eff numeric;
  mc_floor numeric := 8000;
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

  -- Market-cap floor (fdv_usd as MC proxy; < mc_floor = likely sniped/noise)
  if new.fdv_usd is null then
    new.mc_floor_ok := null;
    new.mc_floor_reason := 'missing';
  else
    new.mc_floor_ok := (new.fdv_usd >= mc_floor);
    new.mc_floor_reason :=
      case
        when new.fdv_usd < mc_floor then 'too_low'
        else 'ok'
      end;
  end if;

  -- Capital efficiency: (net_sol_inflow * 200) / fdv_usd (placeholder SOL/USD). Use 0 when fdv missing (column is NOT NULL).
  if new.fdv_usd is null or new.fdv_usd <= 0 then
    new.capital_efficiency := 0;
    new.mc_structure_ok := false;
    new.mc_structure_reason := 'missing';
  else
    eff := (new.net_sol_inflow * 200.0) / new.fdv_usd;
    new.capital_efficiency := eff;
    if new.fdv_usd < mc_floor then
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
