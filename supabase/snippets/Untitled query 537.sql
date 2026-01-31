select is_qualified, count(*) as n
from trending_items
group by is_qualified
order by is_qualified;
