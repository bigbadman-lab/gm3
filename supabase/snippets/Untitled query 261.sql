with computed as (
  select
    ctid,
    case
      when fdv_usd is null or fdv_usd = 0 or net_sol_inflow is null then null
      else (net_sol_inflow * 200.0) / fdv_usd
    end as eff
  from public.trending_items
)
update public.trending_items t
set
  capital_efficiency = c.eff,

  mc_structure_ok =
    case
      when t.fdv_usd is null or t.net_sol_inflow is null then null
      when t.fdv_usd < 10000 then false
      when t.fdv_usd < 15000 then (c.eff <= 0.7)
      else (c.eff <= 1.0)
    end,

  mc_structure_reason =
    case
      when t.fdv_usd is null then 'fdv_missing'
      when t.net_sol_inflow is null then 'inflow_missing'
      when t.fdv_usd = 0 then 'fdv_zero'
      when t.fdv_usd < 10000 then 'fdv_too_low'
      when t.fdv_usd < 15000 and c.eff > 0.7 then 'eff_too_high_lowfdv'
      when t.fdv_usd >= 15000 and c.eff > 1.0 then 'eff_too_high'
      else 'ok'
    end,

  -- recompute alertworthy using NEW logic
  is_alertworthy =
    (t.is_qualified is true)
    and (t.net_sol_inflow between 20 and 70)
    and (
      case
        when t.fdv_usd is null or t.net_sol_inflow is null then false
        when t.fdv_usd < 10000 then false
        when t.fdv_usd < 15000 then (c.eff <= 0.7)
        else (c.eff <= 1.0)
      end
    )
from computed c
where t.ctid = c.ctid;
