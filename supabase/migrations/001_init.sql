-- Enable useful extensions
create extension if not exists pgcrypto;

-- =========================
-- 1) TRENDING SNAPSHOTS
-- =========================
-- One snapshot per "window", e.g. every 30s or 60s, representing last 10 minutes.
-- Store only top N per snapshot.

create table if not exists trending_snapshots (
  id uuid primary key default gen_random_uuid(),
  window_seconds int not null default 600,                -- 10 min
  window_end timestamptz not null,                        -- window end time (UTC)
  created_at timestamptz not null default now(),
  unique (window_seconds, window_end)
);

create index if not exists idx_trending_snapshots_window_end
  on trending_snapshots (window_end desc);

create table if not exists trending_items (
  snapshot_id uuid not null references trending_snapshots(id) on delete cascade,
  rank int not null,                                      -- 1..N
  mint text not null,
  swap_count int not null,
  fdv_usd numeric(20,2),                                  -- computed & cached
  price_usd numeric(20,10),                               -- optional for debugging
  total_supply numeric(40,0),                             -- optional for debugging
  updated_at timestamptz not null default now(),
  primary key (snapshot_id, rank),
  unique (snapshot_id, mint)
);

create index if not exists idx_trending_items_mint
  on trending_items (mint);

-- =========================
-- 2) GM3 WATCHLIST (HUMAN SIGNAL)
-- =========================
-- We store:
-- (A) An event log of GM taps (optional but useful for abuse analysis)
-- (B) A daily aggregate table used by the app/API

create table if not exists watchlist_gm_events (
  id uuid primary key default gen_random_uuid(),
  day date not null,                                      -- UTC day
  device_id_hash text not null,                           -- hash of device identifier (never store raw)
  mint text not null,
  created_at timestamptz not null default now(),
  -- Enforce at most 3 taps per device per day:
  -- We'll enforce in Edge Function, but also track quickly:
  -- (no hard constraint here because it requires counting; keep schema simple)
  -- Optional: prevent duplicate mint selection per device per day:
  unique (day, device_id_hash, mint)
);

create index if not exists idx_watchlist_gm_events_day
  on watchlist_gm_events (day);

create index if not exists idx_watchlist_gm_events_mint_day
  on watchlist_gm_events (mint, day);

-- Daily aggregate used for ranking in app
create table if not exists watchlist_daily (
  day date not null,                                      -- UTC day
  mint text not null,
  gm_count int not null default 0,
  fdv_usd numeric(20,2),
  price_usd numeric(20,10),
  total_supply numeric(40,0),
  updated_at timestamptz not null default now(),
  primary key (day, mint)
);

create index if not exists idx_watchlist_daily_day_gm_count
  on watchlist_daily (day desc, gm_count desc);

-- =========================
-- 3) TOKEN METADATA CACHE (OPTIONAL BUT VERY USEFUL)
-- =========================
-- Keeps your pipeline fast and avoids refetching supply/name/symbol constantly.

create table if not exists token_cache (
  mint text primary key,
  token_name text,
  token_symbol text,
  image_url text,
  total_supply numeric(40,0),
  last_supply_at timestamptz,
  price_usd numeric(20,10),
  last_price_at timestamptz,
  fdv_usd numeric(20,2),
  updated_at timestamptz not null default now()
);

create index if not exists idx_token_cache_updated_at
  on token_cache (updated_at desc);

-- =========================
-- 4) PUBLIC "LATEST JSON" SNAPSHOTS (TERMINAL/BOTS)
-- =========================
-- Store the most recent combined payload for ultra-fast reads.

create table if not exists public_snapshots (
  key text primary key,                                   -- e.g. 'latest.json'
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- =========================
-- RLS (Read-only public)
-- =========================
alter table trending_snapshots enable row level security;
alter table trending_items enable row level security;
alter table watchlist_daily enable row level security;
alter table token_cache enable row level security;
alter table public_snapshots enable row level security;

-- Public can read these:
create policy "public read trending_snapshots"
  on trending_snapshots for select
  using (true);

create policy "public read trending_items"
  on trending_items for select
  using (true);

create policy "public read watchlist_daily"
  on watchlist_daily for select
  using (true);

create policy "public read token_cache"
  on token_cache for select
  using (true);

create policy "public read public_snapshots"
  on public_snapshots for select
  using (true);

-- Do NOT allow public inserts/updates/deletes on any table.
-- Writes should happen via Edge Functions with service role.


