# Alertworthy Option 3: no rug filter + rug warning fields

## Summary

- **SQL:** `layer_alertworthy_premium_feed` no longer excludes high buy_ratio mints (rug filter removed). Migration: `20260205000000_alertworthy_premium_feed_no_rug_filter.sql`.
- **API:** Paid alertworthy response adds `rug_risk` (boolean) and `rug_risk_reason` (text). Backfill param `?mint=...` forces inclusion of a specific mint from `trending_items` when it’s not in the main feed (e.g. lookback expiry).

## A) SQL migration

- **File:** `supabase/migrations/20260205000000_alertworthy_premium_feed_no_rug_filter.sql`
- **Effect:** `CREATE OR REPLACE FUNCTION public.layer_alertworthy_premium_feed(p_window_seconds, p_lookback_time, p_limit)` with the same return type; body has **no** `AND (total_trades < 15 OR buy_ratio <= 0.70)` (or equivalent). All alertworthy mints in the latest snapshot within lookback are returned.
- **Views:** In this repo, `v_layer_alertworthy_60` is left as `layer_alertworthy(60)`. If in prod you use `v_layer_alertworthy_60 = select * from layer_alertworthy_premium_feed(60,'06:00:00',25)`, run the migration there so the function is replaced; no view change needed.

## B) API (paid alertworthy)

- **Route:** `GET /v1/paid/alertworthy` (Bearer required).
- **New response fields (per row):**
  - `rug_risk`: `true` when `(coalesce(buy_count,0) + coalesce(sell_count,0)) >= 15` and `buy_ratio > 0.70`.
  - `rug_risk_reason`: `"High buy ratio (>0.70) after meaningful volume"` when rug_risk is true; otherwise `null`.
- **Backfill:** `?mint=DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm` (or any mint): if that mint is not already in the feed, the handler fetches the most recent alertworthy row for that mint from `trending_items` (60s snapshots), augments with `first_alert_time`, `fdv_at_alert`, `first_alert_fdv_usd`, prepends it to the list (cap 25), and adds `rug_risk` / `rug_risk_reason`. Safe to remove or gate later.

## C) Verification

**1) Mint appears in feed (SQL)**  
Snippet: `supabase/snippets/alertworthy_verify_du1rng.sql`

```sql
select * from public.v_layer_alertworthy_60 where mint = 'DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm';
```

If your view uses the premium feed, that row should appear (if still in lookback). Otherwise call the premium feed directly:

```sql
select * from public.layer_alertworthy_premium_feed(60, '06:00:00', 25) where mint = 'DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm';
```

**2) Mint appears via API (with backfill)**  
If the mint is outside the lookback or view logic still filters it:

```bash
curl -sS "https://<project>.supabase.co/functions/v1/gm3-api/v1/paid/alertworthy?mint=DU1RNgN937Rpc1RxHqq9pzbx3j9JmYEqo8EKdufwwkFm" \
  -H "Authorization: Bearer <gm3_sess_...>"
```

Check: `data[0].mint` is the requested mint and `data[0].rug_risk` / `data[0].rug_risk_reason` are present.

**3) JSON shape**  
Every row in `data` has:

- Existing fields unchanged.
- `rug_risk`: boolean.
- `rug_risk_reason`: string | null.

No breaking changes for existing clients (additive only).
