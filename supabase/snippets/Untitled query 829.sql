select
  mint,
  current_fdv_usd,
  current_ts,
  ath_fdv_usd,
  ath_ts,
  last_checked_ts,
  next_check_ts,
  updated_at
from public.token_ath
where mint = '3GwyDM2wm2CtoLD7Mfrg9T7ipExXGhnbDNW8xNAH5uKw';
