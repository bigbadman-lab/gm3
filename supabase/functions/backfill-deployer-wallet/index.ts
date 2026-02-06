// Backfill token_cache.deployer_wallet using Birdeye token_creation_info (returns owner = creator/deployer).
// Run on a schedule or manually. Uses BIRDEYE_API_KEY. Limits calls per run via BACKFILL_DEPLOYER_LIMIT (default 20).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const BIRDEYE_CREATION_INFO_URL = "https://public-api.birdeye.so/defi/token_creation_info"
const DEFAULT_LIMIT = 20

async function fetchCreationInfo(mint: string, apiKey: string): Promise<{ owner: string } | null> {
  const url = `${BIRDEYE_CREATION_INFO_URL}?address=${encodeURIComponent(mint)}`
  const res = await fetch(url, {
    headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { success?: boolean; data?: { owner?: string } }
  if (body?.success !== true || body?.data?.owner == null) return null
  const owner = String(body.data.owner).trim()
  return owner ? { owner } : null
}

Deno.serve(async (req: Request) => {
  try {
    const apiKey = Deno.env.get("BIRDEYE_API_KEY") ?? ""
    if (!apiKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "BIRDEYE_API_KEY not set" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    const limitRaw = Deno.env.get("BACKFILL_DEPLOYER_LIMIT")
    const limit = Math.min(100, Math.max(1, parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT))

    const url = new URL(req.url)
    const forceMint = url.searchParams.get("mint")?.trim() || null

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    let mintsToFill: string[] = []
    if (forceMint) {
      mintsToFill = [forceMint]
    } else {
      // Mints that appeared in trending but token_cache has no deployer_wallet (or no row)
      const { data: rows, error } = await supabase
        .from("trending_items")
        .select("mint")
        .order("updated_at", { ascending: false })
        .limit(limit * 3)
      if (error) throw error
      const seen = new Set<string>()
      const list: string[] = []
      for (const r of rows ?? []) {
        const m = (r as { mint: string }).mint
        if (m && !seen.has(m)) {
          seen.add(m)
          list.push(m)
          if (list.length >= limit) break
        }
      }
      const { data: withDeployer } = await supabase
        .from("token_cache")
        .select("mint")
        .not("deployer_wallet", "is", null)
      const hasDeployer = new Set((withDeployer ?? []).map((x: { mint: string }) => x.mint))
      mintsToFill = list.filter((m) => !hasDeployer.has(m)).slice(0, limit)
    }

    let updated = 0
    let failed = 0
    for (const mint of mintsToFill) {
      const info = await fetchCreationInfo(mint, apiKey)
      if (!info) {
        failed++
        continue
      }
      const { error } = await supabase
        .from("token_cache")
        .upsert(
          { mint, deployer_wallet: info.owner, updated_at: new Date().toISOString() },
          { onConflict: "mint" }
        )
      if (!error) updated++
    }

    return new Response(
      JSON.stringify({
        ok: true,
        updated,
        failed,
        processed: mintsToFill.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: (err as Error)?.message ?? String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
