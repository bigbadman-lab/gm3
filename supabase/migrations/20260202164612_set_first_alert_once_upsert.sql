CREATE OR REPLACE FUNCTION public.set_first_alert_once(
  p_mint text,
  p_first_alert_window_end timestamptz,
  p_entry_fdv_usd numeric
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rc integer;
BEGIN
  INSERT INTO public.mint_entries (mint, first_alert_ts, first_alert_window_end, entry_fdv_usd)
  VALUES (p_mint, now(), p_first_alert_window_end, p_entry_fdv_usd)
  ON CONFLICT (mint) DO UPDATE
    SET
      first_alert_ts = EXCLUDED.first_alert_ts,
      first_alert_window_end = EXCLUDED.first_alert_window_end,
      entry_fdv_usd = EXCLUDED.entry_fdv_usd
    WHERE public.mint_entries.first_alert_ts IS NULL;

  GET DIAGNOSTICS rc = ROW_COUNT;
  RETURN rc > 0;
END;
$$;
