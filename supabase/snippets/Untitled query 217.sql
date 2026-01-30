-- 009_payments.sql
-- Optional: record on-chain payments for API key purchases.

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),

  -- The API key this payment is associated with (if known).
  api_key_id uuid null references public.api_keys(id) on delete set null,

  -- Solana transaction signature
  tx_signature text not null unique,

  -- Wallet that paid
  payer_wallet text not null,

  -- Amount in SOL (store as numeric for precision)
  amount_sol numeric not null,

  -- basic | unlimited (what this payment purchased)
  purchased_tier text not null,

  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_purchased_tier_check'
  ) then
    alter table public.payments
      add constraint payments_purchased_tier_check
      check (purchased_tier in ('basic', 'unlimited'));
  end if;
end $$;

create index if not exists payments_api_key_id_idx
  on public.payments (api_key_id);

create index if not exists payments_payer_wallet_idx
  on public.payments (payer_wallet);

create index if not exists payments_created_at_idx
  on public.payments (created_at desc);
