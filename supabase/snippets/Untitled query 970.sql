create or replace function public.update_ath_for_mint(
  p_current_fdv_usd numeric,
  p_mint text
)
returns void
language plpgsql
security definer
as $$
begin
  update public.token_ath
  set
    current_fdv_usd = p_current_fdv_usd,
    current_ts = now(),
    last_checked_ts = now(),

    -- bump ATH if needed
    ath_fdv_usd = case
      when ath_fdv_usd is null or p_current_fdv_usd > ath_fdv_usd then p_current_fdv_usd
      else ath_fdv_usd
    end,
    ath_ts = case
      when ath_fdv_usd is null or p_current_fdv_usd > ath_fdv_usd then now()
      else ath_ts
    end,

    -- schedule next check (expects you already created this SQL fn)
    next_check_ts = public.compute_next_check_ts(entry_ts, now())

  where mint = p_mint;
end;
$$;

grant execute on function public.update_ath_for_mint(numeric, text) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
