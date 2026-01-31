select mint, price_usd, total_supply, fdv_usd, updated_at
from trending_items
where mint = 'AosshFjcGwH7NXn58VhgvoVdfXsa8BqzyDoZAQWdpump';
select
  count(*) as total_mints,
  sum(case when coalesce(signal_touch_count,0) > 0 then 1 else 0 end) as mints_with_signal,
  sum(coalesce(signal_touch_count,0)) as total_signal_touches,
  sum(coalesce(signal_points,0)) as total_signal_points
from trending_items
where snapshot_id = '867ee999-03c9-42a2-a657-f73aca757a11';
