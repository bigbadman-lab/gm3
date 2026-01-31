select
  n.nspname as schema,
  p.proname as name,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  p.proargnames as arg_names,
  p.proargtypes::regtype[] as arg_types
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_ath_for_mint';
