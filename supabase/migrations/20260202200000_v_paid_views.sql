-- Paid feed views used by gm3-api

drop view if exists public.v_paid_alertworthy_60;
drop view if exists public.v_paid_investable_60;

create view public.v_paid_alertworthy_60 as
select * from public.layer_alertworthy(60);

create view public.v_paid_investable_60 as
select * from public.layer_investable(60);

grant select on public.v_paid_alertworthy_60 to anon, authenticated;
grant select on public.v_paid_investable_60 to anon, authenticated;
