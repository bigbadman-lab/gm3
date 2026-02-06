-- Extract all data for mint AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump
-- Run in Supabase SQL Editor. Run each block separately (or all; each returns its own result set).

-- ========== WHY NOT IN THE ALERTWORTHY FEED? ==========
-- The feed (v1-today) shows mints from trending_items_latest, sorted by is_alertworthy DESC then inflow_score, etc. Blocked mints/creators are filtered out.
-- A mint is alertworthy only when ALL are true:
--   1) is_qualified: unique_buyers >= 5, buy_ratio >= 0.65, net_sol_inflow >= 1, swap_count >= 10 (ingest-trending)
--   2) inflow_band_ok: net_sol_inflow BETWEEN 10 AND 70 (trigger)
--   3) mc_structure_ok: fdv_usd >= 8000 AND capital_efficiency in band (fdv<15k → <=0.7, else <=1.0)
-- Run this first for a one-row summary of why this mint didn't make it (or did).
WITH m AS (
  SELECT 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump' AS mint
),
in_trending AS (
  SELECT ti.mint, ti.rank, ti.swap_count, ti.unique_buyers, ti.buy_ratio, ti.net_sol_inflow, ti.fdv_usd, ti.capital_efficiency,
         ti.is_qualified, ti.inflow_band_ok, ti.inflow_band_reason, ti.mc_floor_ok, ti.mc_structure_ok, ti.mc_structure_reason, ti.is_alertworthy, ti.updated_at
  FROM public.trending_items_latest ti
  CROSS JOIN m
  WHERE ti.mint = m.mint
),
blocked AS (
  SELECT EXISTS (SELECT 1 FROM public.blocked_mints b, m WHERE b.mint = m.mint AND b.is_active) AS mint_blocked
)
SELECT
  m.mint,
  (SELECT count(*) FROM in_trending) > 0 AS in_trending_latest,
  t.is_qualified,
  t.inflow_band_ok,
  t.mc_structure_ok,
  t.is_alertworthy,
  t.inflow_band_reason,
  t.mc_structure_reason,
  t.net_sol_inflow,
  t.fdv_usd,
  t.capital_efficiency,
  b.mint_blocked,
  b.mint_blocked AS is_blocked,
  CASE
    WHEN (SELECT count(*) FROM in_trending) = 0 THEN 'not_in_trending_latest'
    WHEN b.mint_blocked THEN 'blocked'
    WHEN NOT t.is_qualified THEN 'failed_qualification'
    WHEN NOT t.inflow_band_ok THEN 'inflow_band: ' || COALESCE(t.inflow_band_reason, CASE WHEN t.net_sol_inflow < 10 THEN 'too_low' WHEN t.net_sol_inflow > 70 THEN 'too_high' ELSE '?' END)
    WHEN NOT t.mc_structure_ok THEN 'mc_structure: ' || COALESCE(t.mc_structure_reason, '?')
    WHEN t.is_alertworthy THEN 'alertworthy_ok'
    ELSE 'unknown'
  END AS why_not_in_alertworthy_feed
FROM m
LEFT JOIN in_trending t ON t.mint = m.mint
CROSS JOIN blocked b;

-- Full gate details (same mint)
SELECT 'why_not_alertworthy' AS source,
  mint, rank, swap_count, unique_buyers, buy_ratio, net_sol_inflow, fdv_usd,
  is_qualified, inflow_band_ok, inflow_band_reason, mc_floor_ok, mc_floor_reason, capital_efficiency, mc_structure_ok, mc_structure_reason, is_alertworthy, updated_at
FROM public.trending_items_latest
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 1) trending_items (all snapshot appearances) + snapshot window
SELECT 'trending_items' AS source, ti.*, ts.window_seconds, ts.window_end
FROM public.trending_items ti
JOIN public.trending_snapshots ts ON ts.id = ti.snapshot_id
WHERE ti.mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump'
ORDER BY ts.window_end DESC;

-- 2) mint_entries (first-alert / entry tracking)
SELECT 'mint_entries' AS source, *
FROM public.mint_entries
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 2b) Capital efficiency at first alert (trending_items row for first_alert_window_end)
-- capital_efficiency = (net_sol_inflow * 200) / fdv_usd; alertworthy requires <= 0.7 if fdv < 15k, else <= 1.0
SELECT 'capital_efficiency_at_first_alert' AS source,
  me.mint,
  me.first_alert_window_end,
  me.entry_fdv_usd AS fdv_at_alert,
  ti.net_sol_inflow,
  ti.capital_efficiency,
  (ti.net_sol_inflow * 200.0) / nullif(ti.fdv_usd, 0) AS capital_efficiency_computed,
  ti.mc_structure_ok,
  ti.mc_structure_reason
FROM public.mint_entries me
JOIN public.trending_snapshots ts ON ts.window_end = me.first_alert_window_end
JOIN public.trending_items ti ON ti.snapshot_id = ts.id AND ti.mint = me.mint
WHERE me.mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 3) token_ath (ATH tracking)
SELECT 'token_ath' AS source, *
FROM public.token_ath
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 4) token_first_alerts (view: first_alert_fdv_usd)
SELECT 'token_first_alerts' AS source, *
FROM public.token_first_alerts
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 5) token_cache (metadata cache)
SELECT 'token_cache' AS source, *
FROM public.token_cache
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 6) blocked_mints (if blocked)
SELECT 'blocked_mints' AS source, *
FROM public.blocked_mints
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';

-- 7) watchlist_gm_events (GM taps)
SELECT 'watchlist_gm_events' AS source, *
FROM public.watchlist_gm_events
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump'
ORDER BY day DESC;

-- 8) watchlist_daily (daily GM aggregate)
SELECT 'watchlist_daily' AS source, *
FROM public.watchlist_daily
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump'
ORDER BY day DESC;

-- 9) v_mint_alert_outcomes (view: first alert + ATH outcome)
SELECT 'v_mint_alert_outcomes' AS source, *
FROM public.v_mint_alert_outcomes
WHERE mint = 'AEb4NmMJF2x5kcp19M13RiXZuAGyajWSKLaioqBrpump';
