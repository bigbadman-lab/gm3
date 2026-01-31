create or replace function public.set_inflow_signal_fields()
returns trigger
language plpgsql
as $$
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

  -- Market-cap floor fields (using fdv_usd as MC proxy)
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

  -- Alertworthy = qualified AND inflow band OK AND MC floor OK
  new.is_alertworthy :=
    (new.is_qualified is true)
    and (new.net_sol_inflow between 20 and 70)
    and (new.fdv_usd is not null and new.fdv_usd >= 10000);

  return new;
end;
$$;
