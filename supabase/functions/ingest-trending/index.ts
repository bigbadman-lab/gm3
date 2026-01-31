// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const WINDOW_SECONDS = 600
const HELIUS_FETCH_TIMEOUT_MS = 15_000
const TOP_N = 20
const HELIUS_PAGE_LIMIT = 100
const HELIUS_MAX_TX = 2000

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

  for (const t of tx.tokenTransfers ?? []) {
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

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    const heliusApiKey = Deno.env.get("HELIUS_API_KEY")
    const pumpfunAddress = Deno.env.get("PUMPFUN_ADDRESS")

    if (!supabaseUrl || !serviceKey || !heliusApiKey || !pumpfunAddress) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HELIUS_API_KEY, or PUMPFUN_ADDRESS",
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

    const now = Date.now()
    const windowEnd = new Date(now)
    const windowStart = new Date(now - WINDOW_SECONDS * 1000)
    const windowStartSec = Math.floor(windowStart.getTime() / 1000)
    const windowEndSec = Math.floor(windowEnd.getTime() / 1000)

    const heliusBaseUrl =
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(pumpfunAddress)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=${HELIUS_PAGE_LIMIT}`

    const transactions: HeliusTx[] = []
    let beforeSignature: string | undefined = undefined
    let pageNum = 0
    let stopReason: "covered window" | "cap reached" | "no more pages" | "paging stuck" | null = null
    let firstSigPage1: string | undefined = undefined

    while (true) {
      pageNum += 1
      const pageUrl = beforeSignature
        ? `${heliusBaseUrl}&before=${encodeURIComponent(beforeSignature)}`
        : heliusBaseUrl

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), HELIUS_FETCH_TIMEOUT_MS)
      let page: HeliusTx[]
      try {
        const res = await fetch(pageUrl, { signal: controller.signal })
        clearTimeout(timeoutId)
        if (!res.ok) {
          throw new Error(`Helius HTTP ${res.status}: ${await res.text()}`)
        }
        const data = await res.json()
        page = Array.isArray(data) ? data : []
      } catch (e) {
        clearTimeout(timeoutId)
        if (e instanceof Error) {
          if (e.name === "AbortError") throw new Error("Helius fetch timeout")
          throw e
        }
        throw e
      }

      if (page.length === 0) {
        stopReason = "no more pages"
        console.log("[HELIUS] page", pageNum, "size=0 total=" + transactions.length, "stop=no more pages")
        break
      }

      transactions.push(...page)
      const firstInPage = page[0]
      const firstSig = firstInPage?.signature ?? (firstInPage as { transactionSignature?: string }).transactionSignature
      if (pageNum === 1) {
        firstSigPage1 = firstSig
      } else if (pageNum === 2 && firstSig != null && firstSig === firstSigPage1) {
        console.log("[HELIUS] paging appears stuck (page 2 same as page 1)")
        stopReason = "paging stuck"
        break
      }
      const lastInPage = page[page.length - 1]
      const oldestInPage = lastInPage?.timestamp
      const cursor = lastInPage?.signature ?? (lastInPage as { transactionSignature?: string }).transactionSignature
      beforeSignature = cursor ?? undefined

      console.log(
        "[HELIUS] page", pageNum,
        "size=" + page.length,
        "total=" + transactions.length,
        "oldest_ts=" + (oldestInPage ?? "?"),
        "before=" + (beforeSignature ?? "none")
      )

      if (transactions.length >= HELIUS_MAX_TX) {
        stopReason = "cap reached"
        break
      }
      if (oldestInPage != null && oldestInPage < windowStartSec) {
        stopReason = "covered window"
        break
      }
      if (!beforeSignature) {
        stopReason = "no more pages"
        break
      }
    }

    console.log("[HELIUS] final total=" + transactions.length, "stop_reason=" + (stopReason ?? "unknown"))

    const inWindow = (tx: HeliusTx) => {
      const ts = tx.timestamp
      if (ts == null) return false
      return ts >= windowStartSec && ts <= windowEndSec
    }

    const swapCountByMint = new Map<string, number>()
    const signalTouchCountByMint = new Map<string, number>()
    const signalPointsByMint = new Map<string, number>()
    const buyCountByMint = new Map<string, number>()
    const sellCountByMint = new Map<string, number>()
    const uniqueBuyersByMint = new Map<string, Set<string>>()
    const buySolByMint = new Map<string, number>()
    const sellSolByMint = new Map<string, number>()
    for (const tx of transactions) {
      if (!inWindow(tx)) continue
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

    const topMints = [...swapCountByMint.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)

    const windowEndIso = windowEnd.toISOString()
    const windowStartIso = windowStart.toISOString()

    const { data: snapshot, error: snapError } = await supabase
      .from("trending_snapshots")
      .insert({ window_seconds: WINDOW_SECONDS, window_end: windowEndIso })
      .select("id")
      .single()

    if (snapError) {
      return new Response(
        JSON.stringify({ ok: false, error: snapError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    const snapshotId = snapshot.id

    if (topMints.length > 0) {
      const items = topMints.map(([mint, swap_count], i) => {
        const buy_count = Math.max(0, buyCountByMint.get(mint) ?? 0)
        const sell_count = Math.max(0, sellCountByMint.get(mint) ?? 0)
        const unique_buyers = Math.max(0, uniqueBuyersByMint.get(mint)?.size ?? 0)
        const total_buy_sol = Math.max(0, buySolByMint.get(mint) ?? 0)
        const total_sell_sol = Math.max(0, sellSolByMint.get(mint) ?? 0)
        const net_sol_inflow = Math.max(0, total_buy_sol - total_sell_sol)
        const total_swaps = buy_count + sell_count
        const buy_ratio = total_swaps === 0 ? 0 : Math.min(1, Math.max(0, buy_count / total_swaps))
        const is_qualified =
          unique_buyers >= 20 &&
          buy_ratio >= 0.65 &&
          net_sol_inflow >= 3 &&
          swap_count >= 25
        return {
          snapshot_id: snapshotId,
          rank: i + 1,
          mint,
          swap_count,
          fdv_usd: null,
          signal_touch_count: signalTouchCountByMint.get(mint) ?? 0,
          signal_points: signalPointsByMint.get(mint) ?? 0,
          buy_count,
          sell_count,
          unique_buyers,
          net_sol_inflow,
          buy_ratio,
          is_qualified,
        }
      })
      const { error: itemsError } = await supabase.from("trending_items").insert(items)
      if (itemsError) {
        return new Response(
          JSON.stringify({ ok: false, error: itemsError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        )
      }
    }

    let updatedCount = 0
    try {
      // FDV enrichment: fill price_usd, total_supply, fdv_usd for candidates (right before response)
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
    console.log("[FDV] enriched", updatedCount, "tokens");

    const top = topMints.map(([mint, swap_count], i) => ({
      rank: i + 1,
      mint,
      swap_count,
      signal_touch_count: signalTouchCountByMint.get(mint) ?? 0,
      signal_points: signalPointsByMint.get(mint) ?? 0,
    }))

    return new Response(
      JSON.stringify({
        ok: true,
        window_start: windowStartIso,
        window_end: windowEndIso,
        snapshot_id: snapshotId,
        items_inserted: topMints.length,
        top,
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
})
