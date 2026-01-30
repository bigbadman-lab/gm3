-- 010_blocked_mints.sql
-- Tokens we never want to show in feeds (manual moderation / hygiene).

create table if not exists public.blocked_mints (
  mint text primary key,
  reason text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blocked_mints_is_active_idx
  on public.blocked_mints (is_active);

-- Keep updated_at fresh
create or replace function public.set_blocked_mints_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_blocked_mints_updated_at on public.blocked_mints;

create trigger set_blocked_mints_updated_at
before update on public.blocked_mints
for each row execute function public.set_blocked_mints_updated_at();
