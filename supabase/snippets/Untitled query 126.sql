select relrowsecurity
from pg_class
where relname = 'trending_items';
