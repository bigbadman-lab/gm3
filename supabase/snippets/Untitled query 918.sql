with winners(mint) as (
  values
    ('j5GaaxevMtGGQUTwGLj2hixnhZVg4UdPejMsxiKpump'),
    ('D35Lzon7n9pwVgguJcd7QoibYTToLwwmz4Q8YAndpump'),
    ('G23d3GZ6rsotjCJAJkzECVSare2RWjgv4naA922Hpump'),
    ('EkJo3iq8R1A5iVP15sMaNGymmtiJ2dRg85uJ7NL4pump'),
    ('3GwyDM2wm2CtoLD7Mfrg9T7ipExXGhnbDNW8xNAH5uKw')
)
select
  l.mint,
  l.updated_at,
  l.net_sol_inflow,
  l.fdv_usd,
  (l.net_sol_inflow / nullif(l.fdv_usd, 0)) as inflow_per_fdv,
  ((l.net_sol_inflow * 200.0) / nullif(l.fdv_usd, 0)) as capital_efficiency_est
from public.trending_items_latest l
join winners w using (mint)
order by capital_efficiency_est asc;
