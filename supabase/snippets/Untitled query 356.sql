create index if not exists idx_trending_items_alertworthy_updated_at
on public.trending_items (is_alertworthy, updated_at desc);
