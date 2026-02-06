# Deployer wallet signal for alertworthy / paid feed

Goal: add a **deployer_wallet** filter/signal so more **potential runner** mints from trusted deployers can appear in the paid alertworthy feed.

---

## 1. Current flow (no deployer)

- **is_alertworthy** (DB trigger on `trending_items`): `is_qualified` AND `net_sol_inflow` 10–70 SOL AND `mc_structure_ok` (MC floor fdv ≥ 8000).
- **Paid feed**: `v_paid_alertworthy_60` → `v_layer_alertworthy_60` → `layer_alertworthy(60)`.
- **layer_alertworthy(60)** returns mints that are **alertworthy in both** of the latest two 60s snapshots (strict).

So today a mint must pass the trigger in two consecutive windows. Adding deployer_wallet gives a second path: **preferred deployers** can get in with relaxed rules (e.g. one snapshot, or slightly relaxed inflow).

---

## 2. Data model

### 2.1 Where deployer_wallet lives

- **Table**: `token_cache` (one row per mint).
- **Column**: `deployer_wallet text` (nullable).  
  - If you already use `creator_wallet` and it’s the same as “deployer”, you can reuse it; this plan uses `deployer_wallet` as the name for the new signal.
- **Migration**: `ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS deployer_wallet text;` plus index if you query by it.

### 2.2 Preferred deployers (allowlist)

- **New table**: `preferred_deployers`
  - `wallet text PRIMARY KEY`
  - `is_active boolean NOT NULL DEFAULT true`
  - `created_at timestamptz DEFAULT now()`
  - Optional: `label text` (e.g. "Alpha list")
- Only wallets in this table (with `is_active = true`) get the “runner” path into the paid feed.

---

## 3. Populating deployer_wallet

You need a single source of truth for “who deployed this mint” (e.g. pump.fun bond curve creator / mint authority).

- **Option A – Ingest**: In the same place you update `token_cache` (e.g. ingest-trending or FDV enrichment), call the API that returns creator/deployer for the mint and set `token_cache.deployer_wallet`.
- **Option B – Backfill job**: Separate Edge Function or cron that, for mints in `trending_items` or `token_cache` with `deployer_wallet IS NULL`, fetches deployer and updates `token_cache`.

If you already have `creator_wallet` and it’s the deployer, use that and skip adding a second column; otherwise add `deployer_wallet` and populate it from your chosen API (pump.fun, Helius, Birdeye, etc.).

**How to populate (implemented):** Use the **backfill-deployer-wallet** Edge Function. It calls Birdeye `GET .../defi/token_creation_info?address={mint}`; response `data.owner` is the deployer. Set env `BIRDEYE_API_KEY`; optional `BACKFILL_DEPLOYER_LIMIT` (default 20). Run on a schedule or manually; `?mint=YourMint` backfills one mint. Upserts `token_cache` (mint, deployer_wallet). Optionally add the same call in ingest-trending when FDV-enriching.

---

## 4. Integration: how “runner” mints get into the paid feed

Keep the existing trigger and **is_alertworthy** definition unchanged. Add a **view-layer** path that includes runner mints.

### 4.1 Option A – New layer function (recommended)

Add a function that returns the same columns as `layer_alertworthy` plus an optional `in_feed_reason`:

- **Strict path**: mints that are alertworthy in **both** latest two snapshots (current behaviour).
- **Runner path**: mints that:
  - appear in the **latest** 60s snapshot only,
  - have `is_qualified = true`,
  - meet a relaxed inflow rule (e.g. `net_sol_inflow` between 5 and 100 SOL, or keep 20–70 and only relax “both snapshots”),
  - and have `token_cache.deployer_wallet` in `preferred_deployers` (where `is_active`).

Then either:

- Replace `v_layer_alertworthy_60` with a view that calls this new function, or
- Create a new view (e.g. `v_layer_alertworthy_with_runners_60`) and point `v_paid_alertworthy_60` at it.

Result: paid feed = strict alertworthy + runner mints from preferred deployers, with one place to tune rules and ordering.

### 4.2 Option B – Union in the paid view

- Leave `layer_alertworthy(60)` as-is.
- Define `v_paid_alertworthy_60` as:
  - `SELECT *, 'alertworthy' AS in_feed_reason FROM layer_alertworthy(60)`
  - `UNION ALL`
  - `SELECT *, 'runner' AS in_feed_reason FROM ...` (latest snapshot, is_qualified, relaxed inflow, deployer in preferred_deployers).
- Order and limit in the view (or in the API) so the feed is consistent.

Option A keeps ordering/limits in one function; Option B avoids changing the existing layer and only changes the paid view.

---

## 5. Relaxed rules for “runner” path (tunable)

Suggested starting point for mints from **preferred_deployers**:

- In **latest** 60s snapshot only (do not require two consecutive).
- `is_qualified = true`.
- `net_sol_inflow` in a wider band, e.g. **5–100 SOL** (or keep 20–70 if you only want to relax “both snapshots”).
- Optionally: `mc_structure_ok = true` or a looser cap-eff threshold so more runners get in.

You can store these thresholds in a config table or env and use them in the new function/view.

---

## 6. API behaviour

- **GET /v1/paid/alertworthy**: Already reads from `v_paid_alertworthy_60`. Once that view includes the runner path, the same endpoint returns both strict alertworthy and runner mints.
- Add a column such as **in_feed_reason** (`'alertworthy'` | `'runner'`) so clients can label “Alertworthy” vs “Runner (preferred deployer)”.
- Optional: add **deployer_wallet** to the select so clients can display it.

---

## 7. Implementation checklist

| Step | Action |
|------|--------|
| 1 | Migration: add `token_cache.deployer_wallet` (if not reusing `creator_wallet`). |
| 2 | Migration: create `preferred_deployers(wallet, is_active, created_at, ...)`. |
| 3 | Decide deployer API (pump.fun / Helius / Birdeye) and populate `deployer_wallet` in ingest or backfill job. |
| 4 | Add `layer_alertworthy_with_runners(p_window_seconds)` (or equivalent view) that implements strict + runner path and returns `in_feed_reason`. |
| 5 | Point `v_paid_alertworthy_60` at the new layer (or union view). |
| 6 | Update gm3-api select to include `in_feed_reason` (and optionally `deployer_wallet`) for `/v1/paid/alertworthy`. |
| 7 | (Optional) Add RLS/grants for `preferred_deployers` and document how to manage the allowlist. |

---

## 8. Summary

- **deployer_wallet**: one column per mint (e.g. on `token_cache`), populated from your chosen API.
- **preferred_deployers**: allowlist of wallets that get the relaxed “runner” path.
- **Paid feed**: same endpoint and view, but view now includes mints that are either (a) alertworthy in both snapshots, or (b) from a preferred deployer with relaxed rules in the latest snapshot.
- **Backward compatible**: existing is_alertworthy logic and trigger stay as-is; the change is additive in the view/API layer.

**Implemented (Option A):**
- `20260207000000_deployer_wallet_and_preferred_deployers.sql`: `token_cache.deployer_wallet`, table `preferred_deployers`.
- `20260207000001_layer_alertworthy_with_runners.sql`: `layer_alertworthy_with_runners(p_window_seconds)`, view `v_layer_alertworthy_with_runners_60`, `v_paid_alertworthy_60` now selects from it. Runner rules: latest snapshot only, is_qualified, net_sol_inflow 5–100 SOL, mc_structure_ok, deployer in preferred_deployers.
- gm3-api: `/v1/paid/alertworthy` orders by `in_feed_reason` (alertworthy first) then `updated_at` desc; response includes `in_feed_reason` and `deployer_wallet`.
