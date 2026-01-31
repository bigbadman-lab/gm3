alter table public.trending_items
  add column if not exists mc_floor_ok boolean,
  add column if not exists mc_floor_reason text;

update public.trending_items
set
  mc_floor_ok =
    case
      when fdv_usd is null then null
      when fdv_usd >= 10000 then true
      else false
    end,
  mc_floor_reason =
    case
      when fdv_usd is null then 'missing'
      when fdv_usd < 10000 then 'too_low'
      else 'ok'
    end
where true;
