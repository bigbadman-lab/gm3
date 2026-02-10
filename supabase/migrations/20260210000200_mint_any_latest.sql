-- mint_any_latest: lookup a mint in token_cache; returns one row (found=true with data, or found=false with nulls).

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
    (t.mint is not null) as found,
    coalesce(t.mint, p_mint) as mint,
    t.updated_at,
    t.fdv_usd,
    t.price_usd,
    t.token_name,
    t.token_symbol,
    t.image_url,
    t.deployer_wallet
  from (select 1) _
  left join public.token_cache t on t.mint = p_mint
  limit 1;
$$;
