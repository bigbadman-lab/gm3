-- Pause ingest-trending: remove the pg_cron job so Helius is not called.
-- Job name in prod: gm3-ingest-trending-60s-layer1 (calls /functions/v1/ingest-trending every minute).
-- Run this in Supabase SQL Editor. Safe to run even if the job was already removed.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'gm3-ingest-trending-60s-layer1') then
    perform cron.unschedule('gm3-ingest-trending-60s-layer1');
    raise notice 'Unscheduled gm3-ingest-trending-60s-layer1';
  else
    raise notice 'Job gm3-ingest-trending-60s-layer1 not found (already paused or never scheduled)';
  end if;
end $$;
