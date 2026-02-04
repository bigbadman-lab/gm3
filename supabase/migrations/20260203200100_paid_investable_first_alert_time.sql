-- Add first_alert_time (immutable first-alert timestamp) to paid investable payload.
-- first_alert_ts from mint_entries is set once by set_first_alert_once.

drop view if exists public.v_paid_investable_60;

create view public.v_paid_investable_60 as
select
  l.*,
  me.first_alert_ts as first_alert_time
from public.v_layer_investable_60 l
left join public.mint_entries me on me.mint = l.mint;

grant select on public.v_paid_investable_60 to anon, authenticated;
