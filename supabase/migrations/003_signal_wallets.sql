-- Curated signal wallets
create table if not exists signal_wallets (
  wallet text primary key,
  tier int not null default 2 check (tier between 1 and 3),
  weight int not null default 2,
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_signal_wallets_active
  on signal_wallets (is_active);

-- Add per-snapshot signal fields to trending items
alter table trending_items
  add column if not exists signal_touch_count int not null default 0,
  add column if not exists signal_points int not null default 0;

