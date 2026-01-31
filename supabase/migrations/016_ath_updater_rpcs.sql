-- RPCs for ath-updater Edge Function: locked select of due mints + single-row update with next_check_ts/archive.

-- Returns up to lim due mints (status=active, next_check_ts <= now()) with entry_ts for compute_next_check_ts.
-- FOR UPDATE SKIP LOCKED so concurrent runs don't process the same rows.
create or replace function public.get_due_ath_mints(lim int default 20)
returns table(mint text, entry_ts timestamptz)
language sql
security definer
set search_path = public
as $$
  select t.mint, e.entry_ts
  from public.token_ath t
  join public.mint_entries e on e.mint = t.mint
  where t.status = 'active'
    and t.next_check_ts <= now()
  order by t.next_check_ts
  for update of t skip locked
  limit lim;
$$;

-- Updates token_ath for one mint: current_fdv_usd/current_ts, ath if higher, last_checked_ts,
-- next_check_ts = compute_next_check_ts(entry_ts, now()), status = 'archived' if entry older than 7 days.
-- Returns (updated, archived): true if row was updated, true if status was set to archived.
create or replace function public.update_ath_for_mint(p_mint text, p_current_fdv_usd numeric)
returns table(updated boolean, archived boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_ts timestamptz;
  v_archived boolean;
begin
  select e.entry_ts into v_entry_ts from public.mint_entries e where e.mint = p_mint;
  if v_entry_ts is null then
    updated := false; archived := false; return next; return;
  end if;
  v_archived := (now() - v_entry_ts >= interval '7 days');
  update public.token_ath a
  set
    current_fdv_usd = p_current_fdv_usd,
    current_ts = now(),
    ath_fdv_usd = greatest(coalesce(a.ath_fdv_usd, 0), p_current_fdv_usd),
    ath_ts = case when p_current_fdv_usd > coalesce(a.ath_fdv_usd, 0) then now() else a.ath_ts end,
    last_checked_ts = now(),
    next_check_ts = public.compute_next_check_ts(v_entry_ts, now()),
    status = case when v_archived then 'archived' else a.status end,
    updated_at = now()
  where a.mint = p_mint;
  updated := found;
  archived := v_archived and found;
  return next;
end;
$$;
