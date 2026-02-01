# GM3 Pipeline Review: Qualified Mint Discovery + Alert Candidate (as implemented today)

Facts only, from the repo. All references use file path + symbol/line.

---

## 1) System map (1 page)

- **Trigger**
  - **Entrypoint:** `.github/workflows/ingest-trending.yml` — `on.schedule.cron: "*/5 * * * *"` (every 5 min) and `workflow_dispatch`.
  - **Job:** `call-ingest-trending` — `runs-on: ubuntu-latest`, env `TOKEN: ${{ secrets.INGEST_TRENDING_TOKEN }}`.
  - **Step:** Single step runs `curl -X POST` to Supabase Edge Function URL (hardcoded `https://suqopwfezumhvmyvsgjo.supabase.co/functions/v1/ingest-trending`) with headers `x-cron-token: $TOKEN`, `Authorization: Bearer $TOKEN`, `Content-Type: application/json`.

- **Edge function (ingest-trending)**
  - **Entrypoint:** `supabase/functions/ingest-trending/index.ts` — `Deno.serve(async (req) => { ... })` (handler at top level).
  - **Config:** `supabase/config.toml` — `[functions.ingest-trending]` with `verify_jwt = false`, `entrypoint = "./functions/ingest-trending/index.ts"`.
  - **Auth:** Handler reads `Deno.env.get("INGEST_TRENDING_TOKEN")`; compares to `Authorization: Bearer` or `x-cron-token`; returns 401 if missing or mismatch (lines 406–418).
  - **Env vars used:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HELIUS_API_KEY`, `PUMPFUN_ADDRESS`, `INGEST_TRENDING_TOKEN`; optional: `FDV_ENRICH_ENABLED`, `FDV_REQUIRE_QUALIFIED`, `BIRDEYE_API_KEY` (lines 420–421, 529–531).

- **Fetch**
  - **Signal wallets:** `supabase.from("signal_wallets").select("wallet, weight").eq("is_active", true)` (lines 474–478).
  - **Catch-up targets:** `supabase.from("trending_snapshots").select("window_end").eq("window_seconds", 600).order("window_end", { ascending: false }).limit(1).maybeSingle()` (lines 491–497).
  - **Helius transactions:** For each target window, `ingestOneWindow(...)` builds URL `https://api-mainnet.helius-rpc.com/v0/addresses/${pumpfunAddress}/transactions?api-key=${heliusApiKey}&limit=100` and optionally `&before=${lastSig}`; uses `fetchWithTimeout(pageUrl, undefined, 10000)` (lines 419–420, 233–234, 237).

- **Parse**
  - **Time:** `getTxTimeSec(tx)` (index.ts:176–186) — tries `tx.timestamp`, `tx.blockTime`, `tx.time`, `tx.parsed?.timestamp` via `toUnixSeconds(ts)` (163–174).
  - **Mint:** `extractMintFromTx(tx)` (37–70) — primary: `tx.tokenTransfers` or `tx.token_transfers` `[*].mint`; fallback: `tx.events?.swap` tokenInputs/tokenOutputs, then `tx.accountData[*].tokenBalanceChanges[*].mint`; skips null and `WSOL_MINT`.
  - **Actor / buy-sell / SOL:** `extractActorWalletFromTx`, `classifyBuySell`, `getSolAmountForActor` (72–107).

- **Aggregate**
  - **In-window filter:** `windowStartSec <= getTxTimeSec(tx) < windowEndSec` (305–309), `filteredTxs = transactions.filter(inWindow)` (318–319).
  - **Per-mint maps:** In `ingestOneWindow`, loop over `filteredTxs`: for each tx, mint from `extractMintFromTx(tx)`; increment `swapCountByMint`, `signalTouchCountByMint`, `signalPointsByMint`, buy/sell counts, `uniqueBuyersByMint`, `buySolByMint`, `sellSolByMint` (324–350).
  - **Top N:** `topMints = [...swapCountByMint.entries()].sort((a,b) => b[1]-a[1]).slice(0, TOP_N)` with `TOP_N = 20` (353–355).

- **DB writes**
  - **Snapshot:** `supabase.from("trending_snapshots").upsert({ window_seconds: 600, window_end: windowEndIso }, { onConflict: "window_seconds,window_end" }).select("id").single()` (357–363).
  - **Items:** `supabase.from("trending_items").insert(items)` where each item has `snapshot_id`, `rank`, `mint`, `swap_count`, `fdv_usd: null`, signal fields, buy/sell/unique_buyers/net_sol_inflow/buy_ratio, `is_qualified` (371–408).
  - **FDV enrichment (post-insert):** Optional loop over up to 10 `trending_items` rows (qualified or all) with null fdv/price/supply; fetch Birdeye token_overview; `supabase.from("trending_items").update({ price_usd, total_supply, fdv_usd, updated_at }).eq("mint", mint)` (528–563).

- **Alert read path**
  - **View:** `trending_items_latest` (migration 015) — `DISTINCT ON (mint) ... ORDER BY mint, updated_at DESC` from `trending_items`.
  - **API:** `supabase/functions/v1-today/index.ts` — selects from `trending_items_latest`, orders by `is_alertworthy DESC`, `inflow_score DESC`, `net_sol_inflow DESC`, `updated_at DESC`; applies blocklists (`blocked_mints`, `blocked_creators` via `token_cache.creator_wallet`); returns JSON (39–46, 75–89). Note: `token_cache` in 001_init.sql does not define `creator_wallet`; it may exist from another migration or seed not in the listed migrations.

---

## 2) What “qualified mint” means TODAY (as implemented)

- **First moment a mint can appear**
  - A mint becomes known to the system only when it appears in at least one transaction returned by Helius for the **pump.fun program/address** (`PUMPFUN_ADDRESS`) and that transaction is:
    1. Fetched in the pagination loop of `ingestOneWindow` (within page/tx caps),
    2. In the time window `[windowStartSec, windowEndSec)` (half-open),
    3. Has a non-null, non-wSOL mint from `extractMintFromTx` (primary: `tokenTransfers`/`token_transfers` mint; fallbacks: swap inputs/outputs, accountData tokenBalanceChanges).
  - **Code:** Mint discovery is gated by Helius response + `getTxTimeSec` + `inWindow` (305–309) + `extractMintFromTx` (37–70). First appearance is when that tx is aggregated and the mint enters `swapCountByMint` (324–326).

- **Filters/gates before a mint is in `trending_items`**
  1. **Data source:** Tx must be in Helius response for `PUMPFUN_ADDRESS` (index.ts:419–420, 233).
  2. **Pagination/time caps:** Tx must be in pages/txs we actually fetch: `MAX_PAGES_PER_WINDOW = 3`, `MAX_TX_PER_WINDOW = 1000`; early stop when page min/max timestamp &lt; `windowStartSec` (266–269, 284–294).
  3. **Time window:** `windowStartSec <= getTxTimeSec(tx) < windowEndSec` (307–308).
  4. **Mint extraction:** `extractMintFromTx(tx)` not null and not wSOL (40, 324–325).
  5. **Top N per window:** Mint must be in top 20 by swap count for that window: `topMints = [...swapCountByMint.entries()].sort(...).slice(0, TOP_N)` (353–355).
  6. **Insert:** Only those top 20 get rows in `trending_items` (371–408).

- **Qualification (row-level, for alerting)**
  - **Definition:** `is_qualified` is set in the Edge Function when building each item (377–381):  
    `unique_buyers >= 20 && buy_ratio >= 0.65 && net_sol_inflow >= 3 && swap_count >= 25`.
  - **Code:** index.ts:377–381.

- **Alertworthiness (DB trigger)**
  - Set in DB by trigger `set_inflow_signal_fields()` (migration 015):  
    `is_alertworthy = (is_qualified IS TRUE) AND (net_sol_inflow BETWEEN 20 AND 70) AND (mc_structure_ok IS TRUE)` where `mc_structure_ok` depends on `fdv_usd` and capital_efficiency (015_capital_efficiency_and_mc_structure.sql:109–114, 79–107).

- **All pump.fun launches vs only tokenTransfers**
  - **We capture only mints that appear in the tx feed we consume.** That feed is “transactions for address `PUMPFUN_ADDRESS`” from Helius (index.ts:419–420). So we see txs where that address is involved; we do not separately query “all pump.fun bond curve creations” or “all new token mints on pump.fun.”
  - Mint extraction is **primary** `tokenTransfers`/`token_transfers` mint, **fallback** swap inputs/outputs and accountData tokenBalanceChanges (37–70). So we only get mints that show up in at least one of those structures in those txs. If a launch is not reflected in tokenTransfers/swap/accountData in our feed, we do not see it.
  - **Conclusion:** We are **not** capturing “all pump.fun launches”; we capture **mints that appear in tokenTransfers (or fallbacks) in transactions returned by Helius for the pump.fun address**, subject to windowing and caps.

---

## 3) Coverage analysis (Pump.fun launches)

- **Upstream data source**
  - **Single source:** Helius API — `https://api-mainnet.helius-rpc.com/v0/addresses/${PUMPFUN_ADDRESS}/transactions?...` (index.ts:419–420). Transactions are for one address (`PUMPFUN_ADDRESS`), i.e. the pump.fun program/contract address.
  - No other transaction source (e.g. Solana RPC, other indexers) is used for mint discovery in this pipeline.

- **Does that guarantee pump.fun coverage?**
  - Only to the extent that Helius returns **all** pump.fun-related txs for that address, **ordered by recency**, and that each launch appears in at least one tx with a mint in tokenTransfers (or fallbacks). The repo does not document Helius’s semantics (e.g. “addresses” = program invoker vs. account). So we **cannot** state that coverage is guaranteed; it depends on Helius behavior and how pump.fun uses that address.

- **Reasons we can miss new pump.fun mints (with code references)**
  1. **Per-window page cap:** `MAX_PAGES_PER_WINDOW = 3` (index.ts:12, 289–292). If the window has more than 3 pages of txs, we stop; mints only in page 4+ are never seen for that window.
  2. **Per-window tx cap:** `MAX_TX_PER_WINDOW = 1000` (index.ts:13, 284–287). Same: we stop after 1000 txs; further mints in that window are missed.
  3. **Early stop (older-than-window):** When `pageMinTs < windowStartSec` or `pageMaxTs < windowStartSec` we break (261–269). We never fetch older pages; mints only in those older pages are not in this window’s set.
  4. **Pagination stuck:** If `!lastSig` or `lastSig === beforeSignature` we break (276–280). If Helius repeats the same cursor, we stop and miss any later pages.
  5. **Catch-up targets (freshness-first):** Targets are the last `MAX_WINDOWS_PER_RUN` minutes ending at `now_end`, optionally dropping targets `<= last_end` (index.ts:374–388). We **never** backfill windows older than that. So if the job was down or slow, we do not ingest older windows; mints that only appeared in those minutes are never written.
  6. **Window choice:** We only ingest 10-minute windows ending on minute boundaries; `window_start = window_end - 600`. A mint that only had activity in a gap (e.g. burst between two window boundaries) could be undercounted or not top-20 in any single window.
  7. **Helius limit/ordering:** URL uses `limit=100` (HELIUS_PAGE_LIMIT, index.ts:10). If Helius does not return newest-first or caps total results, we might not see the latest txs.
  8. **Mint not in tokenTransfers/fallbacks:** If a launch is represented in a tx but the mint appears only in a field we do not read, `extractMintFromTx` returns null and we skip it (324–325).

---

## 4) Windowing + idempotency correctness

- **window_end flooring**
  - **Catch-up:** `nowEndMs = Math.floor(Date.now() / 60000) * 60000` (index.ts:368) — floor “now” to minute in ms.
  - **Per-window:** `ingestOneWindow(supabase, windowEndMs, ...)` receives minute-aligned `windowEndMs` (410).

- **window_start**
  - `windowStartMs = windowEndMs - WINDOW_SECONDS * 1000`, `windowStartSec = Math.floor(windowStartMs / 1000)`, `windowEndSec = Math.floor(windowEndMs / 1000)` (index.ts:216–218). So window is `[windowStartSec, windowEndSec)` in seconds (10 minutes).

- **Idempotent upsert keys**
  - **Snapshots:** `trending_snapshots` upsert on `(window_seconds, window_end)` (index.ts:358–361). Unique constraint in 001_init.sql:15.
  - **Items:** `trending_items` is **insert** only (index.ts:408). Table has `primary key (snapshot_id, rank)` and `unique (snapshot_id, mint)` (001_init.sql:29–31). So same (snapshot_id, mint) cannot be inserted twice; rerunning the same window creates the same snapshot_id (via upsert) then inserts the same logical set of items — duplicate insert would violate unique and fail. So we rely on “run once per window” or accept insert errors on replay; there is no upsert on items.

- **Catch-up strategy and lag clamp**
  - **Targets:** Build `targetEndsMs = [nowEndMs - (MAX_WINDOWS_PER_RUN-1)*60*1000, ..., nowEndMs]` (5 minute-aligned window ends), then optionally remove targets `<= lastEndMs` if `last_end` exists (374–388). So we only ever ingest the **most recent** 5 windows (or fewer if filtered). We do **not** backfill older windows; there is no “lag clamp” that limits how far back we go (we never go back beyond those 5 minutes).
  - **Constant `MAX_LAG_MINUTES = 15`** exists (index.ts:9) but is **not** used in target selection after the switch to freshness-first targets (374–388).

- **Determinism and double-write/skip**
  - **Deterministic:** For a given `windowEndMs`, `ingestOneWindow` uses only that and derived `windowStartMs`/Sec; no `Date.now()` inside the window logic (215–223, 307).
  - **Double-write:** Snapshot upsert is idempotent. Items are insert; second run for same window would try to insert same (snapshot_id, mint) and hit unique constraint — so we do not “double-write” items; we’d get a DB error.
  - **Skip:** We can “skip” windows if we never add them to `targetEndsMs` (e.g. we only run the last 5 minutes and drop already-ingested targets). So we intentionally skip older windows and only ensure the latest few are ingested.

---

## 5) Performance + operational constraints

- **Timing logs**
  - **Request:** `[timing] request start` at handler start (index.ts:409); `[timing] request done ms` + elapsed before success response (451).
  - **Per-window:** `[timing] window start` and `[timing] window done` + elapsed + items_inserted (413–414, 417–418).
  - **Helius:** `[helius] page` (275), `[helius] early stop` (262, 266), `[helius] pagination stuck` (278), `[helius] page time range` (304).

- **Per-window and per-run bounds**
  - **Per window:** `MAX_PAGES_PER_WINDOW = 3`, `MAX_TX_PER_WINDOW = 1000` (index.ts:12–13); early stop when page timestamps &lt; windowStartSec (261–269); fetch timeout 10s per page (237).
  - **Per run:** `MAX_WINDOWS_PER_RUN = 5` (index.ts:8) — at most 5 windows per invocation.

- **MAX_* constants (all in index.ts top)**
  - `WINDOW_SECONDS = 600` (5)
  - `MAX_WINDOWS_PER_RUN = 5` (8)
  - `MAX_LAG_MINUTES = 15` (9) — unused in target selection
  - `HELIUS_PAGE_LIMIT = 100` (10)
  - `HELIUS_MAX_TX = 2000` (11) — unused in caps; actual cap is MAX_TX_PER_WINDOW
  - `MAX_PAGES_PER_WINDOW = 3` (12)
  - `MAX_TX_PER_WINDOW = 1000` (13)
  - `TOP_N = 20` (7)

- **O(n) or repeated DB**
  - One query for signal_wallets per request (474–478).
  - One query for last snapshot per request (491–497).
  - Per window: one snapshot upsert (357–363), one trending_items insert (408).
  - After all windows: one FDV enrichment query for candidates (532–536), then one update per enriched mint (557–561) — so up to 10 updates per run. No N+1 over windows; the only repeated work is the Birdeye + update loop for enrichment.

---

## 6) Database writes and schema usage

- **Tables touched by ingest-trending**
  - **trending_snapshots:** Insert or upsert row per (window_seconds, window_end). Columns: `window_seconds`, `window_end` (and default `id`, `created_at`). Constraint: `unique (window_seconds, window_end)` (001_init.sql:10–15). Strategy: upsert on conflict `(window_seconds, window_end)` (index.ts:358–361).
  - **trending_items:** Insert rows per (snapshot_id, rank, mint, …). Columns written: `snapshot_id`, `rank`, `mint`, `swap_count`, `fdv_usd`, `signal_touch_count`, `signal_points`, `buy_count`, `sell_count`, `unique_buyers`, `net_sol_inflow`, `buy_ratio`, `is_qualified` (index.ts:376–399). Constraints: `primary key (snapshot_id, rank)`, `unique (snapshot_id, mint)` (001_init.sql:29–31). Strategy: insert only; no upsert. Trigger `trg_set_inflow_signal_fields` (014/015) sets `inflow_band_ok`, `inflow_band_reason`, `inflow_score`, `mc_floor_ok`, `mc_structure_ok`, etc., and `is_alertworthy` on insert/update of `net_sol_inflow`, `is_qualified`, `fdv_usd`.
  - **FDV enrichment:** Updates `trending_items` rows by `mint` for `price_usd`, `total_supply`, `fdv_usd`, `updated_at` (index.ts:557–561).

- **trending_snapshots → trending_items**
  - `trending_items.snapshot_id` references `trending_snapshots(id) on delete cascade` (001_init.sql:21–22). Each snapshot has many items; each item belongs to one snapshot. Snapshot is created/upserted first; returned `id` is used as `snapshot_id` for the inserted items (364, 379).

- **Uniqueness and conflicts**
  - Snapshot: upsert on `(window_seconds, window_end)` — conflict updates the row (same id); we always get one id per window.
  - Items: insert; duplicate (snapshot_id, mint) would violate `unique (snapshot_id, mint)` and cause insert error. So rerunning the same window without clearing items would error on insert, not silently overwrite.

---

## 7) Actionable “keep it simple” next steps

Goal: *“monitor all pump.fun launches as fast as possible and alert for runner-threshold mints.”*

- **Option A — Smallest change**
  - **Increase per-window fetch headroom** so we see more txs per window and reduce the chance that new mints are in page 4+ or beyond 1000 txs.
  - **What:** Raise `MAX_PAGES_PER_WINDOW` (e.g. to 5–10) and/or `MAX_TX_PER_WINDOW` (e.g. to 2000) in `supabase/functions/ingest-trending/index.ts` (lines 12–13).
  - **Why:** No new services; same flow. Improves coverage only for windows where Helius has more than 3 pages / 1000 txs.
  - **Risk:** Slightly longer run per window; stay within Edge Function timeout.

- **Option B — Medium change**
  - **Run more often and/or ingest more recent windows** so we don’t miss bursts that fall between 5-minute cron runs or outside the 5-window slice.
  - **What:** (1) Change `.github/workflows/ingest-trending.yml` cron from `*/5` to `* * * * *` (every minute), and/or (2) increase `MAX_WINDOWS_PER_RUN` (e.g. to 10) in index.ts:8 so each run fills more minute-windows up to “now.”
  - **Why:** Same pipeline; more frequent and/or broader coverage of recent time; better chance to see launches quickly.
  - **Risk:** More invocations and/or more windows per run; respect concurrency and timeouts.

- **Option C — Larger change (still within current structure)**
  - **Add a dedicated “new mints” or “bond curve” source** alongside the current address-based Helius feed, so we are not solely dependent on txs that happen to include tokenTransfers for our address.
  - **What:** (1) Document or confirm with Helius whether “addresses” for pump.fun is the right scope for all launches; and/or (2) add one extra fetch in `ingestOneWindow` (or a separate small job) from an endpoint that lists recent pump.fun bond curve creations or new mints (if Helius or another provider offers it), then merge those mints into the same aggregation/window logic so they can enter top-20 and get rows in `trending_items`.
  - **Why:** Closer to “all pump.fun launches” without redesigning the rest; still reuses existing windowing, aggregation, and DB writes.
  - **Risk:** Extra API dependency and merge logic; need to map “new mint” events to a window and possibly to swap/buy metrics (may be partial).

---

**Document generated from repo state; all references are to the files and line numbers above.**
