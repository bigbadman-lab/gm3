select mint, swap_count, is_qualified, fdv_usd, price_usd, total_supply
from trending_items
order by swap_count desc nulls last
limit 10;
