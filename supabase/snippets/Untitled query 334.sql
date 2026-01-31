create or replace function public.compute_next_check_ts(entry_ts timestamptz, now_ts timestamptz)
returns timestamptz
language sql
as $$
  select
    case
      when now_ts - entry_ts < interval '6 hours' then now_ts + interval '1 minute'
      when now_ts - entry_ts < interval '24 hours' then now_ts + interval '10 minutes'
      when now_ts - entry_ts < interval '7 days' then now_ts + interval '12 hours'
      else now_ts + interval '365 days' -- effectively never; we’ll mark archived separately
    end;
$$;
