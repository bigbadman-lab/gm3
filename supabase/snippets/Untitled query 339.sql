select
  n.nspname as schema,
  p.proname as name,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'get_due_ath_mints';
