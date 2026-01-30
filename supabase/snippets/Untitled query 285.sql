insert into launch_slots (day, slot)
select current_date, s
from generate_series(1,5) s
on conflict do nothing;
