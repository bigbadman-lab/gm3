create or replace view public.trending_items_latest as
select distinct on (mint)
  *
from public.trending_items
order by mint, updated_at desc;
