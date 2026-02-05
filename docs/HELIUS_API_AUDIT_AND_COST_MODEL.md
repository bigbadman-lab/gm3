# Helius API audit and cost model

## 1. Where we call Helius

**Single caller:** `supabase/functions/ingest-trending/index.ts`  
**Trigger:** pg_cron job `gm3-ingest-trending-60s-layer1` runs **every minute** (`* * * * *`).

**Endpoint:** Helius “address transactions” (Enhanced Transactions API)

- **URL:**  
  `https://api-mainnet.helius-rpc.com/v0/addresses/${PUMPFUN_ADDRESS}/transactions?api-key=${HELIUS_API_KEY}&limit=100`  
  Pagination: `&before=${lastTxSignature}` for the next page.
- **Method:** GET (no request body).
- **Per request:** One HTTP GET = **one Helius API call** = **100 credits** (Enhanced Transactions pricing).
- **Monthly credit budget (example):** 100M credits → **1,000,000 calls/month** max to stay within budget.

There are **no other** Helius call sites in this repo (no other Edge Functions or jobs).

---

## 2. How many calls per run?

Each **invocation** of ingest-trending does a **loop of GETs** until one of:

| Condition | Effect |
|-----------|--------|
| Empty page | Stop (0 more pages). |
| Hit saved cursor | We’ve reached `last_signature` from last run → stop. |
| Reached 5 windows | `MAX_WINDOWS_PER_RUN` → stop. |
| Reached 5,000 txs | `MAX_TXS_PER_RUN` → stop. |
| Reached max pages | Stop. |
| Pagination stuck | Same `lastSig` as `before` → stop. |

**Max pages per run:**

- **Bootstrap (no cursor):** `BOOTSTRAP_MAX_PAGES = 3` → **at most 3 calls** per run.
- **Steady state (cursor present):** `MAX_PAGES_PER_RUN = 50` → **at most 50 calls** per run.

So:

- **Minimum per run:** 1 call (e.g. one full page, then hit cursor or empty next page).
- **Maximum per run:** 3 (bootstrap) or 50 (steady state).

**Constants (reference):**

| Constant | Value | Role |
|----------|--------|------|
| `HELIUS_PAGE_LIMIT` | 100 | Transactions per request. |
| `PAGE_TIMEOUT_MS` | 8_000 | Timeout per GET. |
| `BOOTSTRAP_MAX_PAGES` | 3 | Max pages when there is no cursor. |
| `MAX_PAGES_PER_RUN` | 50 | Max pages when cursor exists. |
| `MAX_WINDOWS_PER_RUN` | 5 | Stop after 5 distinct 60s windows. |
| `MAX_TXS_PER_RUN` | 5_000 | Stop after 5k txs processed. |

---

## 3. Call volume model

**Schedule:** 1 run per minute (cron).

- **Runs per day:** 24 × 60 = **1,440**.
- **Runs per month (30 days):** **43,200**.

**Calls per run (steady state):**

- If the cursor is usually “close to now” (e.g. cron has been running every minute), most runs need only **1–2 pages** to cover the new minute of data → **1–2 calls/run**.
- If the cron was off for a while or there’s a burst of activity, a run can use up to **50 pages** until it hits cursor or a cap.

**Bounding the model:**

| Scenario | Calls/run | Runs/day | Calls/day | Calls/month (30d) |
|---------|-----------|----------|-----------|---------------------|
| **Best case** (always 1 page) | 1 | 1,440 | 1,440 | 43,200 |
| **Typical** (often 1–2 pages) | 1.5 | 1,440 | 2,160 | 64,800 |
| **Heavy** (often 3–5 pages) | 4 | 1,440 | 5,760 | 172,800 |
| **Worst case** (every run = 50 pages) | 50 | 1,440 | 72,000 | 2,160,000 |

So:

- **Lower bound:** ~**43k calls/month** (1 call/run, 1,440 runs/day).
- **Upper bound:** ~**2.16M calls/month** if every run used 50 pages (unrealistic if cursor is advancing).
- **Reasonable “high but plausible”:** ~**65k–170k calls/month** if many runs use 2–5 pages (e.g. busy periods or short catch-ups).

---

## 4. What drives calls per run?

1. **Cursor position**  
   Cursor = `last_signature` in `ingest_state`. If cron runs every minute, each run only needs to fetch txs **newer** than that signature. That’s often 0–2 pages. If cron was down for 30 minutes, one run might need many more pages to catch up (capped at 50).

2. **Activity level**  
   More pump.fun txs for `PUMPFUN_ADDRESS` → more txs per page and more pages to reach the cursor or fill 5 windows.

3. **Early exits**  
   Hitting **5 windows** or **5,000 txs** stops the loop even if we haven’t hit the cursor, so real runs often use fewer than 50 pages.

4. **Bootstrap**  
   Only when `last_signature` is null (e.g. first run or after reset), max pages = 3. So bootstrap is a small one-time cost.

---

## 5. Credit budget (100 credits per call, 100M credits/month)

| Item | Value |
|------|--------|
| Credits per Enhanced Transaction call | 100 |
| Monthly credit budget | 100,000,000 |
| **Max calls within budget** | **1,000,000** per month |
| Runs per month (1/min cron) | 43,200 |

**Budget cap in “calls per run” (average):**

- 1,000,000 ÷ 43,200 ≈ **23.15 calls/run** average to stay under 100M credits.
- If **average calls/run > ~23**, you will exceed 100M credits in a month.
- If **every** run used 50 pages (50 calls), you’d use 43,200 × 50 = **2.16M calls** = **216M credits** → over budget.

**Safe zone:** Keep **average calls per run** at or below **~23** (e.g. by lowering `MAX_PAGES_PER_RUN` from 50 to 20–25, or running the cron less often) so monthly usage stays at or below 1M calls (100M credits).

---

## 6. Cost model inputs for your plan

You can plug these into your own pricing (e.g. per-call or per-request from Helius):

- **Runs per month:** `43_200` (1 run/min).
- **Min calls/month:** `43_200` (1 call/run).
- **Assumed average calls/run:** e.g. `2` → **86,400 calls/month**; `5` → **216,000 calls/month**.
- **Max calls/run:** `50` → **2,160,000 calls/month** if every run used 50 pages.

Suggested approach:

1. **Measure:** From Edge Function logs or a small metrics patch, log **pages fetched** (or **HTTP requests to Helius**) per run and average over a few days.
2. **Set:** `avg_calls_per_run = (sum of calls over N runs) / N`.
3. **Estimate:**  
   `monthly_calls = 43_200 × avg_calls_per_run`.
4. **Compare:** To Helius pricing (e.g. per 1k or per 10k requests) to get monthly cost.

---

## 7. Levers to reduce calls (no code change)

| Lever | Effect |
|-------|--------|
| **Run less often** | e.g. every 2 minutes → 21,600 runs/month → about half the calls (if calls/run stay similar). |
| **Lower `MAX_PAGES_PER_RUN`** | Caps catch-up after downtime (e.g. 50 → 20); fewer calls per run, more runs to fully catch up. |
| **Lower `MAX_WINDOWS_PER_RUN`** | Stops earlier when you have “enough” windows; can reduce pages when activity is high. |
| **Increase `HELIUS_PAGE_LIMIT`** | If Helius allows >100 txs per request, you get more txs per call and need fewer calls for the same coverage. |

---

## 8. Quick reference

| Item | Value |
|------|--------|
| **Only caller** | ingest-trending Edge Function |
| **Trigger** | pg_cron every 1 minute |
| **Endpoint** | `GET .../v0/addresses/{address}/transactions?api-key=...&limit=100[&before=...]` |
| **Calls per run** | 1–3 (bootstrap) or 1–50 (steady state) |
| **Runs per month** | 43,200 |
| **Min calls/month** | 43,200 |
| **Typical range** | ~65k–170k/month (2–4 calls/run average) |
| **Max (theoretical)** | 2,160,000/month (50 calls/run every time) |

To refine the model, add logging of **number of Helius requests per run** in ingest-trending and average it over a week, then use:

`monthly_helius_calls ≈ 43_200 × avg_requests_per_run`.
