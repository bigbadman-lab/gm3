select
  column_name
from information_schema.columns
where table_name = 'trending_items'
order by column_name;
