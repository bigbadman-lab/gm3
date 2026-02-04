-- View: one row per mint with FDV at first alert (for joining into paid feeds).
create or replace view public.token_first_alerts as
select mint, entry_fdv_usd as first_alert_fdv_usd
from public.mint_entries
where entry_fdv_usd is not null;

grant select on public.token_first_alerts to anon, authenticated;

-- Add first_alert_fdv_usd to paid alertworthy (left join token_first_alerts).
drop view if exists public.v_paid_alertworthy_60;

create view public.v_paid_alertworthy_60 as
select
  l.*,
  me.first_alert_ts as first_alert_time,
  me.entry_fdv_usd as fdv_at_alert,
  tfa.first_alert_fdv_usd
from public.v_layer_alertworthy_60 l
left join public.mint_entries me on me.mint = l.mint
left join public.token_first_alerts tfa on tfa.mint = l.mint;

grant select on public.v_paid_alertworthy_60 to anon, authenticated;

-- Add first_alert_fdv_usd to paid investable (left join token_first_alerts).
drop view if exists public.v_paid_investable_60;

create view public.v_paid_investable_60 as
select
  l.*,
  me.first_alert_ts as first_alert_time,
  tfa.first_alert_fdv_usd
from public.v_layer_investable_60 l
left join public.mint_entries me on me.mint = l.mint
left join public.token_first_alerts tfa on tfa.mint = l.mint;

grant select on public.v_paid_investable_60 to anon, authenticated;
