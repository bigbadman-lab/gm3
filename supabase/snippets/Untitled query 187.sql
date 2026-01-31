select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'net'
  and table_name = '_http_response'
order by ordinal_position;
