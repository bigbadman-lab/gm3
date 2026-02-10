-- Mint decision helper for "Search mint" feature.
-- Uses the same paid feed view as the UI so results match what users see.

create or replace function public.mint_decision(p_mint text)
returns table (
  found boolean,
  verdict text,
  confidence numeric,
  reasons text[],
  snapshot_id uuid,
  rank integer,
  mint text,
  fdv_usd numeric,
  buy_ratio numeric,
  unique_buyers integer,
  capital_efficiency numeric,
  mc_floor_ok boolean,
  mc_floor_reason text,
  mc_structure_ok boolean,
  mc_structure_reason text,
  inflow_band_ok boolean,
  inflow_band_reason text,
  is_alertworthy boolean,
  is_qualified boolean,
  first_alert_time timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
as $$
declare
  r public.v_paid_alertworthy_60%rowtype;
  pass_core int := 0;
  r_reasons text[] := array[]::text[];
  v_verdict text := 'avoid';
  v_conf numeric := 0;
begin
  -- Use an alias so "mint" etc are never ambiguous with RETURNS TABLE output vars.
  select v.*
  into r
  from public.v_paid_alertworthy_60 v
  where v.mint = p_mint
  order by v.updated_at desc nulls last
  limit 1;

  if not found then
    return query
    select
      false,
      'not_found',
      0::numeric,
      array['Mint not found in the latest alertworthy snapshots (not indexed yet).']::text[],
      null::uuid, null::int, p_mint,
      null::numeric, null::numeric, null::int, null::numeric,
      null::boolean, null::text,
      null::boolean, null::text,
      null::boolean, null::text,
      null::boolean, null::boolean,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Core checks
  if r.capital_efficiency is not null and r.capital_efficiency < 0.20 then
    pass_core := pass_core + 1;
    r_reasons := array_append(r_reasons, 'Capital efficiency < 0.20 ✅');
  else
    r_reasons := array_append(r_reasons, 'Capital efficiency >= 0.20 ❌');
  end if;

  if r.buy_ratio is not null and r.buy_ratio >= 0.70 and r.buy_ratio <= 0.80 then
    pass_core := pass_core + 1;
    r_reasons := array_append(r_reasons, 'Buy ratio 0.70–0.80 ✅');
  elsif r.buy_ratio is not null and r.buy_ratio >= 0.70 then
    r_reasons := array_append(r_reasons, 'Buy ratio >= 0.70 (outside ideal 0.70–0.80) ⚠️');
  else
    r_reasons := array_append(r_reasons, 'Buy ratio < 0.70 ❌');
  end if;

  if r.unique_buyers is not null and r.unique_buyers > 20 then
    pass_core := pass_core + 1;
    r_reasons := array_append(r_reasons, 'Unique buyers > 20 ✅');
  else
    r_reasons := array_append(r_reasons, 'Unique buyers <= 20 ❌');
  end if;

  -- Extra context flags
  if r.mc_floor_ok is true then
    r_reasons := array_append(r_reasons, 'MC/FDV floor OK ✅');
  elsif r.mc_floor_ok is false then
    r_reasons := array_append(r_reasons, 'MC/FDV floor not OK ❌ (' || coalesce(r.mc_floor_reason,'no reason') || ')');
  end if;

  if r.mc_structure_ok is true then
    r_reasons := array_append(r_reasons, 'Market-cap structure OK ✅');
  elsif r.mc_structure_ok is false then
    r_reasons := array_append(r_reasons, 'Market-cap structure not OK ❌ (' || coalesce(r.mc_structure_reason,'no reason') || ')');
  end if;

  if r.inflow_band_ok is true then
    r_reasons := array_append(r_reasons, 'Inflow band OK ✅');
  elsif r.inflow_band_ok is false then
    r_reasons := array_append(r_reasons, 'Inflow band not OK ❌ (' || coalesce(r.inflow_band_reason,'no reason') || ')');
  end if;

  -- Verdict mapping
  if pass_core = 3 and r.mc_floor_ok is true and r.mc_structure_ok is true and r.is_qualified is true then
    v_verdict := 'invest';
  elsif pass_core >= 2 and (r.is_alertworthy is true or r.is_qualified is true) then
    v_verdict := 'watch';
  else
    v_verdict := 'avoid';
  end if;

  v_conf := least(1,
    (pass_core / 3.0)
    + (case when r.mc_floor_ok is true then 0.15 else 0 end)
    + (case when r.mc_structure_ok is true then 0.10 else 0 end)
    + (case when r.is_alertworthy is true then 0.10 else 0 end)
  );

  return query
  select
    true,
    v_verdict,
    v_conf,
    r_reasons,
    r.snapshot_id,
    r.rank,
    r.mint,
    r.fdv_usd,
    r.buy_ratio,
    r.unique_buyers,
    r.capital_efficiency,
    r.mc_floor_ok,
    r.mc_floor_reason,
    r.mc_structure_ok,
    r.mc_structure_reason,
    r.inflow_band_ok,
    r.inflow_band_reason,
    r.is_alertworthy,
    r.is_qualified,
    r.first_alert_time,
    r.updated_at;
end;
$$;

