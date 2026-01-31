select trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_table = 'trending_items'
order by trigger_name;
