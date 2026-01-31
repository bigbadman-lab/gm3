update public.trending_items
set
  capital_efficiency =
    case
      when fdv_usd is null or fdv_usd = 0 or net_sol_inflow is null then null
      else (net_sol_inflow * 200.0) / fdv_usd
    end,

  mc_structure_ok =
    case
      when fdv_usd is null or net_sol_inflow is null then null
      when fdv_usd < 10000 then false
      when fdv_usd < 15000 then ((net_sol_inflow * 200.0) / fdv_usd) <= 0.7
      else ((net_sol_inflow * 200.0) / fdv_usd) <= 1.0
    end,

  mc_structure_reason =
    case
      when fdv_usd is null then 'fdv_missing'
      when net_sol_inflow is null then 'inflow_missing'
      when fdv_usd < 10000 then 'fdv_too_low'
      when fdv_usd < 15000 and ((net_sol_inflow * 200.0) / fdv_usd) > 0.7 then 'eff_too_high_lowfdv'
      when fdv_usd >= 15000 and ((net_sol_inflow * 200.0) / fdv_usd) > 1.0 then 'eff_too_high'
      else 'ok'
    end
where true;
