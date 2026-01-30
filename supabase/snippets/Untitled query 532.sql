select wallet, tier, weight, is_active, created_at
from signal_wallets
where is_active = true
order by created_at desc;
