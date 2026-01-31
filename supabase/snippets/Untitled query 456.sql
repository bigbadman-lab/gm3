drop trigger if exists trg_set_inflow_signal_fields on public.trending_items;

create trigger trg_set_inflow_signal_fields
before insert or update of net_sol_inflow, is_qualified, fdv_usd
on public.trending_items
for each row
execute function public.set_inflow_signal_fields();
