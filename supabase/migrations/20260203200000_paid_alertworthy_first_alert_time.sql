-- Add first_alert_time (immutable first-alert moment) and fdv_at_alert to paid alertworthy payload.
-- first_alert_ts from mint_entries is set once by set_first_alert_once; stable across polls.

drop view if exists public.v_paid_alertworthy_60;

create view public.v_paid_alertworthy_60 as
select
  l.*,
  me.first_alert_ts as first_alert_time,
  me.entry_fdv_usd as fdv_at_alert
from public.v_layer_alertworthy_60 l
left join public.mint_entries me on me.mint = l.mint;

grant select on public.v_paid_alertworthy_60 to anon, authenticated;
