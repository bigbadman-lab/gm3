-- View: FDV at first alert vs ATH FDV + multiple
CREATE OR REPLACE VIEW public.v_mint_alert_outcomes AS
SELECT
  me.mint,
  me.first_alert_ts,
  me.first_alert_window_end,
  me.entry_fdv_usd AS fdv_at_alert,

  ta.ath_fdv_usd   AS fdv_ath,
  ta.ath_ts        AS ath_ts,

  (ta.ath_fdv_usd / NULLIF(me.entry_fdv_usd, 0)) AS multiple_to_ath,

  ta.status,
  ta.current_fdv_usd,
  ta.current_ts,
  ta.last_checked_ts
FROM public.mint_entries me
LEFT JOIN public.token_ath ta
  ON ta.mint = me.mint
WHERE me.first_alert_ts IS NOT NULL;

-- View: TP hit flags based on ATH multiple
CREATE OR REPLACE VIEW public.v_mint_alert_tp_flags AS
SELECT
  o.*,
  CASE WHEN o.fdv_ath >= o.fdv_at_alert * 1.25 THEN 1 ELSE 0 END AS hit_25pct,
  CASE WHEN o.fdv_ath >= o.fdv_at_alert * 1.50 THEN 1 ELSE 0 END AS hit_50pct,
  CASE WHEN o.fdv_ath >= o.fdv_at_alert * 1.75 THEN 1 ELSE 0 END AS hit_75pct,
  CASE WHEN o.fdv_ath >= o.fdv_at_alert * 2.00 THEN 1 ELSE 0 END AS hit_100pct
FROM public.v_mint_alert_outcomes o;
