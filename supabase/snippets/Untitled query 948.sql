select count(*) as need_enrichment
from trending_items
where fdv_usd is null or price_usd is null or total_supply is null;
