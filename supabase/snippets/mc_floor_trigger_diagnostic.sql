-- MC floor (Alertworthy) diagnostic: check if the trigger is the cause of 0 items.
-- Run in Supabase SQL Editor.

-- 1) Current trigger function source: expect MC floor 8000, inflow band 10–70. Any syntax/ref errors?
SELECT pg_get_functiondef(oid) AS trigger_source
FROM pg_proc
WHERE proname = 'set_inflow_signal_fields';

-- 2) Quick test: would a single insert succeed? (Uses a real snapshot id; rollback so no side effect.)
-- Replace the snapshot_id with one from: SELECT id FROM trending_snapshots WHERE window_seconds = 60 ORDER BY window_end DESC LIMIT 1;
/*
BEGIN;
INSERT INTO public.trending_items (
  snapshot_id, rank, mint, swap_count, fdv_usd,
  signal_touch_count, signal_points, buy_count, sell_count, unique_buyers,
  net_sol_inflow, buy_ratio, is_qualified
) VALUES (
  (SELECT id FROM public.trending_snapshots WHERE window_seconds = 60 ORDER BY window_end DESC LIMIT 1),
  999, 'TestMintMcFloorDiagnostic000000000000000000000', 15, null,
  0, 0, 12, 3, 8, 25.5, 0.8, true
);
ROLLBACK;
*/
-- If the INSERT fails, the error message will point to the trigger (e.g. column missing, type error).

-- 3) Count of trending_items in latest 60s snapshots (sanity check)
SELECT ts.window_end, count(ti.mint) AS items
FROM public.trending_snapshots ts
LEFT JOIN public.trending_items ti ON ti.snapshot_id = ts.id
WHERE ts.window_seconds = 60
GROUP BY ts.window_end
ORDER BY ts.window_end DESC
LIMIT 10;
