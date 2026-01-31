select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'trending_items'
  and column_name in ('capital_efficiency', 'mc_structure_ok', 'mc_structure_reason');
