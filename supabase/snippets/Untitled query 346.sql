select
  mint,
  updated_at,
  net_sol_inflow,
  inflow_band_reason,
  is_alertworthy,
  fdv_usd,
  swap_count,
  unique_buyers,
  buy_ratio
from public.trending_items_latest
where mint in (
  'EkJo3iq8R1A5iVP15sMaNGymmtiJ2dRg85uJ7NL4pump',
  'D35Lzon7n9pwVgguJcd7QoibYTToLwwmz4Q8YAndpump'
);
