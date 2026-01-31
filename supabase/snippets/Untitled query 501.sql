create or replace function public.set_inflow_signal_fields()
returns trigger
language plpgsql
as $$
declare
  sol_price_usd constant numeric := 200.0; -- keep consistent with your analysis; change later if you add real SOL price
  eff numeric;
begin
  -- Inflow-derived fields
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

  -- MC floor fields (fdv_usd as proxy)
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

  -- Capital efficiency + MC structure check (piecewise thresholds)
  if new.fdv_usd is null or new.fdv_usd = 0 or new.net_sol_inflow is null then
    new.capital_efficiency := null;
    new.mc_structure_ok := null;

    new.mc_structure_reason :=
      case
        when new.fdv_usd is null then 'fdv_missing'
        when new.net_sol_inflow is null then 'inflow_missing'
        else 'fdv_zero'
      end;
  else
    eff := (new.net_sol_inflow * sol_price_usd) / new.fdv_usd;
    new.capital_efficiency := eff;

    if new.fdv_usd < 10000 then
      new.mc_structure_ok := false;
      new.mc_structure_reason := 'fdv_too_low';

    elsif new.fdv_usd < 15000 then
      new.mc_structure_ok := (eff <= 0.7);
      new.mc_structure_reason :=
        case
          when eff <= 0.7 then 'ok'
          else 'eff_too_high_lowfdv'
        end;

    else
      new.mc_structure_ok := (eff <= 1.0);
      new.mc_structure_reason :=
        case
          when eff <= 1.0 then 'ok'
          else 'eff_too_high'
        end;
    end if;
  end if;

  -- Alertworthy = qualified AND inflow band OK AND MC structure OK
  new.is_alertworthy :=
    (new.is_qualified is true)
    and (new.net_sol_inflow between 20 and 70)
    and (new.mc_structure_ok is true);

  return new;
end;
$$;
