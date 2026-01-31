select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'trending_items_latest'
order by ordinal_position;
