-- Extract all data for mint 3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump
-- Run in Supabase SQL Editor. Run each block separately (or all; each returns its own result set).

-- 1) trending_items (all snapshot appearances) + snapshot window
SELECT 'trending_items' AS source, ti.*, ts.window_seconds, ts.window_end
FROM public.trending_items ti
JOIN public.trending_snapshots ts ON ts.id = ti.snapshot_id
WHERE ti.mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump'
ORDER BY ts.window_end DESC;

-- 2) mint_entries (first-alert / entry tracking)
SELECT 'mint_entries' AS source, *
FROM public.mint_entries
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';

-- 3) token_ath (ATH tracking)
SELECT 'token_ath' AS source, *
FROM public.token_ath
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';

-- 4) token_first_alerts (view: first_alert_fdv_usd)
SELECT 'token_first_alerts' AS source, *
FROM public.token_first_alerts
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';

-- 5) token_cache (metadata cache)
SELECT 'token_cache' AS source, *
FROM public.token_cache
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';

-- 6) blocked_mints (if blocked)
SELECT 'blocked_mints' AS source, *
FROM public.blocked_mints
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';

-- 7) watchlist_gm_events (GM taps)
SELECT 'watchlist_gm_events' AS source, *
FROM public.watchlist_gm_events
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump'
ORDER BY day DESC;

-- 8) watchlist_daily (daily GM aggregate)
SELECT 'watchlist_daily' AS source, *
FROM public.watchlist_daily
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump'
ORDER BY day DESC;

-- 9) v_mint_alert_outcomes (view: first alert + ATH outcome)
SELECT 'v_mint_alert_outcomes' AS source, *
FROM public.v_mint_alert_outcomes
WHERE mint = '3BB9Q8MZgX3DDZQuebjLSbDU94s56DXa6dBpVQ4mpump';
