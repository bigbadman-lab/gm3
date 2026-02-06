-- Alertworthy feed diagnostic: why might the UI show no results?
-- Run each block in Supabase SQL Editor. The paid feed = v_paid_alertworthy_60; the API also filters to capital_efficiency <= 0.32.

-- 1) Do we have any 60s snapshots?
SELECT 'trending_snapshots_60' AS check_name,
  count(*) AS snapshot_count,
  max(window_end) AS latest_window_end
FROM public.trending_snapshots
WHERE window_seconds = 60;

-- 2) How many trending_items in the latest two 60s snapshots? How many with is_alertworthy = true?
WITH latest_two AS (
  SELECT id, window_end
  FROM public.trending_snapshots
  WHERE window_seconds = 60
  ORDER BY window_end DESC
  LIMIT 2
)
SELECT
  ts.window_end,
  count(ti.mint) AS item_count,
  count(ti.mint) FILTER (WHERE ti.is_alertworthy = true) AS alertworthy_count
FROM latest_two ts
LEFT JOIN public.trending_items ti ON ti.snapshot_id = ts.id
GROUP BY ts.id, ts.window_end
ORDER BY ts.window_end DESC;

-- 3) Strict path: mints that are alertworthy in BOTH of the latest two snapshots (this is what fills the feed if no runner path)
WITH latest_two AS (
  SELECT id FROM public.trending_snapshots
  WHERE window_seconds = 60
  ORDER BY window_end DESC
  LIMIT 2
),
alertworthy_in_both AS (
  SELECT ti.mint
  FROM public.trending_items ti
  WHERE ti.snapshot_id IN (SELECT id FROM latest_two)
    AND ti.is_alertworthy = true
  GROUP BY ti.mint
  HAVING count(DISTINCT ti.snapshot_id) = 2
)
SELECT 'strict_path_count' AS check_name, count(*) AS mint_count FROM alertworthy_in_both;

-- 4) Runner path: candidates (uses alpha_wallets or preferred_deployers, whichever exists)
DROP TABLE IF EXISTS _diag_runner;
CREATE TEMP TABLE _diag_runner (check_name text, mint_count bigint);
DO $$
DECLARE tname text; cnt bigint;
BEGIN
  SELECT table_name INTO tname FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('alpha_wallets', 'preferred_deployers') LIMIT 1;
  IF tname IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO _diag_runner SELECT ''runner_path_candidates'', count(*) FROM public.trending_items ti ' ||
      'JOIN public.token_cache tc ON tc.mint = ti.mint AND tc.deployer_wallet IS NOT NULL ' ||
      'JOIN public.' || quote_ident(tname) || ' aw ON aw.wallet = tc.deployer_wallet AND aw.is_active = true ' ||
      'WHERE ti.snapshot_id = (SELECT id FROM public.trending_snapshots WHERE window_seconds = 60 ORDER BY window_end DESC LIMIT 1) ' ||
      'AND ti.is_qualified = true AND ti.net_sol_inflow BETWEEN 5 AND 100 AND ti.mc_structure_ok = true ' ||
      'AND ti.mint NOT IN (SELECT ti2.mint FROM public.trending_items ti2 WHERE ti2.snapshot_id IN (SELECT id FROM public.trending_snapshots WHERE window_seconds = 60 ORDER BY window_end DESC LIMIT 2) AND ti2.is_alertworthy = true GROUP BY ti2.mint HAVING count(DISTINCT ti2.snapshot_id) = 2)'
    );
  ELSE
    INSERT INTO _diag_runner VALUES ('runner_path_candidates', 0);
  END IF;
END $$;
SELECT * FROM _diag_runner;

-- 5) What does the feed view actually return? (count + sample)
SELECT 'v_paid_alertworthy_60_count' AS check_name, count(*) AS row_count
FROM public.v_paid_alertworthy_60;

SELECT * FROM public.v_paid_alertworthy_60
ORDER BY in_feed_reason ASC NULLS LAST, updated_at DESC NULLS LAST
LIMIT 10;

-- 6) API filter: feed rows with capital_efficiency > 0.32 are removed in the API. How many would be removed?
SELECT
  'capital_efficiency_filter' AS check_name,
  count(*) AS total_rows,
  count(*) FILTER (WHERE capital_efficiency IS NULL OR capital_efficiency <= 0.32) AS pass_ce_filter,
  count(*) FILTER (WHERE capital_efficiency > 0.32) AS removed_by_api
FROM public.v_paid_alertworthy_60;

-- 7) Alpha/Preferred wallets: do we have any? (Runner path requires deployer in this list.)
DROP TABLE IF EXISTS _diag_alpha;
CREATE TEMP TABLE _diag_alpha (check_name text, wallet_count bigint);
DO $$
DECLARE tname text;
BEGIN
  SELECT table_name INTO tname FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('alpha_wallets', 'preferred_deployers') LIMIT 1;
  IF tname IS NOT NULL THEN
    EXECUTE format('INSERT INTO _diag_alpha SELECT ''alpha_wallets_count'', count(*) FROM public.' || quote_ident(tname) || ' WHERE is_active = true');
  ELSE
    INSERT INTO _diag_alpha VALUES ('alpha_wallets_count', 0);
  END IF;
END $$;
SELECT * FROM _diag_alpha;
