import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/blueimp-md5@2.19.0";

// ---------- helpers ----------
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-api-key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

async function md5Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("MD5", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Supabase functions path format: /functions/v1/<fn>/<rest>
// We want <rest> (e.g. /v1/free/qualified)
function getRestPath(req: Request): string {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p === "gm3-api");
  if (idx === -1) return "/";
  return "/" + parts.slice(idx + 1).join("/");
}

async function requireApiKey(
  supabase: any,
  req: Request
): Promise<{ tier: string; prefix: string } | Response> {
  const key = (req.headers.get("x-api-key") ?? "").trim();
  if (!key) return json({ error: "missing_api_key" }, 401);

  const keyHash = md5(key);

  const { data, error } = await supabase
    .from("api_keys")
    .select("tier, prefix, revoked_at, expires_at")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (error) return json({ error: "key_lookup_failed", details: error.message }, 500);
  if (!data) return json({ error: "invalid_api_key" }, 401);
  if (data.revoked_at) return json({ error: "revoked_api_key" }, 401);

  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return json({ error: "expired_api_key" }, 401);
  }

  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash);

  return { tier: data.tier ?? "paid", prefix: data.prefix ?? "" };
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "missing_server_secrets" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const path = getRestPath(req);

  // -------- FREE (no API key) --------
  if (req.method === "GET" && path === "/v1/free/qualified") {
    const { data, error } = await supabase.rpc("free_qualified_feed");
    if (error) return json({ error: "rpc_failed", details: error.message }, 500);
    return json({ data });
  }

  if (req.method === "GET" && path === "/v1/free/qualified/meta") {
    const { data, error } = await supabase.rpc("free_qualified_feed_meta");
    if (error) return json({ error: "rpc_failed", details: error.message }, 500);
    return json({ data: data?.[0] ?? null });
  }

  // -------- PAID (requires API key) --------
  if (path.startsWith("/v1/paid/")) {
    const auth = await requireApiKey(supabase, req);
    if (auth instanceof Response) return auth;

    if (req.method === "GET" && path === "/v1/paid/qualified") {
      const { data, error } = await supabase.from("v_layer_qualified_60").select("*");
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      return json({ data });
    }

    if (req.method === "GET" && path === "/v1/paid/alertworthy") {
      const { data, error } = await supabase.from("v_layer_alertworthy_60").select("*");
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      return json({ data });
    }

    if (req.method === "GET" && path === "/v1/paid/investable") {
      const { data, error } = await supabase.from("v_layer_investable_60").select("*");
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      return json({ data });
    }

    if (req.method === "GET" && path === "/v1/paid/outcomes") {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);

      const { data, error } = await supabase
        .from("v_mint_alert_outcomes")
        .select("*")
        .order("first_alert_ts", { ascending: false })
        .limit(limit);

      if (error) return json({ error: "query_failed", details: error.message }, 500);
      return json({ data });
    }

    return json({ error: "not_found" }, 404);
  }

  return json({ error: "not_found" }, 404);
});
