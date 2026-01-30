insert into trending_items (snapshot_id, rank, mint, swap_count, fdv_usd)
values
  ('bd726772-8c7c-4526-8868-f729a9c831e3', 1, 'FakeMint111111111111111111111111111111', 42, 12345678),
  ('bd726772-8c7c-4526-8868-f729a9c831e3', 2, 'FakeMint222222222222222222222222222222', 31, 9876543),
  ('bd726772-8c7c-4526-8868-f729a9c831e3', 3, 'FakeMint333333333333333333333333333333', 18, 5550000);
insert into watchlist_daily (day, mint, gm_count, fdv_usd)
values
  (current_date, 'FakeMint111111111111111111111111111111', 12, 12345678),
  (current_date, 'FakeMint999999999999999999999999999999', 7, 2222222)
on conflict (day, mint) do update
set gm_count = excluded.gm_count,
    fdv_usd = excluded.fdv_usd,
    updated_at = now();
