select
  cron.schedule(
    'gm3-ath-updater-every-minute',
    '* * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret
                from vault.decrypted_secrets
                where name = 'project_url')
              || '/functions/v1/ath-updater',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' ||
            (select decrypted_secret
             from vault.decrypted_secrets
             where name = 'ath_updater_token')
        ),
        body := '{}'::jsonb
      );
    $$
  );
