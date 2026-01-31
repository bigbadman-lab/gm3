select mint, symbol
from trending_items
where is_qualified = true
limit 20;
