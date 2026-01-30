-- 012_fix_blocked_creators_wallet_column.sql
-- Align blocked_creators schema with existing code expecting column `wallet`.

-- If the table was created with `creator`, rename it to `wallet`.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'blocked_creators'
      and column_name = 'creator'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'blocked_creators'
      and column_name = 'wallet'
  ) then
    alter table public.blocked_creators rename column creator to wallet;
  end if;
end $$;

-- Ensure wallet is the primary key (in case it wasn't created that way).
do $$
begin
  -- Drop any existing primary key constraint on blocked_creators (unknown name),
  -- then add wallet as PK if not already.
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'blocked_creators'
      and constraint_type = 'PRIMARY KEY'
  ) then
    -- find and drop the existing PK constraint
    execute (
      select 'alter table public.blocked_creators drop constraint ' || quote_ident(tc.constraint_name)
      from information_schema.table_constraints tc
      where tc.table_schema = 'public'
        and tc.table_name = 'blocked_creators'
        and tc.constraint_type = 'PRIMARY KEY'
      limit 1
    );
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'blocked_creators'
      and column_name = 'wallet'
  ) then
    alter table public.blocked_creators add primary key (wallet);
  end if;
end $$;
