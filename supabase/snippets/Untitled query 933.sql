insert into watchlist_daily (day, mint, gm_count, fdv_usd)
values
  (current_date, 'FakeMint111111111111111111111111111111', 12, 12345678),
  (current_date, 'FakeMint999999999999999999999999999999', 7, 2222222)
on conflict (day, mint) do update
set gm_count = excluded.gm_count,
    fdv_usd = excluded.fdv_usd,
    updated_at = now();
