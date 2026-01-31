select
  now() as db_now,
  mint,
  current_ts,
  last_checked_ts,
  next_check_ts,
  updated_at,
  current_fdv_usd,
  ath_fdv_usd,
  ath_ts,
  status
from public.token_ath
where mint = '3GwyDM2wm2CtoLD7Mfrg9T7ipExXGhnbDNW8xNAH5uKw';
