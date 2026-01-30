update signal_wallets
set is_active = false, label = 'disabled (test actor wallet)'
where label = 'test actor wallet (forced overlap)';
