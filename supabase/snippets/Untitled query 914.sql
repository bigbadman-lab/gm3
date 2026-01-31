select
  jobid,
  jobname,
  schedule,
  command
from cron.job
where jobname = 'gm3-ath-updater-every-minute';
