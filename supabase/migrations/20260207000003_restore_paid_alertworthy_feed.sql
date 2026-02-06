-- Restore Alertworthy feed to the original layer so the feed works again (no dependency on alpha_wallets/runner path).
-- v_layer_alertworthy_60 = mints alertworthy in both latest two 60s snapshots (unchanged). Runner path remains available via v_layer_alertworthy_with_runners_60 when needed.

drop view if exists public.v_paid_alertworthy_60 cascade;

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
