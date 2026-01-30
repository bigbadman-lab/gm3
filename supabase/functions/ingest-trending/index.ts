// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const WINDOW_SECONDS = 600
const HELIUS_FETCH_TIMEOUT_MS = 15_000
const TOP_N = 20
const HELIUS_LIMIT = 100

// wSOL mint on Solana mainnet – exclude from trending
const WSOL_MINT = "So11111111111111111111111111111111111111112"

const LAMPORTS_PER_SOL = 1e9

type HeliusTx = {
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

    const supabase = createClient(supabaseUrl, serviceKey)

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

    const heliusUrl =
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(pumpfunAddress)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=${HELIUS_LIMIT}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), HELIUS_FETCH_TIMEOUT_MS)

    let transactions: HeliusTx[] = []
    try {
      const res = await fetch(heliusUrl, { signal: controller.signal })
      clearTimeout(timeoutId)
      if (!res.ok) {
        throw new Error(`Helius HTTP ${res.status}: ${await res.text()}`)
      }
      const data = await res.json()
      transactions = Array.isArray(data) ? data : []
    } catch (e) {
      clearTimeout(timeoutId)
      if (e instanceof Error) {
        if (e.name === "AbortError") throw new Error("Helius fetch timeout")
        throw e
      }
      throw e
    }

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
