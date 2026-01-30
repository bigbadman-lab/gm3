-- 011_blocked_creators.sql
-- Creators we never want to show in feeds (manual moderation / hygiene).

create table if not exists public.blocked_creators (
  creator text primary key,
  reason text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blocked_creators_is_active_idx
  on public.blocked_creators (is_active);

-- Keep updated_at fresh
create or replace function public.set_blocked_creators_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_blocked_creators_updated_at on public.blocked_creators;

create trigger set_blocked_creators_updated_at
before update on public.blocked_creators
for each row execute function public.set_blocked_creators_updated_at();
