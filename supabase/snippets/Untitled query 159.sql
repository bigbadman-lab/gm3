select column_name, data_type
from information_schema.columns
where table_name = 'trending_items'
order by ordinal_position;
