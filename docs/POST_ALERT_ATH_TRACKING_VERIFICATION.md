# Post-alert ATH tracking – verification report

## Concise summary

| | What we have | What we don't have |
|--|--------------|--------------------|
| **Schema** | `token_ath` (mint, status, next_check_ts, current_fdv_usd, ath_fdv_usd, ath_ts, …) and `mint_entries` (mint, entry_ts) in migration 016. | `compute_next_check_ts` **not in any migration** (only in snippet). `mint_entries` has no `entry_fdv_usd` / `entry_net_sol_inflow` (snippet 897 expects them). |
| **Alert moment** | `trending_items.is_alertworthy` set by DB trigger per row (015). | No durable “first alert” record; no `alerted_at` / `first_alertworthy_window_end`; **no code inserts into `mint_entries` or `token_ath`** when a mint becomes alertworthy. |
| **Tracking pipeline** | `ath-updater` Edge Function: reads `get_due_ath_mints`, fetches Birdeye FDV, calls `update_ath_for_mint`. Cron snippet schedules ath-updater every minute (pg_cron). | **`mint_entries` and `token_ath` are never populated** by any migration or Edge Function; `get_due_ath_mints` always returns empty. Ath-updater runs but does nothing useful. |
| **FDV enrichment** | Ingest-trending enriches up to 10 `trending_items` (fdv_usd, price_usd, total_supply) per request; optional `FDV_REQUIRE_QUALIFIED`; same request, not deferred. | FDV in ingest-trending is for trigger (is_alertworthy); no repeated FDV polling for ATH in ingest-trending (that’s ath-updater’s job, but it has no rows). |
| **Multiples** | `token_ath` can store `ath_fdv_usd` vs current; `mint_entries.entry_ts` could be “alert time”. | No `entry_fdv_usd` in current `mint_entries`; no view or API that computes “multiple from alert FDV → ATH FDV”. |

**Conclusion:** The “post-alert ATH tracking” system is **not wired up**. Tables and RPCs exist, but (1) `compute_next_check_ts` is missing from migrations, (2) nothing ever inserts into `mint_entries` or `token_ath`, so ath-updater has no work to do.

---

## 1. Schema / DB layer

### Tables that exist (016_ath_updater_rpcs.sql)

- **File:** `supabase/migrations/016_ath_updater_rpcs.sql`
- **What it does:** Defines `token_ath` and `mint_entries`, plus RPCs `get_due_ath_mints`, `update_ath_for_mint`.

**Evidence – token_ath:**

```sql
create table if not exists public.token_ath (
  mint text not null primary key,
  status text not null default 'active',
  next_check_ts timestamptz,
  current_fdv_usd numeric,
  current_ts timestamptz,
  ath_fdv_usd numeric,
  ath_ts timestamptz,
  last_checked_ts timestamptz,
  updated_at timestamptz not null default now()
);
```

- **Stores:** ATH FDV (`ath_fdv_usd`), ATH time (`ath_ts`), current FDV/ts, `next_check_ts`, `status` (active/archived), `last_checked_ts`. No “FDV at alert” or “alert time” in this table (alert time comes from `mint_entries.entry_ts`).

**Evidence – mint_entries:**

```sql
create table if not exists public.mint_entries (
  mint text not null primary key,
  entry_ts timestamptz not null
);
```

- **Stores:** Mint and `entry_ts` only. No `entry_fdv_usd`, `entry_net_sol_inflow`, or “first_alertworthy_window_end” in the migration.

**Missing:**

- **`compute_next_check_ts(entry_ts, now_ts)`** is called in `update_ath_for_mint` (016 line 68) but **is not created in any migration**. It exists only in snippet `Untitled query 334.sql`. So `update_ath_for_mint` will fail at runtime unless that function is created manually.

---

## 2. Alert / qualification transition detection

### Where is_qualified is computed

- **File:** `supabase/functions/ingest-trending/index.ts`
- **What it does:** For each window, builds qualified candidates and upserts `trending_items` with `is_qualified: true` for mints that meet the numeric thresholds.

**Evidence:**

```ts
const is_qualified =
  unique_buyers >= 20 &&
  buy_ratio >= 0.65 &&
  net_sol_inflow >= 3 &&
  swap_count >= 25
if (is_qualified) {
  qualifiedCandidates.push({ ... })
}
// ... items written with is_qualified: true
```

- **Transition detection:** None. Logic is “is this mint qualified in this window?” and write the flag. No “first time became qualified” or `qualified_at`; no insert into `mint_entries` or `token_ath`.

### Where is_alertworthy is computed

- **File:** `supabase/migrations/015_capital_efficiency_and_mc_structure.sql` (trigger `set_inflow_signal_fields`)
- **What it does:** On insert/update of `trending_items` (net_sol_inflow, is_qualified, fdv_usd), sets `is_alertworthy` and related fields.

**Evidence:**

```sql
new.is_alertworthy :=
  (new.is_qualified is true)
  and (new.net_sol_inflow between 20 and 70)
  and (new.mc_structure_ok is true);
```

- **Transition detection:** None. Trigger only recomputes the boolean for the current row. No “first time became alertworthy”, no `alerted_at`, and **no code that inserts into `mint_entries` or `token_ath`** when `is_alertworthy` becomes true.

---

## 3. Tracking pipeline

### ath-updater Edge Function

- **File:** `supabase/functions/ath-updater/index.ts`
- **What it does:** Authenticates, calls `get_due_ath_mints(lim: 1)`, for each returned mint fetches Birdeye FDV and calls `update_ath_for_mint(p_mint, p_current_fdv_usd)`.

**Evidence:**

```ts
const { data: dueRows, error: dueErr } = await supabase.rpc("get_due_ath_mints", { lim: 1 });
// ...
const { data: rowsUpdated, error: updateErr } = await supabase.rpc("update_ath_for_mint", {
  p_mint: row.mint,
  p_current_fdv_usd: fdvUsd,
});
if (rowsUpdated === 1) { updated += 1; }  // BUG: RPC returns array of rows, not row count
```

- **Scheduling:** Not in repo code; snippet `ath_updater_cron_with_vault_token.sql` shows pg_cron calling ath-updater every minute. So **if** cron is installed, ath-updater runs every minute.
- **Actual work:** `get_due_ath_mints` joins `token_ath` and `mint_entries`. No migration or Edge Function ever inserts into `mint_entries` or `token_ath`, so `dueRows` is always empty and ath-updater does no useful work.

### Promotion: alertworthy → mint_entries → token_ath

- **File:** `supabase/snippets/Untitled query 897.sql`, `Untitled query 706.sql`
- **What they do:** Snippets only; not run by any migration or Edge Function.

**Evidence (897):**

```sql
insert into public.mint_entries (mint, entry_ts, entry_fdv_usd, entry_net_sol_inflow)
select mint, updated_at as entry_ts, fdv_usd as entry_fdv_usd, net_sol_inflow
from public.trending_items_latest
where is_alertworthy is true
on conflict (mint) do nothing;
```

- **Schema mismatch:** Migration 016’s `mint_entries` has only `(mint, entry_ts)`. This snippet uses `entry_fdv_usd` and `entry_net_sol_inflow`, which do not exist in 016. So even if something ran this SQL, it would fail unless the table is altered.

**Evidence (706):**

```sql
insert into public.token_ath (mint, ath_fdv_usd, ath_ts, current_fdv_usd, current_ts, last_checked_ts, next_check_ts, status)
select e.mint, e.entry_fdv_usd, e.entry_ts, ...
from public.mint_entries e
left join public.token_ath a on a.mint = e.mint
where a.mint is null;
```

- Again, this is snippet-only and depends on `mint_entries` having `entry_fdv_usd`, which 016 does not define.

### ATH from history?

- There is no logic that reconstructs ATH from `trending_items` history. Design is: durable rows in `mint_entries` + `token_ath`, updated by ath-updater. Those rows are never created.

---

## 4. FDV enrichment timing

- **File:** `supabase/functions/ingest-trending/index.ts` (after window writes and cursor update)
- **What it does:** Optional (env `FDV_ENRICH_ENABLED`), fetches Birdeye for up to 10 `trending_items` where fdv_usd/price_usd/total_supply is null; if `FDV_REQUIRE_QUALIFIED` then only `is_qualified = true`. Updates `trending_items` by mint (price_usd, total_supply, fdv_usd, updated_at). Same request, not deferred.

**Evidence:**

```ts
let candidatesQuery = supabase.from("trending_items").select("mint")...
if (requireQualified) {
  candidatesQuery = candidatesQuery.eq("is_qualified", true)
}
// ... fetch Birdeye, then:
await supabase.from("trending_items").update({ price_usd, total_supply, fdv_usd, updated_at }).eq("mint", mint)
```

- **Repeated FDV for ATH:** Ingest-trending does not repeatedly poll FDV for ATH. That is intended to be ath-updater’s job, which has no rows to process.

---

## 5. Gaps + exact TODOs

| Gap | Detail |
|-----|--------|
| Missing function in migrations | `compute_next_check_ts(entry_ts, now_ts)` is used in 016 but not created in any migration. |
| Missing promotion step | No migration, cron, or Edge Function inserts into `mint_entries` from “first time alertworthy” (or from `trending_items_latest` where is_alertworthy). |
| Missing token_ath seeding | No code inserts into `token_ath` from `mint_entries` for new mints. |
| No “first alert” record | No column or table stores “first time this mint became alertworthy” (e.g. `alerted_at` / first_alertworthy_window_end). |
| mint_entries schema | 016 has only (mint, entry_ts). Snippets assume entry_fdv_usd, entry_net_sol_inflow; add columns or drop from snippet. |
| ath-updater success check | Code uses `rowsUpdated === 1` but RPC returns TABLE(updated, archived); Supabase client returns an array. Should check e.g. `Array.isArray(rowsUpdated) && rowsUpdated.length > 0 && rowsUpdated[0]?.updated`. |

---

## 6. Proposed minimal patch

### Step 1: Migration – add missing function and optional columns

**New migration (e.g. `021_ath_tracking_wire_up.sql`):**

1. Create `compute_next_check_ts(entry_ts timestamptz, now_ts timestamptz)` (copy from snippet 334).
2. Optionally add to `mint_entries`: `entry_fdv_usd numeric`, `entry_net_sol_inflow numeric` (for “FDV at alert” and multiples later). If you keep 016 as-is, then promotion SQL must only insert (mint, entry_ts).

### Step 2: Promotion – populate mint_entries (and token_ath)

**Option A – pg_cron job (recommended):**  
New migration or snippet that schedules a SQL job every 5–10 minutes:

1. `INSERT INTO mint_entries (mint, entry_ts [, entry_fdv_usd, entry_net_sol_inflow]) SELECT ... FROM trending_items_latest WHERE is_alertworthy IS TRUE ON CONFLICT (mint) DO NOTHING;`
2. `INSERT INTO token_ath (mint, next_check_ts, status, ...) SELECT e.mint, now(), 'active', ... FROM mint_entries e LEFT JOIN token_ath a ON a.mint = e.mint WHERE a.mint IS NULL;`

**Option B – From ingest-trending:**  
After FDV enrichment and before cursor update, in the same Edge Function: query `trending_items_latest` where `is_alertworthy = true`, then insert into `mint_entries` (ON CONFLICT DO NOTHING) and into `token_ath` for mints not yet in `token_ath`. Concurrency: use a single “promotion” lock or rely on ON CONFLICT.

### Step 3: Entry point and schedule

- **Promotion:** Either cron (Option A) or ingest-trending (Option B). If Option B, entry point is the same handler in `ingest-trending/index.ts` after enrichment.
- **ATH updates:** Already “scheduled” by snippet: pg_cron calls ath-updater every minute. Ensure that cron is actually deployed (Vault + project_url + ath_updater_token).
- **Concurrency:** 016 already uses `FOR UPDATE OF t SKIP LOCKED` in `get_due_ath_mints`; ath-updater can run every minute. Promotion: if in ingest-trending, one writer per run; if cron, one job per schedule.

### Step 4: ath-updater return value fix

In `ath-updater/index.ts`, replace the “row count” check with something like:

```ts
const result = (rowsUpdated ?? []) as { updated?: boolean; archived?: boolean }[];
if (result.length > 0 && result[0]?.updated) {
  updated += 1;
  if (result[0].archived) archived += 1;
} else {
  skipped += 1;
  errors.push(`${row.mint}: update row_count=${result.length}`);
}
```

### Step 5 (optional): “First alert” semantics

- To record “first time alertworthy” explicitly, add e.g. `alerted_at timestamptz` to `mint_entries` and set it in the promotion INSERT from `trending_items_latest.updated_at` (or from a new trigger that fires when `is_alertworthy` becomes true). That would require a trigger or application logic that detects the transition; minimal version is “promotion INSERT uses updated_at as entry_ts” as the proxy for alert time.

---

## 7. File reference list

| File | What it does | Evidence |
|------|--------------|----------|
| `supabase/migrations/016_ath_updater_rpcs.sql` | Creates `token_ath`, `mint_entries`, `get_due_ath_mints`, `update_ath_for_mint`; calls `compute_next_check_ts` | Lines 5–23 (tables), 27–41 (get_due), 46–75 (update_ath); line 68 references missing function |
| `supabase/functions/ath-updater/index.ts` | Reads due mints, fetches Birdeye FDV, calls `update_ath_for_mint`; wrong success check | Lines 90, 109–122 |
| `supabase/snippets/ath_updater_cron_with_vault_token.sql` | Schedules pg_cron to POST ath-updater every minute | Lines 17–30 |
| `supabase/snippets/Untitled query 334.sql` | Defines `compute_next_check_ts` | Not in migrations |
| `supabase/snippets/Untitled query 897.sql` | INSERT mint_entries from trending_items_latest where is_alertworthy | Not run by any code; columns don’t match 016 |
| `supabase/snippets/Untitled query 706.sql` | INSERT token_ath from mint_entries where not in token_ath | Not run by any code |
| `supabase/functions/ingest-trending/index.ts` | Computes is_qualified, upserts items; enriches FDV for trending_items | Lines 285–301 (qualified), 519–560 (enrichment); no mint_entries/token_ath writes |
| `supabase/migrations/015_capital_efficiency_and_mc_structure.sql` | Trigger sets is_alertworthy (qualified + inflow band + mc_structure_ok) | Lines 112–115 |
| `docs/GM3_PIPELINE_ANALYSIS.md` | Describes mint_entries/token_ath backfill as snippet-only, not wired | “no migration or Edge Function in repo runs these” |
