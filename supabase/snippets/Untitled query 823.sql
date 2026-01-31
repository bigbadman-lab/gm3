update public.token_ath
set next_check_ts = now() - interval '1 minute'
where mint = '3GwyDM2wm2CtoLD7Mfrg9T7ipExXGhnbDNW8xNAH5uKw';
