-- Free feed debug: why does GET /v1/free/qualified return empty?
-- Run in Supabase SQL Editor. Run each block (or all); each returns one result set.

-- 1) Cursor: is ingest advancing?
SELECT '1_cursor' AS step,
       name,
       left(last_signature, 20) AS sig_prefix,
       updated_at
FROM public.ingest_state
WHERE name = 'ingest-trending';
-- updated_at should be recent (last few min) if cron + cursor fix are working.

-- 2) Latest 60s snapshot: does it have ANY items?
SELECT '2_latest_snapshot' AS step,
       ts.id AS snapshot_id,
       ts.window_end,
       count(ti.mint) AS items_total,
       count(ti.mint) FILTER (WHERE ti.is_qualified = true) AS items_qualified
FROM public.trending_snapshots ts
LEFT JOIN public.trending_items ti ON ti.snapshot_id = ts.id
WHERE ts.window_seconds = 60
  AND ts.window_end = (SELECT max(window_end) FROM public.trending_snapshots WHERE window_seconds = 60)
GROUP BY ts.id, ts.window_end;
-- If items_qualified = 0, the free feed (which uses this snapshot) returns [].

-- 3) Last 60s snapshot that HAS qualified items (fallback source)
SELECT '3_last_non_empty' AS step,
       ts.window_end,
       count(ti.mint) AS qualified_count
FROM public.trending_snapshots ts
JOIN public.trending_items ti ON ti.snapshot_id = ts.id AND ti.is_qualified = true
WHERE ts.window_seconds = 60
GROUP BY ts.id, ts.window_end
ORDER BY ts.window_end DESC
LIMIT 1;
-- If this returns a row, we could show that snapshot in the API until new data arrives.

-- 4) Item counts per 60s window (last 20 windows)
SELECT '4_items_per_window' AS step,
       ts.window_end,
       count(ti.mint) AS items
FROM public.trending_snapshots ts
LEFT JOIN public.trending_items ti ON ti.snapshot_id = ts.id
WHERE ts.window_seconds = 60
GROUP BY ts.window_end
ORDER BY ts.window_end DESC
LIMIT 20;
-- All 0 = ingest not inserting items (cursor? or 0 qualified in ingest).

-- 5) What the free feed RPC would return (if it uses latest snapshot)
-- Uncomment and run to see actual rows (or empty):
/*
SELECT * FROM public.layer_qualified(60) LIMIT 5;
*/
