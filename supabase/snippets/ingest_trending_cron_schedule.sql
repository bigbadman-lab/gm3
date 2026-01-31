-- Schedule ingest-trending every minute. Requires Vault secret 'ingest_trending_token' (or use 'ath_updater_token' if shared).
-- project_url is already in Vault.
select cron.schedule(
  'ingest-trending-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/ingest-trending',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ingest_trending_token')
    ),
    body := '{}'::jsonb
  );
  $$
);
