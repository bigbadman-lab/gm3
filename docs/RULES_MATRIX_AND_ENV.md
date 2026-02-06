# Rules Matrix, Env Vars, and Rules Not Enforced

## Rules Matrix

| Rule name | Where enforced | Exact condition (as code) | Inputs required | What it affects | Notes |
|-----------|----------------|---------------------------|-----------------|-----------------|--------|
| **unique_buyers ≥ 20** | ingest-trending/index.ts:296 | `unique_buyers >= 20` | unique_buyers (from uniqueBuyersByMint.size) | qualification | Part of is_qualified AND; all four must hold. |
| **buy_ratio ≥ 0.65** | ingest-trending/index.ts:297 | `buy_ratio >= 0.65` | buy_ratio = buy_count / total_swaps (total_swaps = buy_count + sell_count) | qualification | buy_ratio clamped [0,1] in code; DB constraint buy_ratio in [0,1] (004). |
| **net_sol_inflow ≥ 3** | ingest-trending/index.ts:298 | `net_sol_inflow >= 3` | net_sol_inflow (total_buy_sol - total_sell_sol) | qualification | In SOL; DB constraint net_sol_inflow >= 0 (004). |
| **swap_count ≥ 25** | ingest-trending/index.ts:299 | `swap_count >= 25` | swap_count (from swapCountByMint) | qualification | Per-mint swap count in window. |
| **is_qualified (all four)** | ingest-trending/index.ts:295-299 | `unique_buyers >= 20 && buy_ratio >= 0.65 && net_sol_inflow >= 3 && swap_count >= 25` | unique_buyers, buy_ratio, net_sol_inflow, swap_count | qualification | Only mints passing this get into qualifiedCandidates → items written. |
| **Cap qualified per window** | ingest-trending/index.ts:311 | `.slice(0, MAX_QUALIFIED_PER_WINDOW)` | qualifiedCandidates (already filtered by is_qualified) | snapshot/item write | MAX_QUALIFIED_PER_WINDOW = 200; sort: net_sol_inflow DESC, swap_count DESC, unique_buyers DESC. |
| **Qualified-only item write** | ingest-trending/index.ts:285-333 | Only qualifiedCandidates become items; no rows for non-qualified mints | is_qualified (derived above) | snapshot/item write | trending_items rows exist only for qualified mints (up to 200 per snapshot). |
| **WSOL mint excluded** | ingest-trending/index.ts:43 | `if (!mint \|\| mint === WSOL_MINT) return null` in extractMintFromTx | mint | filtering | WSOL_MINT constant; mint never aggregated. |
| **Inflow band [20, 70]** | 015_capital_efficiency_and_mc_structure.sql:53-54 | `new.inflow_band_ok := (new.net_sol_inflow >= 20 and new.net_sol_inflow <= 70)` | net_sol_inflow | alertworthy (AND) | Trigger set_inflow_signal_fields; also sets inflow_band_reason, inflow_score. |
| **MC floor fdv ≥ 8000** | 015_capital_efficiency_and_mc_structure.sql | `new.mc_floor_ok := (new.fdv_usd >= 8000)` | fdv_usd | alertworthy (indirect via mc_structure) | mc_structure_ok requires fdv >= 8000. |
| **Capital efficiency (fdv &lt; 15k)** | 015:92-98 | `eff := (net_sol_inflow*200)/fdv_usd`; if fdv_usd &lt; 15000 then `mc_structure_ok := (eff <= 0.7)` | fdv_usd, net_sol_inflow | alertworthy | eff_too_high_lowfdv if eff > 0.7. |
| **Capital efficiency (fdv ≥ 15k)** | 015:99-106 | else `mc_structure_ok := (eff <= 1.0)` | fdv_usd, net_sol_inflow | alertworthy | eff_too_high if eff > 1.0. |
| **mc_structure_ok** | 015:88-108 | fdv_usd ≥ 10000 and (fdv &lt; 15k → eff ≤ 0.7, else eff ≤ 1.0) | fdv_usd, net_sol_inflow | alertworthy | capital_efficiency = (net_sol_inflow*200)/fdv_usd. |
| **is_alertworthy** | 015 | `(is_qualified is true) and (net_sol_inflow between 10 and 70) and (mc_structure_ok is true)` | is_qualified, net_sol_inflow, mc_structure_ok | alertworthy | Trigger only; not used for write filter in ingest. |
| **FDV enrichment enabled** | ingest-trending/index.ts:521 | `(Deno.env.get("FDV_ENRICH_ENABLED") ?? "true") !== "false"` | env FDV_ENRICH_ENABLED | FDV enrichment | Default true; set to "false" to disable. |
| **FDV require qualified** | ingest-trending/index.ts:522,530 | `(Deno.env.get("FDV_REQUIRE_QUALIFIED") ?? "true") !== "false"`; if true then `.eq("is_qualified", true)` | env FDV_REQUIRE_QUALIFIED | FDV enrichment eligibility | Default true; only is_qualified rows are candidates when true. |
| **FDV candidate filter** | ingest-trending/index.ts:527-528 | `.or("fdv_usd.is.null,price_usd.is.null,total_supply.is.null")` | fdv_usd, price_usd, total_supply | FDV enrichment eligibility | Must have at least one null to be enriched. |
| **FDV enrichment limit** | ingest-trending/index.ts:534 | `.limit(10)` | — | FDV enrichment | Hardcoded 10 candidates per request. |
| **buy_ratio DB range** | 004_quality_metrics.sql:22-23 | `check (buy_ratio >= 0 and buy_ratio <= 1)` | buy_ratio | DB constraint | Insert/update rejected if violated. |
| **net_sol_inflow non-negative** | 004_quality_metrics.sql:56-58 | `check (net_sol_inflow >= 0)` | net_sol_inflow | DB constraint | — |
| **Non-negative counts** | 004_quality_metrics.sql:46-50 | `check (buy_count >= 0 and sell_count >= 0 and unique_buyers >= 0)` | buy_count, sell_count, unique_buyers | DB constraint | — |

---

## Env vars (ingest-trending)

| Env var | Where | What it toggles |
|---------|--------|------------------|
| **INGEST_TRENDING_TOKEN** | index.ts:351 (AUTH_ENV_NAME), 352 | Auth: expected Bearer/x-cron-token value; if missing or mismatch → 401. |
| **SUPABASE_URL** | index.ts:370 | Supabase client; required or 500. |
| **SUPABASE_SERVICE_ROLE_KEY** | index.ts:371 | Supabase client; required or 500. |
| **HELIUS_API_KEY** | index.ts:372 | Helius API URL; required or 500. |
| **PUMPFUN_ADDRESS** | index.ts:373 | Address for Helius transactions URL; required or 500. |
| **FDV_ENRICH_ENABLED** | index.ts:521 | If `"false"` → skip FDV enrichment block; default `"true"`. |
| **FDV_REQUIRE_QUALIFIED** | index.ts:522 | If not `"false"` → only rows with is_qualified true are FDV candidates; default `"true"`. |
| **BIRDEYE_API_KEY** | index.ts:523 (and 121 for fetchBirdeyeOverview, unused in main path) | If set and enrichment enabled → Birdeye token_overview used for FDV; empty → no enrichment. |

---

## Env vars (ath-updater)

| Env var | Where | What it toggles |
|---------|--------|------------------|
| **ATH_UPDATER_TOKEN** | ath-updater/index.ts:57 | Auth: expected Bearer/x-cron-token; if missing or mismatch → 401. |
| **SUPABASE_URL** | ath-updater/index.ts:71 | Supabase client; required or 500. |
| **SUPABASE_SERVICE_ROLE_KEY** | ath-updater/index.ts:72 | Supabase client; required or 500. |
| **BIRDEYE_API_KEY** | ath-updater/index.ts:73 | Birdeye token_overview for FDV; required or 500. |

---

## Rules NOT enforced anywhere

These are referenced in comments, snippets, or docs but are **not** implemented in current code or migrations.

| Rule / concept | Where mentioned | Why not enforced |
|----------------|-----------------|-------------------|
| **Top N by swap count (e.g. 20)** | PIPELINE_REVIEW_QUALIFIED_MINT_DISCOVERY.md:33, 60, 143; GM3_PIPELINE_ANALYSIS.md:52-53; 001_init.sql:8 (“Store only top N per snapshot”) | Old design: “top 20 mints by swap count then apply qualification.” Current code: **qualified-only** + cap 200 (MAX_QUALIFIED_PER_WINDOW). No TOP_N or topMints-by-swap slice. |
| **TOP_N = 20** | PIPELINE_REVIEW line numbers 353–355, 7 | No constant TOP_N in ingest-trending; no slice by swap count to 20. |
| **Per-window page/tx caps (3 pages, 1000 txs)** | PIPELINE_REVIEW:92-95 (MAX_PAGES_PER_WINDOW, MAX_TX_PER_WINDOW) | Replaced by cursor-based ingest: MAX_PAGES_PER_RUN (50), MAX_TXS_PER_RUN (5000), MAX_WINDOWS_PER_RUN (5). Different constants and flow. |
| **sol_price_usd in capital_efficiency** | Snippet Untitled query 501.sql:57 `eff := (new.net_sol_inflow * sol_price_usd) / new.fdv_usd` | Migration 015 uses fixed `200.0` (SOL/USD placeholder), not a sol_price_usd column or env. |
| **time_to_25_swaps_seconds** | 004_quality_metrics.sql (column exists) | Column added; no logic in ingest-trending or triggers sets it. |
| **top_buyer_share / repeat_buyer_ratio** | 004 (columns + constraints) | Columns and constraints exist; ingest-trending does not compute or write them. |
| **qualified_at / alertworthy_at** | GM3_PIPELINE_ANALYSIS.md:151-152 (optional “set when first becomes true”) | No such columns or trigger logic in migrations. |
| **Limit FDV enrichment to “qualified + cap per run”** | GM3_PIPELINE_ANALYSIS.md:189 | Cap is enforced (.limit(10)); “qualified” is optional via FDV_REQUIRE_QUALIFIED. Doc implies a separate “cap per run” beyond 10—not present. |
| **Insert into mint_entries from trending_items_latest where is_alertworthy** | Snippets (e.g. 897), GM3_PIPELINE_ANALYSIS.md | No migration or Edge Function runs this; ATH pipeline not wired. |
| **compute_next_check_ts** | 016_ath_updater_rpcs.sql (update_ath_for_mint) | Called in migration but **function not created in any migration** (snippet 334 only); RPC would fail at runtime if mint_entries/token_ath were populated. |
