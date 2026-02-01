// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const WINDOW_SECONDS = 60
const HELIUS_FETCH_TIMEOUT_MS = 15_000
const MAX_WINDOWS_PER_RUN = 5
const MAX_QUALIFIED_PER_WINDOW = 200
const HELIUS_PAGE_LIMIT = 100
const PAGE_TIMEOUT_MS = 8000
const INGEST_STATE_NAME = "ingest-trending"
const BOOTSTRAP_MAX_PAGES = 3
const MAX_PAGES_PER_RUN = 50
const MAX_TXS_PER_RUN = 5000
const INGEST_TRENDING_BUILD = "cursor-v1-2026-02-01"

// wSOL mint on Solana mainnet – exclude from trending
const WSOL_MINT = "So11111111111111111111111111111111111111112"

const LAMPORTS_PER_SOL = 1e9

type HeliusTx = {
  signature?: string
  timestamp?: number
  feePayer?: string
  tokenTransfers?: Array<{ mint?: string; fromUserAccount?: string; toUserAccount?: string }>
  nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>
  events?: {
    swap?: {
      tokenInputs?: Array<{ mint?: string }>
      tokenOutputs?: Array<{ mint?: string }>
    }
  }
  accountData?: Array<{
    tokenBalanceChanges?: Array<{ mint?: string }>
  }>
}

function extractMintFromTx(tx: HeliusTx): string | null {
  const seen = new Set<string>()

  const add = (mint: string | undefined) => {
    if (!mint || mint === WSOL_MINT) return null
    if (seen.has(mint)) return null
    seen.add(mint)
    return mint
  }

  // Primary: tokenTransfers[*].mint (support both camelCase and snake_case from API)
  const transfers = tx.tokenTransfers ?? (tx as Record<string, unknown>).token_transfers as Array<{ mint?: string }> | undefined
  for (const t of transfers ?? []) {
    const m = add(t.mint)
    if (m) return m
  }

  const swap = tx.events?.swap
  for (const t of swap?.tokenInputs ?? []) {
    const m = add(t.mint)
    if (m) return m
  }
  for (const t of swap?.tokenOutputs ?? []) {
    const m = add(t.mint)
    if (m) return m
  }

  for (const acc of tx.accountData ?? []) {
    for (const ch of acc.tokenBalanceChanges ?? []) {
      const m = add(ch.mint)
      if (m) return m
    }
  }

  return null
}

function extractActorWalletFromTx(tx: HeliusTx): string | null {
  if (tx.feePayer) return tx.feePayer
  const tt = tx.tokenTransfers ?? []
  for (const t of tt) {
    if (t.fromUserAccount) return t.fromUserAccount
  }
  for (const t of tt) {
    if (t.toUserAccount) return t.toUserAccount
  }
  return null
}

/** Classify tx as buy (actor received mint) or sell (actor sent mint). */
function classifyBuySell(tx: HeliusTx, mint: string, actor: string): "buy" | "sell" | null {
  const tt = tx.tokenTransfers ?? []
  for (const t of tt) {
    if (t.mint !== mint) continue
    if (t.toUserAccount === actor) return "buy"
    if (t.fromUserAccount === actor) return "sell"
  }
  return null
}

/** SOL amount transferred by actor in this tx: sent (buy) or received (sell). Lamports → SOL. */
function getSolAmountForActor(
  tx: HeliusTx,
  actor: string,
  direction: "buy" | "sell"
): number {
  const nt = tx.nativeTransfers ?? []
  let lamports = 0
  for (const n of nt) {
    if (direction === "buy" && n.fromUserAccount === actor) lamports += Number(n.amount ?? 0)
    if (direction === "sell" && n.toUserAccount === actor) lamports += Number(n.amount ?? 0)
  }
  return lamports / LAMPORTS_PER_SOL
}

/** Birdeye token overview: price, supply, FDV, last trade time. Returns null on API error or missing data. */
async function fetchBirdeyeOverview(mint: string): Promise<{
  priceUsd: number
  totalSupply: number
  fdvUsd: number
  lastTradeUnixTime: number
} | null> {
  const apiKey = Deno.env.get("BIRDEYE_API_KEY")
  if (!apiKey) return null
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`
  try {
    const res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
      },
    })
    if (!res.ok) return null
    const body = await res.json() as { success?: boolean; data?: { price?: number; totalSupply?: number; fdv?: number; lastTradeUnixTime?: number } }
    if (body?.success !== true || body?.data == null) return null
    const d = body.data
    const priceUsd = d.price
    const totalSupply = d.totalSupply
    const fdvUsd = d.fdv
    const lastTradeUnixTime = d.lastTradeUnixTime
    if (
      typeof priceUsd !== "number" ||
      typeof totalSupply !== "number" ||
      typeof fdvUsd !== "number" ||
      typeof lastTradeUnixTime !== "number"
    ) return null
    return { priceUsd, totalSupply, fdvUsd, lastTradeUnixTime }
  } catch {
    return null
  }
}

function normalizeError(e: unknown): { message?: string; name?: string; stack?: string; details?: string } {
  if (typeof e === "string") return { message: e }
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack }
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>
    const message = (anyE.message ?? anyE.error_description ?? anyE.error) as string | undefined
    const details = (anyE.details ?? anyE.hint ?? anyE.code) as string | undefined
    try {
      return { message: message ?? JSON.stringify(anyE), details }
    } catch {
      return { message: String(anyE), details }
    }
  }
  return { message: String(e) }
}

function toUnixSeconds(ts: unknown): number | null {
  if (ts == null) return null
  if (typeof ts === "number") {
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts)
  }
  if (typeof ts === "string") {
    const n = Number(ts)
    if (!Number.isNaN(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
    const ms = Date.parse(ts)
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
  }
  return null
}

function getTxTimeSec(tx: unknown): number | null {
  if (tx == null || typeof tx !== "object") return null
  const t = tx as Record<string, unknown>
  return (
    toUnixSeconds(t.timestamp) ??
    toUnixSeconds(t.blockTime) ??
    toUnixSeconds(t.time) ??
    toUnixSeconds((t.parsed as { timestamp?: unknown } | undefined)?.timestamp) ??
    null
  )
}

function getTxSignature(tx: unknown): string | null {
  if (tx == null || typeof tx !== "object") return null
  const t = tx as Record<string, unknown>
  const sig = t.signature ?? (t as { transactionSignature?: string }).transactionSignature
  return typeof sig === "string" && sig.length > 0 ? sig : null
}

/** fetch with hard timeout via AbortController. */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timeoutId)
    return res
  } catch (e) {
    clearTimeout(timeoutId)
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("fetch timeout")
    }
    throw e
  }
}

/** Aggregate txs for one window and upsert snapshot + items. Txs are pre-bucketed; filter by window. */
async function aggregateAndUpsertWindow(
  supabase: ReturnType<typeof createClient>,
  windowEndMs: number,
  txs: HeliusTx[],
  signalWalletToWeight: Map<string, number>
): Promise<{ snapshot_id: string; items_inserted: number; window_end: string; mints_extracted: number; qualified_count: number }> {
  const windowEndSec = Math.floor(windowEndMs / 1000)
  const windowStartSec = windowEndSec - WINDOW_SECONDS
  const windowEndIso = new Date(windowEndMs).toISOString()

  const inWindow = (tx: HeliusTx) => {
    const t = getTxTimeSec(tx)
    if (t == null) return false
    return windowStartSec <= t && t < windowEndSec
  }
  const filteredTxs = txs.filter(inWindow)

  const swapCountByMint = new Map<string, number>()
  const signalTouchCountByMint = new Map<string, number>()
  const signalPointsByMint = new Map<string, number>()
  const buyCountByMint = new Map<string, number>()
  const sellCountByMint = new Map<string, number>()
  const uniqueBuyersByMint = new Map<string, Set<string>>()
  const buySolByMint = new Map<string, number>()
  const sellSolByMint = new Map<string, number>()
  for (const tx of filteredTxs) {
    const mint = extractMintFromTx(tx)
    if (!mint) continue
    swapCountByMint.set(mint, (swapCountByMint.get(mint) ?? 0) + 1)
    const actorWallet = extractActorWalletFromTx(tx)
    if (actorWallet && signalWalletToWeight.has(actorWallet)) {
      const weight = signalWalletToWeight.get(actorWallet) ?? 0
      signalTouchCountByMint.set(mint, (signalTouchCountByMint.get(mint) ?? 0) + 1)
      signalPointsByMint.set(mint, (signalPointsByMint.get(mint) ?? 0) + weight)
    }
    if (actorWallet) {
      const side = classifyBuySell(tx, mint, actorWallet)
      if (side === "buy") {
        buyCountByMint.set(mint, (buyCountByMint.get(mint) ?? 0) + 1)
        if (!uniqueBuyersByMint.has(mint)) uniqueBuyersByMint.set(mint, new Set())
        uniqueBuyersByMint.get(mint)!.add(actorWallet)
        const sol = getSolAmountForActor(tx, actorWallet, "buy")
        buySolByMint.set(mint, (buySolByMint.get(mint) ?? 0) + sol)
      } else if (side === "sell") {
        sellCountByMint.set(mint, (sellCountByMint.get(mint) ?? 0) + 1)
        const sol = getSolAmountForActor(tx, actorWallet, "sell")
        sellSolByMint.set(mint, (sellSolByMint.get(mint) ?? 0) + sol)
      }
    }
  }

  const { data: snapshot, error: snapError } = await supabase
    .from("trending_snapshots")
    .upsert(
      { window_seconds: WINDOW_SECONDS, window_end: windowEndIso },
      { onConflict: "window_seconds,window_end" }
    )
    .select("id")
    .single()

  if (snapError) throw snapError
  const snapshotId = snapshot.id

  const qualifiedCandidates: Array<{ mint: string; swap_count: number; buy_count: number; sell_count: number; unique_buyers: number; net_sol_inflow: number; buy_ratio: number; is_qualified: true }> = []
  for (const [mint, swap_count] of swapCountByMint.entries()) {
    const buy_count = Math.max(0, buyCountByMint.get(mint) ?? 0)
    const sell_count = Math.max(0, sellCountByMint.get(mint) ?? 0)
    const unique_buyers = Math.max(0, uniqueBuyersByMint.get(mint)?.size ?? 0)
    const total_buy_sol = Math.max(0, buySolByMint.get(mint) ?? 0)
    const total_sell_sol = Math.max(0, sellSolByMint.get(mint) ?? 0)
    const net_sol_inflow = Math.max(0, total_buy_sol - total_sell_sol)
    const total_swaps = buy_count + sell_count
    const buy_ratio = total_swaps === 0 ? 0 : Math.min(1, Math.max(0, buy_count / total_swaps))
    const is_qualified =
      unique_buyers >= 5 &&
      buy_ratio >= 0.65 &&
      net_sol_inflow >= 1 &&
      swap_count >= 10
    if (is_qualified) {
      qualifiedCandidates.push({ mint, swap_count, buy_count, sell_count, unique_buyers, net_sol_inflow, buy_ratio, is_qualified: true })
    }
  }

  const sorted = qualifiedCandidates
    .sort((a, b) => {
      if (b.net_sol_inflow !== a.net_sol_inflow) return b.net_sol_inflow - a.net_sol_inflow
      if (b.swap_count !== a.swap_count) return b.swap_count - a.swap_count
      return b.unique_buyers - a.unique_buyers
    })
    .slice(0, MAX_QUALIFIED_PER_WINDOW)

  const items = sorted.map((c, i) => ({
    snapshot_id: snapshotId,
    rank: i + 1,
    mint: c.mint,
    swap_count: c.swap_count,
    fdv_usd: null,
    signal_touch_count: signalTouchCountByMint.get(c.mint) ?? 0,
    signal_points: signalPointsByMint.get(c.mint) ?? 0,
    buy_count: c.buy_count,
    sell_count: c.sell_count,
    unique_buyers: c.unique_buyers,
    net_sol_inflow: c.net_sol_inflow,
    buy_ratio: c.buy_ratio,
    is_qualified: true,
  }))

  let itemsInserted = 0
  if (items.length > 0) {
    const { error: itemsError } = await supabase.from("trending_items").upsert(items, { onConflict: "snapshot_id,mint" })
    if (itemsError) throw itemsError
    itemsInserted = items.length
  }

  return {
    snapshot_id: snapshotId,
    items_inserted: itemsInserted,
    window_end: windowEndIso,
    mints_extracted: swapCountByMint.size,
    qualified_count: sorted.length,
  }
}

Deno.serve(async (req) => {
  try {
    console.log("[marker] ingest-trending hit", { ts: new Date().toISOString(), build: INGEST_TRENDING_BUILD })
    const reqStart = Date.now()
    console.log("[timing] request start")
    // Bearer token auth (no Supabase JWT). Set verify_jwt = false for this function so cron can call with header.
    const AUTH_ENV_NAME = "INGEST_TRENDING_TOKEN"
    const expected = Deno.env.get(AUTH_ENV_NAME) ?? ""
    const auth = (req.headers.get("authorization") ?? "").trim()
    const xcron = (req.headers.get("x-cron-token") ?? "").trim()
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
    const provided = bearer || xcron
    if (!expected || provided !== expected) {
      // TODO: remove debug logs after debugging 401
      console.log("[auth] env var name:", AUTH_ENV_NAME)
      console.log("[auth] env var set:", !!Deno.env.get(AUTH_ENV_NAME))
      console.log("[auth] header x-cron-token present:", req.headers.has("x-cron-token"))
      console.log("[auth] header authorization present:", req.headers.has("authorization"))
      console.log("[marker] ingest-trending unauthorized", new Date().toISOString())
      return new Response(JSON.stringify({ ok: false, error: normalizeError("unauthorized") }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    const heliusApiKey = Deno.env.get("HELIUS_API_KEY")
    const pumpfunAddress = Deno.env.get("PUMPFUN_ADDRESS")

    if (!supabaseUrl || !serviceKey || !heliusApiKey || !pumpfunAddress) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: normalizeError("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HELIUS_API_KEY, or PUMPFUN_ADDRESS"),
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    const supabase = createClient(supabaseUrl, serviceKey) // service role (not anon)

    const { data: signalRows, error: sigErr } = await supabase
      .from("signal_wallets")
      .select("wallet, weight")
      .eq("is_active", true)
    if (sigErr) throw sigErr
    const signalWalletToWeight = new Map<string, number>()
    for (const row of signalRows ?? []) {
      signalWalletToWeight.set(row.wallet, Number(row.weight) ?? 0)
    }

    const heliusBaseUrl =
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(pumpfunAddress)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=${HELIUS_PAGE_LIMIT}`

    // Load cursor
    const { data: stateRow, error: stateErr } = await supabase
      .from("ingest_state")
      .select("last_signature")
      .eq("name", INGEST_STATE_NAME)
      .maybeSingle()
    if (stateErr) throw stateErr
    const lastSignature = (stateRow?.last_signature ?? "").trim() || null
    console.log("[cursor] loaded last_signature", lastSignature ? "present" : "absent")

    const maxPages = lastSignature ? MAX_PAGES_PER_RUN : BOOTSTRAP_MAX_PAGES
    const buckets = new Map<number, HeliusTx[]>()
    let beforeSignature: string | undefined = undefined
    let newLastSignature: string | null = null
    let stopReason: "hit_last_signature" | "max_pages" | "max_windows" | "max_txs" | "no_more_pages" | null = null
    let pageNum = 0
    let totalTxsProcessed = 0
    let hitCursor = false

    while (pageNum < maxPages) {
      pageNum += 1
      const pageUrl = beforeSignature
        ? `${heliusBaseUrl}&before=${encodeURIComponent(beforeSignature)}`
        : heliusBaseUrl

      let page: HeliusTx[]
      try {
        const res = await fetchWithTimeout(pageUrl, undefined, PAGE_TIMEOUT_MS)
        if (!res.ok) {
          throw new Error(`Helius HTTP ${res.status}: ${await res.text()}`)
        }
        const data = await res.json()
        page = Array.isArray(data) ? data : []
      } catch (e) {
        if (e instanceof Error && e.message === "fetch timeout") {
          throw new Error(`Helius fetch timeout page=${pageNum}`)
        }
        throw e
      }

      if (page.length === 0) {
        stopReason = "no_more_pages"
        break
      }

      const firstSig = getTxSignature(page[0])
      const lastSig = getTxSignature(page[page.length - 1])
      if (pageNum === 1 && firstSig) newLastSignature = firstSig
      if (!lastSig || lastSig === beforeSignature) {
        stopReason = "no_more_pages"
        break
      }
      beforeSignature = lastSig

      for (const tx of page) {
        const sig = getTxSignature(tx)
        if (lastSignature && sig === lastSignature) {
          hitCursor = true
          stopReason = "hit_last_signature"
          break
        }
        const t = getTxTimeSec(tx)
        if (t == null) continue
        const windowEndSec = Math.floor(t / 60) * 60 + 60
        const windowEndMs = windowEndSec * 1000
        if (!buckets.has(windowEndMs)) buckets.set(windowEndMs, [])
        buckets.get(windowEndMs)!.push(tx)
        totalTxsProcessed += 1
        if (buckets.size >= MAX_WINDOWS_PER_RUN) {
          stopReason = "max_windows"
          break
        }
        if (totalTxsProcessed >= MAX_TXS_PER_RUN) {
          stopReason = "max_txs"
          break
        }
      }

      if (hitCursor || stopReason === "max_windows" || stopReason === "max_txs") break
      if (pageNum >= maxPages) {
        stopReason = "max_pages"
        break
      }
    }
    if (!stopReason) stopReason = "max_pages"

    const processed_tx_count = totalTxsProcessed
    console.log("[cursor] new_last_signature", newLastSignature ?? "(none)")
    console.log("[cursor] stop_reason", stopReason)
    console.log("[cursor] processed_tx_count", processed_tx_count)

    const windows: Array<{ window_end: string; snapshot_id: string; items_inserted: number }> = []
    const windowEndMsList = Array.from(buckets.keys()).sort((a, b) => b - a)
    for (const windowEndMs of windowEndMsList) {
      const txsInBucket = buckets.get(windowEndMs) ?? []
      const windowEndIso = new Date(windowEndMs).toISOString()
      const result = await aggregateAndUpsertWindow(supabase, windowEndMs, txsInBucket, signalWalletToWeight)
      console.log("[window]", {
        window_end: windowEndIso,
        txs_processed_in_bucket: txsInBucket.length,
        mints_extracted: result.mints_extracted,
        qualified_count: result.qualified_count,
        items_upserted: result.items_inserted,
      })
      windows.push({
        window_end: result.window_end,
        snapshot_id: result.snapshot_id,
        items_inserted: result.items_inserted,
      })
    }

    if (processed_tx_count > 0 && newLastSignature != null) {
      const { error: updateErr } = await supabase
        .from("ingest_state")
        .update({ last_signature: newLastSignature, updated_at: new Date().toISOString() })
        .eq("name", INGEST_STATE_NAME)
      if (updateErr) throw updateErr
    }

    let updatedCount = 0
    try {
      const enrichEnabled = (Deno.env.get("FDV_ENRICH_ENABLED") ?? "true") !== "false"
      const requireQualified = (Deno.env.get("FDV_REQUIRE_QUALIFIED") ?? "true") !== "false"
      const birdeyeKey = Deno.env.get("BIRDEYE_API_KEY") ?? ""
      if (enrichEnabled && birdeyeKey) {
        let candidatesQuery = supabase
          .from("trending_items")
          .select("mint")
          .or("fdv_usd.is.null,price_usd.is.null,total_supply.is.null")
        if (requireQualified) {
          candidatesQuery = candidatesQuery.eq("is_qualified", true)
        }
        const { data: candidates, error: candidatesErr } = await candidatesQuery
          .order("swap_count", { ascending: false })
          .limit(10)
        if (!candidatesErr && candidates?.length) {
          for (const row of candidates) {
            const mint = row.mint
            const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`
            const res = await fetch(url, {
              headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana" },
            })
            if (!res.ok) continue
            const body = await res.json() as { success?: boolean; data?: { price?: number; totalSupply?: number; fdv?: number } }
            if (body?.success !== true || !body?.data) continue
            const d = body.data
            const price_usd = d.price
            const total_supply = d.totalSupply
            const fdv_usd = d.fdv ?? (typeof d.price === "number" && typeof d.totalSupply === "number" ? d.price * d.totalSupply : undefined)
            if (
              typeof price_usd !== "number" || !Number.isFinite(price_usd) ||
              typeof total_supply !== "number" || !Number.isFinite(total_supply) ||
              typeof fdv_usd !== "number" || !Number.isFinite(fdv_usd)
            ) continue
            const { error: updateErr } = await supabase
              .from("trending_items")
              .update({ price_usd, total_supply, fdv_usd, updated_at: new Date().toISOString() })
              .eq("mint", mint)
            if (!updateErr) updatedCount++
          }
        }
      }
    } catch (e) {
      // enrichment error: continue to response
    }
    if (updatedCount > 0) console.log("[FDV] enriched", updatedCount, "tokens")
    console.log("[timing] request done ms", Date.now() - reqStart)
    console.log("[marker] ingest-trending success", new Date().toISOString())

    const nowEndIso = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "cursor",
        now_end: nowEndIso,
        ingested_count: windows.length,
        windows,
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("ingest-trending failed", err)
    return new Response(
      JSON.stringify({ ok: false, error: normalizeError(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
})
