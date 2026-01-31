select mint, count(*)
from public.trending_items_latest
group by mint
having count(*) > 1;
