-- Re-enable ingest-trending: schedule pg_cron job (same name as prod: gm3-ingest-trending-60s-layer1).
-- Requires Vault secrets: project_url, ingest_trending_token.
-- Run this in Supabase SQL Editor after unscheduling (ingest_trending_cron_unschedule.sql).
select cron.schedule(
  'gm3-ingest-trending-60s-layer1',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/ingest-trending',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'ingest_trending_token')
    ),
    body := '{}'::jsonb
  );
  $$
);
