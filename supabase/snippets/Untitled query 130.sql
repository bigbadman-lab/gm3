select mint, swap_count, price_usd, total_supply, fdv_usd
from trending_items
where fdv_usd is null or price_usd is null or total_supply is null
order by swap_count desc nulls last
limit 10;
