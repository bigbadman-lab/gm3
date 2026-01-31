select mint, swap_count, price_usd, total_supply, fdv_usd, updated_at
from trending_items
where is_qualified = true
order by updated_at desc
limit 20;
