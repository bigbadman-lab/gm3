-- One-off: verify mint DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm appears in alertworthy feed after Option 3 (no rug filter).
-- Run after applying migration 20260205000000_alertworthy_premium_feed_no_rug_filter.sql and ensuring v_layer_alertworthy_60 uses layer_alertworthy_premium_feed(60,'06:00:00',25).

select * from public.v_layer_alertworthy_60 where mint = 'DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm';

-- If the view in your deployment still uses layer_alertworthy(60) (two consecutive snapshots), use the premium feed directly:
-- select * from public.layer_alertworthy_premium_feed(60, '06:00:00', 25) where mint = 'DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm';
