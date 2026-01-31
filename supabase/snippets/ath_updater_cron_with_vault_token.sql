-- 1) Store the cron token in Vault (run once; replace <REPLACE_WITH_YOUR_TOKEN> with a strong random token).
--    Generate one with: openssl rand -base64 32
select vault.create_secret(
  '<REPLACE_WITH_YOUR_TOKEN>',
  'ath_updater_token'
);

-- 2) Unschedule the existing cron job (if it exists)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'gm3-ath-updater-every-minute') then
    perform cron.unschedule('gm3-ath-updater-every-minute');
  end if;
end $$;

-- 3) Reschedule: call ath-updater every minute with Authorization: Bearer <token> from Vault (no anon key)
select cron.schedule(
  'gm3-ath-updater-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/ath-updater',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ath_updater_token')
    ),
    body := '{}'::jsonb
  );
  $$
);
