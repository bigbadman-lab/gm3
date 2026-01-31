# GM3 — Real-Time Token Discovery & Alerting Engine

GM3 is a real-time Solana token discovery, qualification, and alerting system.  
It ingests on-chain activity, detects early momentum, filters for quality, and surfaces high-signal tokens to users via API, web, iOS, and CLI.

GM3 is designed around **deterministic, explainable logic** rather than black-box ML, with clear lifecycle stages and tiered access (Free vs Pro).

---

## High-Level Architecture

GM3 is composed of four main layers:

1. **Ingestion (Discovery)**
   - Fetches on-chain transactions from Helius
   - Aggregates activity per mint in short time windows
   - Identifies trending tokens

2. **Qualification & Alert Logic**
   - Applies explicit qualification thresholds
   - Applies capital efficiency + market structure checks
   - Determines whether a token is “alertworthy”

3. **ATH Tracking**
   - Promotes alertworthy mints into an ATH tracking pipeline
   - Polls FDV via Birdeye
   - Tracks current FDV and all-time highs over time

4. **Read API**
   - Serves data to web, iOS, and CLI clients
   - Applies blocklists and sorting
   - Enforces tiered access (Free vs Pro)

---

## Core Tables

| Table | Purpose |
|------|--------|
| `trending_snapshots` | One row per ingestion window (e.g. 10 min). |
| `trending_items` | Per-snapshot metrics per mint (swaps, buyers, inflow, etc.). |
| `trending_items_latest` | View: latest row per mint. |
| `mint_entries` | Mints promoted for ATH tracking. |
| `token_ath` | Current FDV, ATH FDV, polling schedule per mint. |
| `blocked_mints` | Explicitly blocked token mints. |
| `blocked_creators` | Blocked creator wallets. |
| `watchlist_daily` | Manual GM3 watchlist entries. |

---

## End-to-End Token Lifecycle

### 1. Mint Discovery (Helius)
- GM3 fetches recent transactions from Helius for a monitored program.
- Transactions are filtered to a fixed time window.
- Each transaction is parsed to extract:
  - mint
  - buy/sell classification
  - SOL amount
  - actor wallet

### 2. Aggregation & Trending Selection
For each mint in the window, GM3 aggregates:
- swap_count
- buy_count / sell_count
- unique_buyers
- net_sol_inflow
- signal wallet touches

Only the **top N mints by swap_count** (currently 20) are kept per window.

---

## Qualification Logic (Explicit)

A mint is marked **qualified** if **all** of the following are true:

- `unique_buyers >= 20`
- `buy_ratio >= 0.65`
- `net_sol_inflow >= 3` SOL
- `swap_count >= 25`

This logic is applied at insert time when writing to `trending_items`.

```text
qualified =
  unique_buyers >= 20 AND
  buy_ratio >= 0.65 AND
  net_sol_inflow >= 3 AND
  swap_count >= 25
