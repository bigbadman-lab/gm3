select mint, price_usd, total_supply, fdv_usd, updated_at
from trending_items
where fdv_usd is not null
order by updated_at desc
limit 5;
