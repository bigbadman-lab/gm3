# Session revoke — dual-hash (MD5 + SHA-256) test notes

## What changed

- **Lookup:** `requireSession` now computes both MD5 (32-char hex) and SHA-256 (64-char hex) of the Bearer token and queries `access_sessions` with `WHERE session_token_hash IN (md5_hash, sha256_hex)`, so legacy MD5 and newer SHA-256 sessions both match.
- **New sessions:** Stripe mint and device-pair complete now store `session_token_hash` as SHA-256 hex (64 chars). Legacy MD5 rows remain readable forever.
- **Revoke:** `POST /v1/auth/revoke` uses `requireSession` (so it finds both hash types), then `UPDATE access_sessions SET revoked = true WHERE id = <session.id>`, returns `200` with `{ "ok": true, "revoked": true }`. On invalid/missing token, returns `401` with existing error shape.

## Quick test: revoke flips `revoked` for both hash types

### 1. MD5 session

- Pick a row in `access_sessions` where `session_token_hash` is 32-char hex (MD5). You need the **raw token** that produced that hash (e.g. from logs or a test mint that used MD5).
- Call revoke with that token:
  ```bash
  curl -sS -X POST "https://<project>.supabase.co/functions/v1/gm3-api/v1/auth/revoke" \
    -H "Authorization: Bearer <gm3_sess_...>" -H "Content-Type: application/json"
  ```
- **Expected:** `200` and `{"ok":true,"revoked":true}`.
- **DB check:**
  ```sql
  select id, session_token_hash, revoked, length(session_token_hash) as hash_len
  from public.access_sessions
  where session_token_hash = '<32-char-md5-hex>';
  ```
  **Expected:** `revoked = true`, `hash_len = 32`.

### 2. SHA-256 session

- Pick a row (or create one via Stripe mint / device-pair) where `session_token_hash` is 64-char hex. Use the token that was returned at mint.
- Call revoke with that token (same curl as above).
- **Expected:** `200` and `{"ok":true,"revoked":true}`.
- **DB check:**
  ```sql
  select id, session_token_hash, revoked, length(session_token_hash) as hash_len
  from public.access_sessions
  where session_token_hash = '<64-char-sha256-hex>';
  ```
  **Expected:** `revoked = true`, `hash_len = 64`.

### 3. SQL summary (both types show revoked)

```sql
-- After revoking one MD5 and one SHA-256 session, confirm both are revoked
select id, length(session_token_hash) as hash_len, revoked
from public.access_sessions
where session_token_hash in ('<md5_hex>', '<sha256_hex>');
-- Expected: both rows have revoked = true; one hash_len = 32, one = 64.
```

## Optional: identify hash format in DB

```sql
select
  id,
  length(session_token_hash) as hash_len,
  case when length(session_token_hash) = 32 then 'MD5' when length(session_token_hash) = 64 then 'SHA256' else 'other' end as format,
  revoked
from public.access_sessions
order by created_at desc
limit 20;
```
