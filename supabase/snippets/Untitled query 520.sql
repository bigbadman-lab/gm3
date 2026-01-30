-- 1) Create a fake snapshot ending "now"
insert into trending_snapshots (window_seconds, window_end)
values (600, now())
returning id;
