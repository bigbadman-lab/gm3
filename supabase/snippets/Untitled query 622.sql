select count(*) as active_signal_wallets
from signal_wallets
where is_active = true;
