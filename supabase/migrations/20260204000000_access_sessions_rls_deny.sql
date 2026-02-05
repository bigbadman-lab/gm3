-- Harden public.access_sessions: no client-side access (anon/authenticated).
-- All access is server-side via service_role in Edge Functions; service_role bypasses RLS.
-- Ensures token_hash, expires_at, last_used_at, method, tier are never readable by clients.

alter table public.access_sessions enable row level security;
alter table public.access_sessions force row level security;

revoke all on table public.access_sessions from anon, authenticated;
revoke all on table public.access_sessions from public;

drop policy if exists "deny_client_access" on public.access_sessions;

create policy "deny_client_access"
on public.access_sessions
for all
to anon, authenticated
using (false)
with check (false);
