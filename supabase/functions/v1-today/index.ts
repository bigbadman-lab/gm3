import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function utcDayString(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

Deno.serve(async (_req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, serviceKey);

    const today = utcDayString();

    // Blocklists (is_active only)
    const { data: blockedMintsRows, error: bmErr } = await supabase
      .from("blocked_mints")
      .select("mint")
      .eq("is_active", true);
    if (bmErr) throw bmErr;
    const blockedMints = new Set((blockedMintsRows ?? []).map((r: { mint: string }) => r.mint));

    const { data: blockedCreatorsRows, error: bcErr } = await supabase
      .from("blocked_creators")
      .select("wallet")
      .eq("is_active", true);
    if (bcErr) throw bcErr;
    const blockedCreators = new Set((blockedCreatorsRows ?? []).map((r: { wallet: string }) => r.wallet));

    // Latest trending snapshot
    const { data: snap, error: snapErr } = await supabase
      .from("trending_snapshots")
      .select("id, window_seconds, window_end")
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapErr) throw snapErr;

    let trending: any[] = [];
    if (snap?.id) {
      const { data: items, error: itemsErr } = await supabase
        .from("trending_items")
        .select("rank, mint, swap_count, fdv_usd, signal_touch_count, signal_points")
        .eq("snapshot_id", snap.id)
        .order("rank", { ascending: true });
      if (itemsErr) throw itemsErr;
      trending = items ?? [];
    }

    // Watchlist today
    const { data: watchlist, error: wlErr } = await supabase
      .from("watchlist_daily")
      .select("mint, gm_count, fdv_usd")
      .eq("day", today)
      .order("gm_count", { ascending: false })
      .limit(50);
    if (wlErr) throw wlErr;

    // Collect mints from trending and watchlist
    const mintsToLookup = new Set<string>();
    for (const t of trending) mintsToLookup.add(t.mint);
    for (const w of watchlist ?? []) mintsToLookup.add(w.mint);

    // Fetch creator_wallet from token_cache for those mints
    const mintToCreator = new Map<string, string | null>();
    if (mintsToLookup.size > 0) {
      const { data: cacheRows, error: cacheErr } = await supabase
        .from("token_cache")
        .select("mint, creator_wallet")
        .in("mint", [...mintsToLookup]);
      if (cacheErr) throw cacheErr;
      for (const row of cacheRows ?? []) {
        mintToCreator.set(row.mint, row.creator_wallet ?? null);
      }
    }

    const isBlocked = (mint: string) =>
      blockedMints.has(mint) || blockedCreators.has(mintToCreator.get(mint) ?? "");

    const filteredTrending = trending.filter((t: { mint: string }) => !isBlocked(t.mint));
    const filteredWatchlist = (watchlist ?? []).filter((w: { mint: string }) => !isBlocked(w.mint));

    return new Response(
      JSON.stringify({
        ok: true,
        day: today,
        snapshot: snap ?? null,
        trending: filteredTrending,
        watchlist: filteredWatchlist,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const body: Record<string, unknown> = {
      ok: false,
      message: (err as Error)?.message ?? String(err),
      name: (err as Error)?.name,
    };
    if (Deno.env.get("ENV") === "local") {
      body.stack = (err as Error)?.stack;
    }
    return new Response(JSON.stringify(body), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
