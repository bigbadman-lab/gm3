-- mint_any_latest: return found=true if mint is in token_cache (preferred) or mint_entries (fallback).
-- Same signature; language sql, stable.

create or replace function public.mint_any_latest(p_mint text)
returns table (
  found boolean,
  mint text,
  updated_at timestamptz,
  fdv_usd numeric,
  price_usd numeric,
  token_name text,
  token_symbol text,
  image_url text,
  deployer_wallet text
)
language sql
stable
as $$
  select
    (tc.mint is not null or me.mint is not null) as found,
    coalesce(tc.mint, me.mint, p_mint) as mint,
    coalesce(tc.updated_at, me.entry_ts) as updated_at,
    coalesce(tc.fdv_usd, me.entry_fdv_usd) as fdv_usd,
    tc.price_usd,
    tc.token_name,
    tc.token_symbol,
    tc.image_url,
    tc.deployer_wallet
  from (select 1) _
  left join public.token_cache tc on tc.mint = p_mint
  left join public.mint_entries me on me.mint = p_mint
  limit 1;
$$;
