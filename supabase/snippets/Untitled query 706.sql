insert into public.token_ath (mint, ath_fdv_usd, ath_ts, current_fdv_usd, current_ts, last_checked_ts, next_check_ts, status)
select
  e.mint,
  e.entry_fdv_usd,
  e.entry_ts,
  e.entry_fdv_usd,
  e.entry_ts,
  null,
  now(),           -- due immediately
  'active'
from public.mint_entries e
left join public.token_ath a on a.mint = e.mint
where a.mint is null;
