-- QR device pairing: pending pairings and linked devices (one extra device per root session).

create table if not exists public.device_pairings (
  id uuid primary key default gen_random_uuid(),
  root_session_id uuid not null,
  code text unique not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  consumed_by_device_id text,
  consumed_user_agent text,
  consumed_ip text
);

create index if not exists idx_device_pairings_root_created
  on public.device_pairings (root_session_id, created_at desc);

create table if not exists public.device_links (
  root_session_id uuid primary key,
  linked_session_id uuid not null,
  linked_device_id text not null,
  linked_device_label text,
  linked_user_agent text,
  linked_created_at timestamptz not null default now(),
  linked_last_seen_at timestamptz,
  revoked_at timestamptz
);

grant select, insert, update on public.device_pairings to service_role;
grant select, insert, update on public.device_links to service_role;
