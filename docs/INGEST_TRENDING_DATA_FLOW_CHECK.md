# Checking if ingest-trending data is flowing (UI not updating)

Use these in order to see where the pipeline might be stuck.

---

## 1. Is the cron job actually running?

In **Supabase SQL Editor**:

```sql
-- Recent runs of the ingest-trending cron job (jobid 14 = gm3-ingest-trending-60s-layer1)
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'gm3-ingest-trending-60s-layer1')
order by start_time desc
limit 10;
```

- **status:** `succeeded` = cron ran and the HTTP request was sent.  
- **return_message:** If the Edge Function returned an error body, it may appear here (or in function logs).  
- If there are **no rows** or very old `start_time`, the cron may not be firing.

---

## 2. Is the cursor advancing? (Helius data being consumed)

```sql
select name, last_signature, updated_at
from public.ingest_state
where name = 'ingest-trending';
```

- **last_signature** should be a non-null tx signature.  
- **updated_at** should be recent (e.g. within the last few minutes if cron runs every minute).  
- If `last_signature` is null and never updates, the function may be failing before writing, or Helius may be returning no data.

---

## 3. Are new snapshots and items being written?

```sql
-- Latest snapshot windows
select id, window_seconds, window_end, created_at
from public.trending_snapshots
where window_seconds = 60
order by window_end desc
limit 5;
```

```sql
-- Count of trending_items for the latest 60s snapshot
select count(*) as items_count
from public.trending_items ti
join public.trending_snapshots ts on ts.id = ti.snapshot_id
where ts.window_seconds = 60
  and ts.window_end = (select max(window_end) from public.trending_snapshots where window_seconds = 60);
```

- **window_end** should be recent (within the last few minutes).  
- **items_count** > 0 means the UI’s “latest” snapshot has mints (free/paid feeds read from this).

If `window_end` is old and not moving, ingest-trending is either not running, not receiving Helius data, or failing before the DB writes.

---

## 4. What the UI reads (sanity check)

- **Free feed:** `GET /v1/free/qualified` → RPC `free_qualified_feed` → uses latest 60s snapshot + qualified items.  
- **Paid investable:** `GET /v1/paid/investable` (with Bearer) → view `v_paid_investable_60_v2` → built from `v_layer_investable_60` → latest 60s snapshot.  
- **Paid alertworthy:** `GET /v1/paid/alertworthy` → `v_paid_alertworthy_60` → latest 60s snapshot.

So **all feeds depend on the latest 60s snapshot having rows in `trending_items`**. If the latest snapshot is old or empty, the UI will look stale.

Quick check that the “latest” snapshot has data:

```sql
select max(ts.window_end) as latest_window_end,
       count(ti.mint)     as item_count
from public.trending_snapshots ts
left join public.trending_items ti on ti.snapshot_id = ts.id
where ts.window_seconds = 60
  and ts.window_end = (select max(window_end) from public.trending_snapshots where window_seconds = 60);
```

- **latest_window_end** should be recent.  
- **item_count** should be > 0 for the UI to show anything.

---

## 5. Edge Function logs (Supabase Dashboard)

1. **Project → Edge Functions → ingest-trending → Logs.**  
2. Look for recent invocations (every minute).  
3. Check for **200** and response body like `{"ok":true,"ingested_count":1,"windows":[...]}`.  
4. If you see **401** (auth), **500** (e.g. Helius/DB error), or no recent logs, the cron may be failing to call the function or the function may be failing.

Common issues:

- **401:** `x-cron-token` in Vault (`ingest_trending_token`) doesn’t match `INGEST_TRENDING_TOKEN` in the function’s env.  
- **500:** Missing env (e.g. `HELIUS_API_KEY`, `PUMPFUN_ADDRESS`), Helius timeout, or DB error.  
- **200 but ingested_count 0:** Helius returned no (or no new) transactions for the window; cursor may already be at “now” so no new windows to fill.

---

## 6. Quick “is anything recent?” query

Run this once:

```sql
select
  (select updated_at from public.ingest_state where name = 'ingest-trending') as cursor_updated_at,
  (select max(window_end) from public.trending_snapshots where window_seconds = 60) as latest_snapshot_end,
  (select count(*) from public.trending_items ti
   join public.trending_snapshots ts on ts.id = ti.snapshot_id
   where ts.window_seconds = 60
     and ts.window_end = (select max(window_end) from public.trending_snapshots where window_seconds = 60)) as items_in_latest_snapshot;
```

- **cursor_updated_at** and **latest_snapshot_end** should be within the last few minutes if the pipeline is healthy.  
- **items_in_latest_snapshot** > 0 means the UI has data to show for the current “latest” snapshot.

If the UI still doesn’t update, the frontend may be caching, or calling a different endpoint/project than the one you’re checking.
