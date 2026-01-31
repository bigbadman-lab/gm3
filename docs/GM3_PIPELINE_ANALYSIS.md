# GM3 Pipeline End-to-End Analysis

## A) Architecture Map

### Edge Functions (Supabase)
| Path | Purpose |
|------|---------|
| `supabase/functions/ingest-trending/index.ts` | Fetches Helius txs, aggregates by mint, inserts trending_snapshots + trending_items, runs FDV enrichment. |
| `supabase/functions/ath-updater/index.ts` | Fetches due mints from token_ath, calls Birdeye for FDV, updates token_ath via `update_ath_for_mint`. |
| `supabase/functions/v1-today/index.ts` | Reads trending_items_latest + watchlist_daily, applies blocklists, returns JSON for API. |

### DB Functions / Triggers (Postgres)
| Location | Name | Purpose |
|----------|------|---------|
| `supabase/migrations/015_capital_efficiency_and_mc_structure.sql` | `set_inflow_signal_fields()` (trigger) | On insert/update of trending_items (net_sol_inflow, is_qualified, fdv_usd): sets inflow_band_ok, inflow_band_reason, inflow_score, mc_floor_ok, mc_floor_reason, capital_efficiency, mc_structure_ok, mc_structure_reason, is_alertworthy. |
| `supabase/migrations/016_ath_updater_rpcs.sql` | `get_due_ath_mints(lim)` | Returns due mints from token_ath (status=active, next_check_ts <= now()) with FOR UPDATE SKIP LOCKED. |
| `supabase/migrations/016_ath_updater_rpcs.sql` | `update_ath_for_mint(p_mint, p_current_fdv_usd)` | Updates token_ath: current_fdv_usd, current_ts, ath_fdv_usd/ath_ts, last_checked_ts, next_check_ts, status (archived if entry_ts >= 7 days). May return integer row_count; Edge Function treats rowsUpdated === 1 as success. |
| Snippet `Untitled query 334.sql` | `compute_next_check_ts(entry_ts, now_ts)` | Returns next_check_ts: 1 min if &lt;6h, 10 min if &lt;24h, 12h if &lt;7d, else 365d. |

### Background / Cron (not in repo)
- **ingest-trending**: Invoked on a schedule (e.g. every N minutes); config not in repo.
- **ath-updater**: Invoked every minute via pg_cron (SQL in snippets) with Bearer token from Vault.
- **mint_entries / token_ath backfill**: Snippets define SQL to insert into `mint_entries` from `trending_items_latest` where `is_alertworthy` and into `token_ath` from `mint_entries`; no migration or Edge Function in repo runs these. They are intended to be run by a cron/SQL job.

### Key Tables
| Table | Purpose |
|-------|---------|
| `trending_snapshots` | One row per time window (e.g. 10 min); referenced by trending_items. |
| `trending_items` | Per-snapshot, top N mints; holds swap_count, buy/sell metrics, is_qualified, fdv_usd, trigger-derived fields (inflow_*, mc_*, is_alertworthy). |
| `trending_items_latest` | View: one row per mint, latest updated_at; used by v1-today and by mint_entries backfill SQL. |
| `mint_entries` | One row per mint we “promote” to ATH tracking; populated from trending_items_latest where is_alertworthy (snippet). |
| `token_ath` | ATH tracking per mint; next_check_ts, current_fdv_usd, ath_fdv_usd; fed by ath-updater. |
| `blocked_mints`, `blocked_creators` | Blocklists for v1-today. |
| `token_cache` | Optional cache (creator_wallet, etc.) for blocklist and display. |
| `watchlist_daily` | Human GM taps; used by v1-today. |

---

## B) End-to-End Flow (Step-by-Step)

### 1. Helius fetch
- **Where:** `ingest-trending/index.ts` (inline, no named function).
- **URL:** `https://api-mainnet.helius-rpc.com/v0/addresses/${pumpfunAddress}/transactions?api-key=...&limit=100`; pagination with `before` (last tx signature).
- **Conditionals:** Stop when (a) page empty, (b) `transactions.length >= HELIUS_MAX_TX` (2000), (c) oldest tx `timestamp < windowStartSec`, (d) paging stuck (page 2 first sig === page 1). Timeout 15s per request.
- **DB:** None (in-memory `transactions`).

### 2. Parsing & aggregation
- **Where:** `ingest-trending/index.ts` — `inWindow(tx)`, `extractMintFromTx`, `extractActorWalletFromTx`, `classifyBuySell`, `getSolAmountForActor`; loop over `transactions`.
- **Conditionals:** Include only tx with `timestamp` in `[windowStartSec, windowEndSec]`. Exclude mint `WSOL_MINT`. Per mint: aggregate swap_count, signal touches/points (from `signal_wallets`), buy_count, sell_count, unique_buyers, net_sol_inflow.
- **DB read:** `signal_wallets` (wallet, weight, is_active=true).

### 3. De-dup / top N
- **Where:** Same file; `topMints = [...swapCountByMint.entries()].sort((a,b) => b[1]-a[1]).slice(0, TOP_N)` (TOP_N=20).
- **Conditionals:** None beyond “top 20 by swap_count”.
- **DB:** None.

### 4. DB insert (trending_snapshots + trending_items)
- **Where:** `ingest-trending/index.ts` — `supabase.from("trending_snapshots").insert(...)`, then `supabase.from("trending_items").insert(items)`.
- **Conditionals:** Per item: `is_qualified = (unique_buyers >= 20 && buy_ratio >= 0.65 && net_sol_inflow >= 3 && swap_count >= 25)`. Initial `fdv_usd: null`.
- **DB write:** `trending_snapshots` (window_seconds, window_end); `trending_items` (snapshot_id, rank, mint, swap_count, fdv_usd=null, signal_*, buy_count, sell_count, unique_buyers, net_sol_inflow, buy_ratio, is_qualified). Trigger `trg_set_inflow_signal_fields` runs on insert (net_sol_inflow, is_qualified, fdv_usd) and sets inflow_*, mc_floor_*, capital_efficiency, mc_structure_*, is_alertworthy (all depend on fdv_usd; with fdv_usd null, mc_* and is_alertworthy end up false/missing).

### 5. FDV enrichment (Birdeye)
- **Where:** `ingest-trending/index.ts` — after insert; selects up to 10 trending_items (qualified if FDV_REQUIRE_QUALIFIED) with null fdv/price/supply, fetches Birdeye token_overview, updates `trending_items` by mint (price_usd, total_supply, fdv_usd, updated_at).
- **Conditionals:** `FDV_ENRICH_ENABLED` !== "false", `BIRDEYE_API_KEY` set; optionally `FDV_REQUIRE_QUALIFIED` so only is_qualified rows are candidates. Update by `mint` only (no snapshot_id).
- **DB read:** `trending_items` (mint). **DB write:** `trending_items` (price_usd, total_supply, fdv_usd, updated_at). Trigger runs again → inflow_*, mc_floor_ok, capital_efficiency, mc_structure_ok, is_alertworthy recomputed.

### 6. Scheduling (mint_entries → token_ath)
- **Where:** Not in an Edge Function. Snippets only:
  - Insert into `mint_entries`: from `trending_items_latest` where `is_alertworthy is true` (ON CONFLICT DO NOTHING).
  - Insert into `token_ath`: from `mint_entries` left join `token_ath` where `token_ath.mint is null` (new mints only), next_check_ts = now().
- **Conditionals:** Only alertworthy mints get into mint_entries; only mints not already in token_ath get a token_ath row.
- **DB:** mint_entries (mint, entry_ts, entry_fdv_usd, entry_net_sol_inflow); token_ath (mint, ath_fdv_usd, ath_ts, current_*, last_checked_ts, next_check_ts, status=active).

### 7. Birdeye fetch (ath-updater)
- **Where:** `ath-updater/index.ts` — `fetchBirdeyeFdv(mint, apiKey)`; GET Birdeye token_overview, parse FDV.
- **Conditionals:** Accept only success + finite fdv; else return error payload (status, bodySnippet 300 chars, pathQuery). No throw; skip mint and continue.
- **DB:** None.

### 8. update_ath_for_mint
- **Where:** `ath-updater/index.ts` calls `supabase.rpc("update_ath_for_mint", { p_mint, p_current_fdv_usd })`. Logic in `016_ath_updater_rpcs.sql`.
- **Conditionals:** If mint not in mint_entries, no update. Else: set current_fdv_usd, current_ts; ath_fdv_usd/ath_ts if current &gt; previous; last_checked_ts = now(); next_check_ts = compute_next_check_ts(entry_ts, now()); status = 'archived' if now() - entry_ts >= 7 days.
- **DB read:** mint_entries (entry_ts). **DB write:** token_ath (current_fdv_usd, current_ts, ath_fdv_usd, ath_ts, last_checked_ts, next_check_ts, status, updated_at).

### 9. Qualification logic (already applied at insert)
- **Where:** `ingest-trending/index.ts` when building `items`; no separate step later.
- **Conditionals:** `is_qualified = (unique_buyers >= 20 && buy_ratio >= 0.65 && net_sol_inflow >= 3 && swap_count >= 25)`.
- **DB:** Written once in trending_items insert.

### 10. Alert logic (trigger)
- **Where:** `set_inflow_signal_fields()` in migration 015; runs on insert/update of (net_sol_inflow, is_qualified, fdv_usd) on trending_items.
- **Conditionals:** `is_alertworthy = (is_qualified IS TRUE) AND (net_sol_inflow BETWEEN 20 AND 70) AND (mc_structure_ok IS TRUE)`. mc_structure_ok: fdv_usd >= 10000 and (fdv &lt; 15k → capital_efficiency <= 0.7, else <= 1.0); capital_efficiency = (net_sol_inflow * 200) / fdv_usd.
- **DB write:** trending_items (inflow_*, mc_floor_*, capital_efficiency, mc_structure_*, is_alertworthy).

### 11. v1-today (read path)
- **Where:** `v1-today/index.ts` — reads `trending_snapshots` (latest), `trending_items_latest` (all columns), `watchlist_daily`, `blocked_mints`, `blocked_creators`, `token_cache` (creator_wallet).
- **Conditionals:** Filter out mints in blocked_mints or whose creator_wallet is in blocked_creators.
- **DB read only.** Response: trending (filtered), watchlist (filtered).

---

## C) Qualification & Alertworthiness (Current Definition)

### Qualified (explicit in code)
- **Definition:** A mint is qualified if all of:
  - `unique_buyers >= 20`
  - `buy_ratio >= 0.65` (buy_count / (buy_count + sell_count))
  - `net_sol_inflow >= 3` (SOL)
  - `swap_count >= 25`
- **Where:** `ingest-trending/index.ts` (items map, ~line 330): `is_qualified = unique_buyers >= 20 && buy_ratio >= 0.65 && net_sol_inflow >= 3 && swap_count >= 25`.
- **Persistence:** Column `trending_items.is_qualified` (boolean); set at insert only (no qualified_at or status enum).

### Alertworthy (explicit in trigger)
- **Definition:** A mint is alertworthy if all of:
  - `is_qualified = true`
  - `net_sol_inflow BETWEEN 20 AND 70` (inflow “band”)
  - `mc_structure_ok = true`
- **mc_structure_ok:** fdv_usd >= 10000 and capital_efficiency within band: if fdv_usd &lt; 15000 then (net_sol_inflow*200/fdv_usd) <= 0.7, else <= 1.0.
- **Where:** `set_inflow_signal_fields()` in `015_capital_efficiency_and_mc_structure.sql`; `is_alertworthy := (is_qualified is true) and (net_sol_inflow between 20 and 70) and (mc_structure_ok is true)`.
- **Persistence:** Column `trending_items.is_alertworthy`; updated by trigger on insert/update of net_sol_inflow, is_qualified, fdv_usd.

### Implicit gates (no explicit “qualified_at” or “alertworthy_at”)
- **Surfacing in v1-today:** Any row in `trending_items_latest` is returned; sort order is is_alertworthy DESC, inflow_score DESC, net_sol_inflow DESC, updated_at DESC. Blocklist only: blocked_mints, blocked_creators. No “only show if qualified” or “only show if alertworthy” filter in v1-today.
- **ATH pipeline:** Only mints that appear in `trending_items_latest` with `is_alertworthy = true` are intended to be copied into `mint_entries` (snippet); then token_ath. So “alertworthy” gates which mints get ATH tracking, not what appears in the main feed.
- **FDV:** Alertworthy and mc_structure_ok depend on fdv_usd. Until FDV enrichment runs (and trigger runs again), is_alertworthy stays false for new rows. No “has been checked N times” or “qualified_at” in DB.

### Where alertworthy is used
- **Snippet (mint_entries backfill):** `INSERT INTO mint_entries ... FROM trending_items_latest WHERE is_alertworthy IS TRUE`.
- **v1-today:** Uses is_alertworthy only for **sorting** (alertworthy first), not for filtering out rows.

---

## D) State Machine Proposal (Minimal)

### Suggested states (logical)
1. **new** — Just appeared in a snapshot (top 20 by swap_count).
2. **watching** — In trending_items with at least one row; may or may not be qualified/alertworthy.
3. **qualified** — is_qualified = true (unique_buyers ≥ 20, buy_ratio ≥ 0.65, net_sol_inflow ≥ 3, swap_count ≥ 25).
4. **alertworthy** — is_qualified and inflow band (20–70 SOL) and mc_structure_ok (fdv ≥ 10k, capital efficiency within band).
5. **archived** — Used today only for **token_ath**: status = 'archived' when entry_ts is &gt; 7 days. No “archived” state for trending_items.

### Current column mapping
| State   | Existing columns |
|---------|-------------------|
| new     | Any row in trending_items (no explicit state column). |
| watching| Same; “watching” = has row in trending_items_latest. |
| qualified | `trending_items.is_qualified` |
| alertworthy | `trending_items.is_alertworthy` |
| archived (ATH only) | `token_ath.status = 'archived'` |

### New columns (optional, for speed/clarity)
- **trending_items:** `qualified_at timestamptz` — set when is_qualified first becomes true (would require trigger or application logic). Not strictly required for v1.
- **trending_items:** `alertworthy_at timestamptz` — set when is_alertworthy first becomes true (same). Optional.
- No new state enum required if we keep using is_qualified and is_alertworthy booleans; the “state machine” is implicit.

---

## E) Top 10 Improvements (Ranked)

### 1) Run mint_entries + token_ath backfill from repo (speed + correctness)
- **What:** Add a small Edge Function or pg_cron job that runs the two SQL statements (insert into mint_entries from trending_items_latest where is_alertworthy; insert into token_ath from mint_entries where not exists) on a schedule (e.g. every 5 min after ingest).
- **Where:** New function e.g. `supabase/functions/promote-alertworthy/index.ts` or a migration that schedules the SQL.
- **Effect:** Alertworthy mints get into ATH pipeline reliably and quickly; no manual/snippet-only step.

### 2) Enrich FDV for all top 20 (or more) before trigger (quality)
- **What:** In ingest-trending, call Birdeye for all top 20 mints (or at least all qualified) in one batch/loop and update fdv_usd (and price_usd, total_supply) before or immediately after insert, so trigger can set is_alertworthy in the same run.
- **Where:** `ingest-trending/index.ts` — expand FDV enrichment to cover all inserted mints (or all qualified), or run enrichment right after insert with a single update per mint.
- **Effect:** Faster path to alertworthy; fewer “qualified but not yet alertworthy because fdv_usd null” rows.

### 3) Stricter “first appearance” filter (quality)
- **What:** Optionally require that a mint has not been in the top 20 in the previous K windows (e.g. K=2) before counting as “new” for mint_entries, to avoid re-promoting the same token.
- **Where:** mint_entries insert SQL or new RPC: join trending_items_latest to recent snapshots and exclude mints that were already in a prior snapshot.
- **Effect:** Fewer duplicate/rerun tokens in ATH; cleaner list.

### 4) Raise or tune qualification thresholds (quality)
- **What:** Consider unique_buyers >= 25, swap_count >= 30, or net_sol_inflow >= 5 to reduce spam; keep buy_ratio >= 0.65.
- **Where:** `ingest-trending/index.ts` (is_qualified expression).
- **Effect:** Fewer low-quality tokens marked qualified; slightly slower to qualify the best ones.

### 5) Tiered scheduling for ath-updater (cost/speed)
- **What:** Pro: keep next_check_ts at 1 min for first 6h; Free: use 10 min or 12h from first check. Implement by storing a “tier” on mint_entries or token_ath and having compute_next_check_ts (or the update_ath_for_mint caller) pass tier.
- **Where:** `compute_next_check_ts` (or wrapper) and optionally mint_entries/token_ath schema; ath-updater unchanged.
- **Effect:** Lower Birdeye cost for free tier; faster ATH for pro.

### 6) Blocklist check at ingest (quality)
- **What:** Before inserting trending_items, exclude mints that are in blocked_mints or whose creator (from token_cache) is in blocked_creators, so they never appear in trending_items_latest.
- **Where:** `ingest-trending/index.ts` — load blocklists and token_cache for candidate mints; filter topMints before insert.
- **Effect:** Blocked tokens never enter trending or ATH pipeline; cleaner data.

### 7) Limit FDV enrichment to qualified + cap per run (cost)
- **What:** Already have FDV_REQUIRE_QUALIFIED; add a hard cap (e.g. 10) and possibly skip mints that already have fdv_usd set in a recent snapshot to avoid re-calling Birdeye.
- **Where:** `ingest-trending/index.ts` (FDV enrichment block).
- **Effect:** Lower Birdeye usage; deterministic.

### 8) Add qualified_at / alertworthy_at (speed observability)
- **What:** Optional columns set by trigger or app when is_qualified or is_alertworthy first becomes true; enables “time to qualified” metrics and faster debugging.
- **Where:** New migration (columns + trigger update in set_inflow_signal_fields).
- **Effect:** No logic change; better analytics and tuning.

### 9) Tests for qualification and alertworthy (correctness)
- **What:** Unit tests: (a) is_qualified true/false for given (unique_buyers, buy_ratio, net_sol_inflow, swap_count); (b) trigger output for given (is_qualified, net_sol_inflow, fdv_usd) → is_alertworthy, mc_structure_ok. Integration: one test that runs get_due_ath_mints and update_ath_for_mint with fixture data.
- **Where:** New test file(s) under a test/ or __tests__ directory; or Supabase DB tests for the trigger and RPCs.
- **Effect:** Safer refactors; documented behavior.

### 10) Pagination and window for v1-today (cost/latency)
- **What:** If trending_items_latest grows large, add limit (e.g. 100) and/or “since” filter so the API returns a bounded set.
- **Where:** `v1-today/index.ts` — .limit(100) or .gte("updated_at", since).
- **Effect:** Predictable response size and DB load; better for Free vs Pro (e.g. Free: limit 50, Pro: 200).

---

## Missing Tests to Add

1. **ingest-trending:** Given a mock Helius response (array of txs with mint, timestamp, tokenTransfers), assert topMints order and is_qualified for a mint that meets vs does not meet thresholds.
2. **set_inflow_signal_fields:** For (net_sol_inflow, fdv_usd, is_qualified) inputs, assert inflow_band_ok, mc_structure_ok, is_alertworthy (e.g. fdv 12k, inflow 50 → alertworthy if qualified).
3. **get_due_ath_mints:** With fixture token_ath + mint_entries, assert returned mints and that they are locked (no duplicate in second call in same tx).
4. **update_ath_for_mint:** With one row in token_ath, call RPC with new fdv_usd; assert current_fdv_usd, ath_fdv_usd, next_check_ts, status (including archived when entry_ts &gt; 7 days).
5. **v1-today:** With blocked_mints containing a mint, assert that mint is absent from returned trending.
