// supabase/functions/investable-fdv-sampler/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type TaskRow = {
  mint: string;
  enter_event_time: string; // timestamptz
  checkpoint: "15m" | "30m" | "2h" | "12h" | string;
  run_at: string;
};

type PriceResult = {
  mint: string;
  price_usd: number | null;
};

const SUPPLY = 1_000_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// --- Birdeye client (minimal) ---
// NOTE: You likely already know which Birdeye endpoint you use elsewhere.
// This implementation uses a placeholder fetch function you can adapt to your existing endpoint.
async function fetchPricesBirdeye(mints: string[]): Promise<Map<string, number | null>> {
  const apiKey = env("BIRDEYE_API_KEY");

  // If you have a batch endpoint, use it here.
  // Otherwise, you can still do limited parallel calls with a cap.
  // -----
  // PLACEHOLDER strategy: call a "single price" endpoint per mint (capped).
  // Replace URL + parsing with your known working Birdeye call.
  // -----
  const out = new Map<string, number | null>();
  const concurrency = 8;

  let i = 0;
  async function worker() {
    while (i < mints.length) {
      const mint = mints[i++];
      try {
        // TODO: Replace with your actual Birdeye price endpoint for Solana tokens.
        const url = `https://public-api.birdeye.so/defi/price?address=${encodeURIComponent(mint)}`;
        const res = await fetch(url, {
          headers: {
            "X-API-KEY": apiKey,
            "accept": "application/json",
          },
        });
        if (!res.ok) {
          out.set(mint, null);
          continue;
        }
        const data = await res.json();

        // TODO: Adjust parsing to match the endpoint you use.
        // Common pattern: data.data.value (but verify).
        const price = Number(data?.data?.value);
        out.set(mint, Number.isFinite(price) ? price : null);
      } catch {
        out.set(mint, null);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, mints.length) }, worker));
  return out;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const { limit } = await req.json().catch(() => ({ limit: 25 }));
    const batchLimit = Math.max(1, Math.min(100, Number(limit) || 25));

    const supabaseUrl = env("SUPABASE_URL");
    // Use service role so the function can read/write internal tables.
    const serviceRoleKey = env("SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1) Pull due tasks
    const { data: tasks, error: taskErr } = await supabase
      .from("investable_fdv_tasks_60")
      .select("mint, enter_event_time, checkpoint, run_at")
      .eq("status", "pending")
      .lte("run_at", new Date().toISOString())
      .order("run_at", { ascending: true })
      .limit(batchLimit);

    if (taskErr) throw taskErr;

    const taskRows: TaskRow[] = tasks ?? [];
    if (taskRows.length === 0) {
      return json({ ok: true, processed: 0, message: "No due tasks" });
    }

    // 2) Dedupe mints, fetch prices
    const uniqueMints = Array.from(new Set(taskRows.map((t) => t.mint)));
    const priceMap = await fetchPricesBirdeye(uniqueMints);

    // 3) Write observations + update ATH table + mark tasks
    // We'll do this per task row; volume is low (<= 100/min).
    let writtenObs = 0;
    let markedDone = 0;
    let markedError = 0;

    for (const t of taskRows) {
      const price = priceMap.get(t.mint) ?? null;
      const fdv = price == null ? null : price * SUPPLY;

      // Insert observation (idempotent)
      const { error: obsErr } = await supabase
        .from("investable_fdv_observations_60")
        .upsert(
          {
            mint: t.mint,
            enter_event_time: t.enter_event_time,
            checkpoint: t.checkpoint,
            observed_at: new Date().toISOString(),
            price_usd: price,
            fdv_usd: fdv,
            source: "birdeye",
            created_at: new Date().toISOString(),
          },
          { onConflict: "mint,enter_event_time,checkpoint" },
        );

      if (obsErr) {
        // mark task error
        await supabase
          .from("investable_fdv_tasks_60")
          .update({
            status: "error",
            attempts: supabase.rpc ? undefined : undefined, // no-op, we update attempts below separately
            last_error: String(obsErr.message ?? obsErr),
            updated_at: new Date().toISOString(),
          })
          .eq("mint", t.mint)
          .eq("enter_event_time", t.enter_event_time)
          .eq("checkpoint", t.checkpoint);

        markedError++;
        continue;
      }

      writtenObs++;

      // Recompute ATH + multiple from observations we have for this mint+enter_event_time
      const { data: obsRows, error: obsReadErr } = await supabase
        .from("investable_fdv_observations_60")
        .select("checkpoint, fdv_usd, observed_at")
        .eq("mint", t.mint)
        .eq("enter_event_time", t.enter_event_time);

      if (obsReadErr) {
        // still mark task done; we can compute ATH later
      } else {
        let ath: { fdv: number; checkpoint: string; time: string } | null = null;
        for (const r of obsRows ?? []) {
          const v = Number(r?.fdv_usd);
          if (!Number.isFinite(v)) continue;
          if (!ath || v > ath.fdv) {
            ath = { fdv: v, checkpoint: String(r.checkpoint), time: String(r.observed_at) };
          }
        }

        // Pull fdv_at_alert from token_first_alerts (preferred) or fallback from investable_events/cache later
        const { data: tfa, error: tfaErr } = await supabase
          .from("token_first_alerts")
          .select("first_alert_fdv_usd")
          .eq("mint", t.mint)
          .maybeSingle();

        const fdvAtAlert = !tfaErr && tfa?.first_alert_fdv_usd != null
          ? Number(tfa.first_alert_fdv_usd)
          : null;

        const multiple =
          ath && fdvAtAlert && Number.isFinite(fdvAtAlert) && fdvAtAlert > 0
            ? ath.fdv / fdvAtAlert
            : null;

        await supabase
          .from("investable_fdv_ath_60")
          .upsert(
            {
              mint: t.mint,
              enter_event_time: t.enter_event_time,
              fdv_at_alert_usd: fdvAtAlert,
              fdv_ath_usd: ath?.fdv ?? null,
              fdv_ath_checkpoint: ath?.checkpoint ?? null,
              fdv_ath_time: ath?.time ?? null,
              ath_multiple: multiple,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "mint,enter_event_time" },
          );
      }

      // Mark task done
      const { error: doneErr } = await supabase
        .from("investable_fdv_tasks_60")
        .update({
          status: "done",
          updated_at: new Date().toISOString(),
        })
        .eq("mint", t.mint)
        .eq("enter_event_time", t.enter_event_time)
        .eq("checkpoint", t.checkpoint)
        .eq("status", "pending");

      if (doneErr) {
        markedError++;
      } else {
        markedDone++;
      }
    }

    return json({
      ok: true,
      due: taskRows.length,
      uniqueMints: uniqueMints.length,
      observationsUpserted: writtenObs,
      tasksDone: markedDone,
      tasksError: markedError,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
