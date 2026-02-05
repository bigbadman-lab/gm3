# access_sessions security hardening — PR notes

## Summary

- **Migration:** `supabase/migrations/20260204000000_access_sessions_rls_deny.sql` enables RLS, forces RLS, revokes table privileges from `anon`, `authenticated`, and `public`, and adds a deny policy so client roles never see any rows.
- **Revoke endpoint:** `POST /v1/auth/revoke` invalidates the caller’s session server-side (sets `revoked: true`). Use when the user clicks “Remove access” so stale tokens/cookies no longer validate.

## How to apply the migration

**Local (Supabase CLI):**

```bash
supabase db push
# or
supabase migration up
```

**Hosted (Supabase Dashboard):**

1. Open **SQL Editor**.
2. Paste the contents of `supabase/migrations/20260204000000_access_sessions_rls_deny.sql`.
3. Run the script.

**CI / one-off:**

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260204000000_access_sessions_rls_deny.sql
```

After applying, **service_role** (used by Edge Functions) is unchanged: it bypasses RLS and still has full table access. Only `anon` and `authenticated` lose access.

---

## Regression test plan (for PR / QA)

1. **anon cannot read `access_sessions`**
   - Using the **anon** key (e.g. from Supabase project API settings), run:
     ```bash
     curl -sS "https://<project>.supabase.co/rest/v1/access_sessions?select=id" \
       -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
     ```
   - **Expected:** `403 Forbidden` or empty result set (0 rows). Must not return session rows.

2. **Paid gating still works for active sessions**
   - Create a valid paid session (e.g. Stripe mint or existing token).
   - Call a paid endpoint with that token:
     ```bash
     curl -sS "https://<project>.supabase.co/functions/v1/gm3-api/v1/paid/investable" \
       -H "Authorization: Bearer <gm3_sess_...>"
     ```
   - **Expected:** `200` and JSON with `data` (or `meta`). No permission errors.

3. **Revoke invalidates session; paid endpoints then fail**
   - With the same token, call:
     ```bash
     curl -sS -X POST "https://<project>.supabase.co/functions/v1/gm3-api/v1/auth/revoke" \
       -H "Authorization: Bearer <gm3_sess_...>"
     ```
   - **Expected:** `200` and `{"ok":true,"revoked":true}`.
   - Call the paid endpoint again with the same token:
     ```bash
     curl -sS "https://<project>.supabase.co/functions/v1/gm3-api/v1/paid/investable" \
       -H "Authorization: Bearer <gm3_sess_...>"
     ```
   - **Expected:** `401` (e.g. `invalid_session` or `missing_or_invalid_token`). After logging in again (new session), paid access works.

4. **Session validation and mint still work (service_role)**
   - No code changes to auth or mint; they use the service role client. After migration, confirm:
     - `GET /v1/auth/me` with valid token → 200.
     - `POST /v1/auth/mint/stripe` with valid `session_id` (and webhook-confirmed event) → 200 and new token.
     - Paid routes with valid token → 200.

---

## Edge function changes

- **New:** `POST /v1/auth/revoke` — requires `Authorization: Bearer gm3_sess_*`, sets `access_sessions.revoked = true` for that session id. Returns `{ ok: true, revoked: true }` or 401/500.
- **Unchanged:** All existing `access_sessions` usage remains server-side with service_role (session validation, mint, device-link/unlink, paid routes). No client-side access to the table.
