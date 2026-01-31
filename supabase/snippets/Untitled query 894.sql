alter table public.token_ath
add column if not exists entry_ts timestamptz;

update public.token_ath
set entry_ts = coalesce(ath_ts, current_ts, updated_at, now())
where entry_ts is null;
