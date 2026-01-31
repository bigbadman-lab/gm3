select count(*) as with_fdv
from trending_items
where fdv_usd is not null;
