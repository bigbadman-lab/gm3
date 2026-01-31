select table_schema, table_name
from information_schema.views
where table_name = 'trending_items_latest';
