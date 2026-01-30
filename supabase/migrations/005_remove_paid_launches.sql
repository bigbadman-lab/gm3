-- 005_remove_paid_launches.sql
-- Removes paid launch-slot schema now that GM3 no longer offers paid launches.

drop view if exists public.launches_today;
drop table if exists public.launch_claims;
drop table if exists public.launch_slots;
