import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import md5 from "https://esm.sh/blueimp-md5@2.19.0";
import { hashSessionToken } from "./lib/crypto.ts";
import { requireSession } from "./lib/session.ts";
import { verifyStripeWebhook } from "./lib/stripe_webhook.ts";

export const config = { verify_jwt: false };

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

function isString(v: unknown): v is string {
  return typeof v === "string";
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

function getServiceClient(): ReturnType<typeof createClient> | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

  const path = getRestPath(req);

  if (req.method === "GET" && path === "/v1/_debug/path") {
    return json({
      url: req.url,
      method: req.method,
      path,
    });
  }

  // GET /v1/meta: no auth, no secrets; handle before any other checks
  if (req.method === "GET" && path === "/v1/meta") {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? null;
    let projectRef: string | null = null;
    if (supabaseUrl) {
      try {
        const u = new URL(supabaseUrl);
        const host = u.hostname ?? "";
        if (host.endsWith(".supabase.co")) projectRef = host.slice(0, -".supabase.co".length) || null;
      } catch {
        // ignore
      }
    }
    const birdeyeDisabledRaw = (Deno.env.get("BIRDEYE_DISABLED") ?? "").trim().toLowerCase();
    const birdeyeDisabled = ["true", "1", "yes"].includes(birdeyeDisabledRaw);
    return json({
      supabase_url: supabaseUrl,
      project_ref: projectRef,
      birdeye_disabled: birdeyeDisabled,
      timestamp: new Date().toISOString(),
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "missing_server_secrets" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  if (req.method === "GET" && path === "/v1/_debug/routes") {
    return json({
      ok: true,
      hasAuthMe: true,
    });
  }

  // POST /v1/webhooks/stripe — expects Stripe-Signature; raw body used for verification.
  if (req.method === "POST" && path === "/v1/webhooks/stripe") {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("Stripe-Signature") ?? "";
    const secret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();
    if (!signatureHeader || !secret) {
      return json({ ok: false, error: "invalid_signature" }, 400);
    }
    const valid = await verifyStripeWebhook(rawBody, signatureHeader, secret);
    if (!valid) {
      return json({ ok: false, error: "invalid_signature" }, 400);
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "invalid_signature" }, 400);
    }
    if (event.type !== "checkout.session.completed") {
      return json({ ok: true });
    }
    const session = (event.data as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
    if (!session || typeof session.id !== "string") {
      return json({ ok: true });
    }
    const customerDetails = session.customer_details as Record<string, unknown> | undefined;
    const metadata = (session.metadata as Record<string, unknown>) ?? {};
    const external_id = session.id;
    const email = (customerDetails?.email ?? session.customer_email ?? null) as string | null;
    const amount_total = (session.amount_total as number | null | undefined) ?? null;
    const currency = (session.currency as string | null | undefined) ?? null;
    const tierVal = metadata?.tier ?? metadata?.tier_name ?? null;
    const tierStr = tierVal != null ? String(tierVal) : null;
    const svc = getServiceClient();
    if (!svc) return json({ ok: false, error: "db_error" }, 500);
    const { error } = await svc.from("access_events").upsert(
      {
        source: "stripe",
        external_id,
        status: "confirmed",
        tier: tierStr,
        email,
        amount: amount_total,
        currency,
        metadata,
      },
      { onConflict: "source,external_id" }
    );
    if (error) return json({ ok: false, error: "db_error" }, 500);
    return json({ ok: true });
  }

  // GET /v1/auth/me: Bearer gm3_sess_* required; validates against access_sessions (revoked, expires_at).
  // curl -sS "https://api.gm3.fun/functions/v1/gm3-api/v1/auth/me" -H "Authorization: Bearer gm3_sess_XXXX" | jq
  if (req.method === "GET" && path === "/v1/auth/me") {
    console.log("HIT /v1/auth/me");
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);
    const { session } = check;
    return json({
      ok: true,
      is_paid: true,
      plan: session.tier ?? null,
      expires_at: session.expires_at,
      session_id: session.id,
    });
  }

  // POST /v1/auth/mint/stripe — exchange confirmed Stripe session for gm3_sess_ token.
  // curl -i -sS "https://api.gm3.fun/functions/v1/gm3-api/v1/auth/mint/stripe" -H "Content-Type: application/json" -d '{"session_id":"cs_test_123"}'
  if (req.method === "POST" && path === "/v1/auth/mint/stripe") {
    const body = await parseJsonBody(req);
    if (!body || !isString(body.session_id)) {
      return json({ ok: false, error: "invalid_body" }, 422);
    }
    const session_id = body.session_id;
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);

    // Idempotency: if a session was already minted for this Stripe checkout, do not mint again.
    const { data: existingSession } = await svc
      .from("access_sessions")
      .select("id")
      .eq("method", `stripe:${session_id}`)
      .eq("revoked", false)
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (existingSession) {
      return json({ ok: false, error: "already_minted" }, 409);
    }

    const { data: event, error: queryError } = await svc
      .from("access_events")
      .select("tier, email, amount, currency, metadata")
      .eq("source", "stripe")
      .eq("external_id", session_id)
      .eq("status", "confirmed")
      .maybeSingle();
    if (queryError) return json({ ok: false, error: "db_error" }, 500);
    if (!event) return json({ ok: false, error: "payment_not_confirmed" }, 402);
    const tier = (event.tier as string | null) ?? "alertworthy";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = `gm3_sess_${hex}`;
    const token_hash = hashSessionToken(token);
    const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: insertError } = await svc.from("access_sessions").insert({
      session_token_hash: token_hash,
      tier,
      method: `stripe:${session_id}`,
      expires_at,
      revoked: false,
    });
    if (insertError) return json({ ok: false, error: "db_error" }, 500);
    return json({ ok: true, token, tier, expires_at });
  }

  // POST /v1/auth/mint/solana — scaffolding; payment verification not implemented
  if (req.method === "POST" && path === "/v1/auth/mint/solana") {
    const body = await parseJsonBody(req);
    if (!body || !isString(body.signature)) {
      return json({ ok: false, error: "invalid_body" }, 422);
    }
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  // POST /v1/auth/mint/token-gate — scaffolding; payment verification not implemented
  if (req.method === "POST" && path === "/v1/auth/mint/token-gate") {
    const body = await parseJsonBody(req);
    if (!body || !isString(body.wallet) || !isString(body.message) || !isString(body.signature)) {
      return json({ ok: false, error: "invalid_body" }, 422);
    }
    return json({ ok: false, error: "not_implemented" }, 501);
  }

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

  // -------- PAID (requires GM3 session only; DB reads use service role) --------
  if (path.startsWith("/v1/paid/")) {
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);

    if (req.method === "GET" && path === "/v1/paid/qualified") {
      const { data, error } = await svc.from("v_layer_qualified_60").select("*");
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      return json({ data });
    }

    if (req.method === "GET" && path === "/v1/paid/alertworthy") {
      const { data, error } = await svc
        .from("v_paid_alertworthy_60")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(25);
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      const rows = data ?? [];
      console.log("[paid-alertworthy] rows", rows.length);
      const max_updated_at =
        (data && data.length)
          ? data.reduce((max, r) => (!max || (r as { updated_at?: string }).updated_at > max ? (r as { updated_at?: string }).updated_at : max), null as string | null)
          : null;
      return json({
        data: rows,
        server_time: new Date().toISOString(),
        max_updated_at,
      });
    }

    if (req.method === "GET" && path === "/v1/paid/investable") {
      const { data, error } = await svc
        .from("v_paid_investable_60")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(25);
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      const rows = data ?? [];
      console.log("[paid-investable] rows", rows.length);
      const max_updated_at =
        (data && data.length)
          ? data.reduce((max, r) => (!max || (r as { updated_at?: string }).updated_at > max ? (r as { updated_at?: string }).updated_at : max), null as string | null)
          : null;
      return json({
        data: rows,
        server_time: new Date().toISOString(),
        max_updated_at,
      });
    }

    if (req.method === "GET" && path === "/v1/paid/outcomes") {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);

      const { data, error } = await svc
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
