create or replace function public.apply_ath_update(p_mint text, p_current_fdv_usd numeric)
returns table (status text, ath_updated boolean)
language sql
security definer
as $$
  update public.token_ath a
  set
    current_fdv_usd = p_current_fdv_usd,
    current_ts = now(),

    ath_updated = (p_current_fdv_usd > coalesce(a.ath_fdv_usd, 0)),
    ath_fdv_usd = greatest(coalesce(a.ath_fdv_usd, 0), p_current_fdv_usd),
    ath_ts = case
      when p_current_fdv_usd > coalesce(a.ath_fdv_usd, 0) then now()
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
    and a.mint = p_mint
  returning a.status, (p_current_fdv_usd > coalesce(a.ath_fdv_usd, 0)) as ath_updated;
$$;
