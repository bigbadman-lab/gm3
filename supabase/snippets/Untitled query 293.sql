create or replace function public.update_ath_for_mint(
  p_current_fdv_usd numeric,
  p_mint text
)
returns void
language plpgsql
security definer
as $$
declare
  v_now timestamptz := now();
begin
  update public.token_ath
  set
    current_fdv_usd = p_current_fdv_usd,
    current_ts = v_now,
    last_checked_ts = v_now,

    ath_fdv_usd = case
      when ath_fdv_usd is null or p_current_fdv_usd > ath_fdv_usd then p_current_fdv_usd
      else ath_fdv_usd
    end,
    ath_ts = case
      when ath_fdv_usd is null or p_current_fdv_usd > ath_fdv_usd then v_now
      else ath_ts
    end,

    next_check_ts = public.compute_next_check_ts(entry_ts, v_now),
    updated_at = v_now
  where mint = p_mint;
end;
$$;

notify pgrst, 'reload schema';
