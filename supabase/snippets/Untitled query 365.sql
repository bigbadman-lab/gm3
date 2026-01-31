select
  created,
  status_code,
  timed_out,
  error_msg,
  left(content, 200) as content_preview
from net._http_response
order by created desc
limit 10;
