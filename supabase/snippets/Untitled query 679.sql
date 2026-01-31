select
  count(*) filter (where fdv_usd is not null) as with_fdv,
  count(*) as total
from trending_items;
insert into signal_wallets (wallet, tier, weight, label, is_active)
values
  (
    'suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK',
    1,
    1,
    'additional signal wallet',
    true
  );
