select
  jobid,
  status,
  start_time,
  end_time,
  return_message
from cron.job_run_details
where jobid in (
  select jobid from cron.job where jobname = 'gm3-ath-updater-every-minute'
)
order by start_time desc
limit 10;
