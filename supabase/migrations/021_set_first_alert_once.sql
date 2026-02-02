-- Idempotent "first alert once" per mint: insert into mint_entries if not present; return true iff a row was inserted.
create or replace function public.set_first_alert_once(
  p_mint text,
  p_first_alert_window_end timestamptz,
  p_entry_fdv_usd numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  rc int;
begin
  insert into public.mint_entries (mint, entry_ts)
  values (p_mint, p_first_alert_window_end)
  on conflict (mint) do nothing;
  get diagnostics rc = row_count;
  return rc > 0;
end;
$$;
