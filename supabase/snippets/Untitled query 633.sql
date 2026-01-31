with failed(mint) as (
  values
    ('79K2aLUn54joeqpu5vVY1YH1wNcFD3UsnTHPTCiCpump'),
    ('Egh5h3nAdEvR9L1fYsWF34sB2HPKKvyHGVeAn33apump'),
    ('7YHPRLbPk3baqEVYBi1MEcdmaKdRdUnCBukedZGwpump'),
    ('6kdcSRxRQHsSEns1CNnBzoQh88L77XALj5wVyDWUpump'),
    ('GCBm3eHhX3MbTFUj2G5Hs5U6ADstExQugRgjiiciBRjr'),
    ('45BrTfUKsC6e1ZexDCLW4Ta3LFezjhW54LAuArmV3Fjx'),
    ('4RT2ukNxjLHa6MZzATMRj4pwL1eBjW94mo23HNa2pump'),
    ('EwxwJ2MRNHkfCDi1v3E1tdqsgMgbMaDoL5pxksE8pump'),
    ('Dq6KoT3XiZodMkLrbqW4FUo5ZDvTRVhFgX4PXbh8pump'),
    ('DZridTgcMLtRpV8NLDRJ5SisrFrwPUvL91XKbsvGpump')
)
select
  l.mint,
  l.updated_at,
  l.net_sol_inflow,
  l.fdv_usd,
  -- quick proxy (units mismatch but useful for ranking)
  (l.net_sol_inflow / nullif(l.fdv_usd, 0)) as inflow_per_fdv,
  -- proper capital efficiency using constant SOL/USD
  ((l.net_sol_inflow * 200.0) / nullif(l.fdv_usd, 0)) as capital_efficiency_est
from public.trending_items_latest l
join failed f using (mint)
order by capital_efficiency_est asc nulls last;
