ALTER TABLE public.mint_entries
  ADD COLUMN IF NOT EXISTS first_alert_ts timestamptz,
  ADD COLUMN IF NOT EXISTS first_alert_window_end timestamptz,
  ADD COLUMN IF NOT EXISTS entry_fdv_usd numeric;
