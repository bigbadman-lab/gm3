// supabase/functions/ath-updater/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Fetch FDV USD from Birdeye token_overview. Returns { ok, fdv } or { ok: false, status, bodySnippet, pathQuery }. */
async function fetchBirdeyeFdv(
  mint: string,
  apiKey: string
): Promise<
  | { ok: true; fdv: number }
  | { ok: false; status: number; bodySnippet: string; pathQuery: string }
> {
  const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`;
  const pathQuery = new URL(url).pathname + new URL(url).search;
  try {
    const res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, "accept": "application/json", "x-chain": "solana" },
    });
    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, bodySnippet: bodyText.slice(0, 300), pathQuery };
    }
    try {
      const body = JSON.parse(bodyText) as { success?: boolean; data?: { fdv?: number } };
      if (body?.success !== true || body?.data == null) {
        return { ok: false, status: res.status, bodySnippet: bodyText.slice(0, 300), pathQuery };
      }
      const fdv = body.data.fdv;
      if (typeof fdv !== "number" || !Number.isFinite(fdv)) {
        return { ok: false, status: res.status, bodySnippet: bodyText.slice(0, 300), pathQuery };
      }
      return { ok: true, fdv };
    } catch {
      return { ok: false, status: res.status, bodySnippet: bodyText.slice(0, 300), pathQuery };
    }
  } catch (e) {
    return { ok: false, status: 0, bodySnippet: String(e).slice(0, 300), pathQuery };
  }
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Token read only from env. Local dev: shell `export` does not reach the function process;
  // Supabase CLI starts a separate Deno process and only injects env from --env-file or
  // (when deployed) from `supabase secrets set`. Use e.g. `supabase functions serve --env-file .env`.
  const expected = Deno.env.get("ATH_UPDATER_TOKEN") ?? "";
  const auth = (req.headers.get("authorization") ?? "").trim();
  const xcron = (req.headers.get("x-cron-token") ?? "").trim();
  const bearer =
    auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || xcron;

  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const birdeyeKey = Deno.env.get("BIRDEYE_API_KEY");

  if (!supabaseUrl || !serviceKey) {
    return json(500, { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
  }
  if (!birdeyeKey) {
    return json(500, { ok: false, error: "Missing BIRDEYE_API_KEY" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let archived = 0;
  const errors: string[] = [];

  const { data: dueRows, error: dueErr } = await supabase.rpc("get_due_ath_mints", { lim: 1 });

  if (dueErr) {
    return json(500, { ok: false, error: dueErr.message });
  }

  const due = (dueRows ?? []) as { mint: string; entry_ts: string }[];
  processed = due.length;

  for (const row of due) {
    const birdeyeResult = await fetchBirdeyeFdv(row.mint, birdeyeKey);
    if (!birdeyeResult.ok) {
      skipped += 1;
      errors.push(
        `${row.mint}: Birdeye failed status=${birdeyeResult.status} path=${birdeyeResult.pathQuery} body="${birdeyeResult.bodySnippet}"`
      );
      continue;
    }
    const fdvUsd = birdeyeResult.fdv;
    const { data: rowsUpdated, error: updateErr } = await supabase.rpc("update_ath_for_mint", {
      p_mint: row.mint,
      p_current_fdv_usd: fdvUsd,
    });
    if (updateErr) {
      skipped += 1;
      errors.push(`${row.mint}: ${updateErr.message}`);
      continue;
    }
    if (rowsUpdated === 1) {
      updated += 1;
    } else {
      skipped += 1;
      errors.push(`${row.mint}: update row_count=${rowsUpdated}`);
    }
  }

  return json(200, {
    ok: true,
    processed,
    updated,
    skipped,
    archived,
    errors,
  });
});
