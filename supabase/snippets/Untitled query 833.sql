create or replace function public.get_due_ath_mints(lim int default 20)
returns table (
  mint text,
  entry_ts timestamptz,
  entry_fdv_usd numeric,
  ath_fdv_usd numeric
)
language sql
security definer
as $$
  with due as (
    select a.mint
    from public.token_ath a
    join public.mint_entries e using (mint)
    where a.status = 'active'
      and a.next_check_ts <= now()
    order by a.next_check_ts asc
    limit lim
    for update skip locked
  )
  select
    d.mint,
    e.entry_ts,
    e.entry_fdv_usd,
    coalesce(a.ath_fdv_usd, e.entry_fdv_usd) as ath_fdv_usd
  from due d
  join public.mint_entries e on e.mint = d.mint
  join public.token_ath a on a.mint = d.mint;
$$;
