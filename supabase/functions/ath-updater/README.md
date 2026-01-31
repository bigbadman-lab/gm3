# ath-updater Edge Function

Updates `token_ath` with current FDV from Birdeye for due mints (max 20 per run). Uses Bearer token auth and Supabase service role.

## Required env vars (Supabase Dashboard → Edge Functions → ath-updater)

| Variable | Description |
|----------|-------------|
| `ATH_UPDATER_TOKEN` | Bearer token for cron/auth (same value as in Vault `ath_updater_token`) |
| `SUPABASE_URL` | Set automatically when deployed |
| `SUPABASE_SERVICE_ROLE_KEY` | Set in Dashboard (service role, not anon) |
| `BIRDEYE_API_KEY` | Birdeye API key for token_overview |

## Test with curl

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ATH_UPDATER_TOKEN" \
  "https://<project_ref>.supabase.co/functions/v1/ath-updater"
```

Expected 200 body: `{"ok":true,"processed":N,"updated":N,"skipped":N,"archived":N}`

## Verify token_ath updates

```sql
-- Recent checks: last_checked_ts and current_fdv_usd should advance
select mint, last_checked_ts, current_fdv_usd, ath_fdv_usd, status, next_check_ts
from public.token_ath
order by last_checked_ts desc nulls last
limit 20;
```
