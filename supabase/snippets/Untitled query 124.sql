status = case when entry_ts < (v_now - interval '7 days') then 'archived' else status end,
