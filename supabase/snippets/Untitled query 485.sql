select
  jobid,
  jobname,
  schedule
from cron.job
where jobname = 'gm3-ath-updater-every-minute';
