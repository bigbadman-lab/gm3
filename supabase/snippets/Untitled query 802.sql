update public.token_ath a
set
  current_fdv_usd = $1,
  current_ts = now(),

  ath_fdv_usd = greatest(coalesce(a.ath_fdv_usd, 0), $1),
  ath_ts = case
    when $1 > coalesce(a.ath_fdv_usd, 0) then now()
    else a.ath_ts
  end,

  last_checked_ts = now(),
  next_check_ts = public.compute_next_check_ts(e.entry_ts, now()),
  status = case
    when now() - e.entry_ts >= interval '7 days' then 'archived'
    else a.status
  end,
  updated_at = now()
from public.mint_entries e
where a.mint = e.mint
  and a.mint = $2;
