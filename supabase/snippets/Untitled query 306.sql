-- 1) Track creator wallet in token cache
alter table token_cache
add column if not exists creator_wallet text,
add column if not exists first_seen_at timestamptz;

create index if not exists idx_token_cache_creator_wallet
  on token_cache (creator_wallet);

-- 2) Blocklist by creator/deployer wallet
create table if not exists blocked_creators (
  wallet text primary key,
  reason text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Optional: block specific mints
create table if not exists blocked_mints (
  mint text primary key,
  reason text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: public can read (optional), but safer to allow read-only
alter table blocked_creators enable row level security;
alter table blocked_mints enable row level security;

create policy "public read blocked_creators"
  on blocked_creators for select using (true);

create policy "public read blocked_mints"
  on blocked_mints for select using (true);
