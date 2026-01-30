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
        .select("rank, mint, swap_count, fdv_usd")
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

    // Launches today (view)
    const { data: launches, error: lErr } = await supabase
      .from("launches_today")
      .select("*")
      .eq("day", today)
      .order("slot", { ascending: true });
    if (lErr) throw lErr;

    return new Response(
      JSON.stringify({
        ok: true,
        day: today,
        snapshot: snap ?? null,
        trending,
        watchlist: watchlist ?? [],
        launches: launches ?? [],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
