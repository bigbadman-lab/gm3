-- Make paid views wrap the existing layer views (works reliably via PostgREST)

drop view if exists public.v_paid_alertworthy_60;
drop view if exists public.v_paid_investable_60;

create view public.v_paid_alertworthy_60 as
select * from public.v_layer_alertworthy_60;

create view public.v_paid_investable_60 as
select * from public.v_layer_investable_60;

grant select on public.v_paid_alertworthy_60 to anon, authenticated;
grant select on public.v_paid_investable_60 to anon, authenticated;
