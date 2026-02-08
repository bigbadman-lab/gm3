-- GM3 v1 Developer API Keys
-- Stores ONLY hashes (never raw keys).
-- Keys are tied to an existing access session entitlement via access_session_id.
--
-- Idempotent: PROD may already have public.api_keys with a different schema (e.g. from 20260202195000).
-- We create table if not exists for fresh envs, then ALTER to add missing columns and constraints.

begin;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),

  access_session_id uuid not null
    references public.access_sessions(id)
    on delete cascade,

  -- sha256(md5(raw)) or whatever your existing scheme is (see edge code).
  key_hash text not null unique,

  label text null,

  is_active boolean not null default true,
  revoked_at timestamptz null,

  created_at timestamptz not null default now(),

  -- tracking
  last_used_at timestamptz null,
  last_used_ip inet null,

  -- optional: future-proofing
  scopes text[] not null default '{}'::text[]
);

-- Ensure required columns exist on existing tables (e.g. PROD has api_keys without access_session_id).
alter table public.api_keys add column if not exists access_session_id uuid;
alter table public.api_keys add column if not exists key_hash text;
alter table public.api_keys add column if not exists label text;
alter table public.api_keys add column if not exists is_active boolean default true;
alter table public.api_keys add column if not exists revoked_at timestamptz;
alter table public.api_keys add column if not exists created_at timestamptz default now();
alter table public.api_keys add column if not exists last_used_at timestamptz;
alter table public.api_keys add column if not exists last_used_ip inet;
alter table public.api_keys add column if not exists scopes text[] default '{}'::text[];

-- FK on access_session_id only if missing (avoids 42P16 if constraint already exists).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.api_keys'::regclass
      and conname = 'api_keys_access_session_id_fkey'
  ) then
    alter table public.api_keys
      add constraint api_keys_access_session_id_fkey
      foreign key (access_session_id) references public.access_sessions(id) on delete cascade;
  end if;
end $$;

-- Unique index on key_hash (not table constraint) so key_hash is unique where present.
create unique index if not exists api_keys_key_hash_key on public.api_keys(key_hash);

-- Indexes only after columns exist.
create index if not exists api_keys_access_session_id_idx on public.api_keys(access_session_id);
create index if not exists api_keys_is_active_idx on public.api_keys(is_active);

comment on table public.api_keys is 'Programmatic API keys, hashed only, tied to access_sessions entitlement.';
comment on column public.api_keys.key_hash is 'Hash of raw gm3_key_* token; raw token is never stored.';

-- Basic rate-limiting state (per key + per ip, fixed window).
create table if not exists public.api_rate_limits (
  key_hash text not null,
  ip inet not null,
  window_start timestamptz not null,
  request_count int not null default 0,
  primary key (key_hash, ip, window_start)
);

comment on table public.api_rate_limits is 'Fixed-window counters for per-key + per-IP rate limiting.';

-- Helper RPC: increments and returns whether allowed.
-- Example: 60 req/min per key+ip. Tune in code by passing params.
create or replace function public.rate_limit_check_and_inc(
  p_key_hash text,
  p_ip inet,
  p_window_seconds int,
  p_max_requests int
)
returns table(allowed boolean, remaining int, reset_at timestamptz)
language plpgsql
security definer
as $$
declare
  v_window_start timestamptz := date_trunc('second', now())
    - make_interval(secs => (extract(epoch from now())::int % p_window_seconds));
  v_count int;
begin
  insert into public.api_rate_limits(key_hash, ip, window_start, request_count)
  values (p_key_hash, p_ip, v_window_start, 1)
  on conflict (key_hash, ip, window_start)
  do update set request_count = public.api_rate_limits.request_count + 1;

  select request_count into v_count
  from public.api_rate_limits
  where key_hash = p_key_hash and ip = p_ip and window_start = v_window_start;

  allowed := (v_count <= p_max_requests);
  remaining := greatest(p_max_requests - v_count, 0);
  reset_at := v_window_start + make_interval(secs => p_window_seconds);
  return next;
end;
$$;

-- RLS
alter table public.api_keys enable row level security;
alter table public.api_rate_limits enable row level security;

-- No accounts -> lock these tables down and access via edge function service role only.
drop policy if exists "deny all api_keys" on public.api_keys;
create policy "deny all api_keys" on public.api_keys
for all using (false) with check (false);

drop policy if exists "deny all api_rate_limits" on public.api_rate_limits;
create policy "deny all api_rate_limits" on public.api_rate_limits
for all using (false) with check (false);

commit;
