import { createClient } from "npm:@supabase/supabase-js@2";
import md5 from "npm:blueimp-md5@2";
import { hashSessionToken, hashSessionTokenSha256 } from "./lib/crypto.ts";
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

  // POST /v1/auth/revoke — invalidate current session server-side (e.g. "Remove access"). Uses requireSession (matches both MD5 and SHA-256 hashes); updates by session.id; returns 200 { ok: true, revoked: true }.
  if (req.method === "POST" && path === "/v1/auth/revoke") {
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);
    const { error: revokeErr } = await svc
      .from("access_sessions")
      .update({ revoked: true })
      .eq("id", check.session.id);
    if (revokeErr) return json({ ok: false, error: "revoke_failed" }, 500);
    return json({ ok: true, revoked: true }, 200);
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
    const token_hash = await hashSessionTokenSha256(token);
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

  // POST /v1/auth/mint/promo — redeem promo code for gm3_sess_* token (public, no auth)
  if (req.method === "POST" && path === "/v1/auth/mint/promo") {
    const body = await parseJsonBody(req);
    const rawCode = body && typeof body.code === "string" ? body.code : "";
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      return json({ error: "Promo code is required" }, 400);
    }
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);

    const { data: promoRow, error: lookupErr } = await svc
      .from("promo_codes")
      .select("id, tier, duration_days, used")
      .eq("code", code)
      .maybeSingle();
    if (lookupErr) return json({ error: "Failed to validate code" }, 500);
    if (!promoRow) return json({ error: "Invalid promo code" }, 400);
    if ((promoRow as { used?: boolean }).used) {
      return json({ error: "This code has already been used" }, 400);
    }

    const { error: redeemErr } = await svc
      .from("promo_codes")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("code", code);
    if (redeemErr) return json({ error: "Failed to redeem code" }, 500);

    const tier = (promoRow as { tier?: string }).tier ?? "investable";
    const durationDays = Math.max(1, Math.min(365, (promoRow as { duration_days?: number }).duration_days ?? 30));
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = `gm3_sess_${hex}`;
    const token_hash = await hashSessionTokenSha256(token);
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    const expires_at = expiresAt.toISOString();

    const { error: insertError } = await svc.from("access_sessions").insert({
      session_token_hash: token_hash,
      tier,
      method: "promo",
      expires_at,
      revoked: false,
    });
    if (insertError) {
      await svc.from("promo_codes").update({ used: false, used_at: null }).eq("code", code);
      return json({ error: "Failed to create access session" }, 500);
    }
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

  // POST /v1/device-pair/start — start QR pairing; requires valid gm3 session
  if (req.method === "POST" && path === "/v1/device-pair/start") {
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);

    const { data: sessionRow } = await svc
      .from("access_sessions")
      .select("method")
      .eq("id", check.session.id)
      .maybeSingle();
    const method = (sessionRow as { method?: string } | null)?.method ?? "";
    const root_session_id = method.startsWith("pair:") ? method.slice(5).trim() : check.session.id;

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    const { error: cancelErr } = await svc
      .from("device_pairings")
      .update({ status: "cancelled" })
      .eq("root_session_id", root_session_id)
      .eq("status", "pending")
      .gt("expires_at", nowIso);
    if (cancelErr) return json({ ok: false, error: "pairing_error" }, 500);

    const maxRetries = 5;
    let code: string | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { error: insertErr } = await svc.from("device_pairings").insert({
        root_session_id,
        code,
        status: "pending",
        expires_at: expiresAt,
      });
      if (!insertErr) break;
      if (insertErr.code === "23505") continue; // unique_violation
      return json({ ok: false, error: "pairing_error" }, 500);
    }
    if (!code) return json({ ok: false, error: "pairing_error" }, 500);

    const PAIR_BASE_URL = Deno.env.get("PAIR_BASE_URL") ?? "https://gm3.fun";
    const pair_url = `${PAIR_BASE_URL}/pair?code=${encodeURIComponent(code)}`;

    return json({
      code,
      pair_url,
      expires_at: expiresAt,
    });
  }

  // POST /v1/device-pair/complete — complete QR pairing; no auth required (pairing code is sufficient)
  if (req.method === "POST" && path === "/v1/device-pair/complete") {
    const svc = getServiceClient();
    if (!svc) return json({ ok: false, error: "pairing_error" }, 500);

    const body = await parseJsonBody(req);
    if (!body || !isString(body.code) || !isString(body.device_id)) {
      return json({ ok: false, error: "invalid_body" }, 422);
    }
    const code = body.code.trim();
    const device_id = body.device_id.trim();
    const device_label = isString(body.device_label) ? body.device_label.trim() : null;
    const user_agent = isString(body.user_agent) ? body.user_agent.trim() : (req.headers.get("user-agent") ?? null);
    const consumed_ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0]?.trim() || null;

    const { data: pairing, error: pairErr } = await svc
      .from("device_pairings")
      .select("id, root_session_id, status, expires_at")
      .eq("code", code)
      .maybeSingle();
    if (pairErr) return json({ ok: false, error: "pairing_error" }, 500);
    if (!pairing) return json({ ok: false, error: "pair_not_found" }, 404);

    const pairingRow = pairing as { status: string; expires_at: string; root_session_id: string };
    if (pairingRow.status !== "pending") {
      return json({ ok: false, error: "pair_not_pending" }, 409);
    }
    const nowIso = new Date().toISOString();
    if (new Date(pairingRow.expires_at).getTime() <= Date.now()) {
      await svc.from("device_pairings").update({ status: "expired" }).eq("code", code);
      return json({ ok: false, error: "pair_expired" }, 410);
    }

    const root_session_id = pairingRow.root_session_id;
    const { data: rootSession, error: rootErr } = await svc
      .from("access_sessions")
      .select("id, tier, expires_at")
      .eq("id", root_session_id)
      .eq("revoked", false)
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (rootErr) return json({ ok: false, error: "pairing_error" }, 500);
    if (!rootSession) return json({ ok: false, error: "root_invalid" }, 401);

    const rootRow = rootSession as { tier: string | null; expires_at: string };
    const tier = rootRow.tier ?? "alertworthy";
    const expires_at = rootRow.expires_at;

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = `gm3_sess_${hex}`;
    const token_hash = await hashSessionTokenSha256(token);
    const { data: insertedRows, error: insertErr } = await svc
      .from("access_sessions")
      .insert({
        session_token_hash: token_hash,
        tier,
        method: `pair:${root_session_id}`,
        expires_at,
        revoked: false,
      })
      .select("id")
      .limit(1);
    if (insertErr || !insertedRows?.length) return json({ ok: false, error: "pairing_error" }, 500);
    const newSessionId = (insertedRows[0] as { id: string }).id;

    const { error: updatePairErr } = await svc
      .from("device_pairings")
      .update({
        status: "completed",
        completed_at: nowIso,
        consumed_by_device_id: device_id,
        consumed_user_agent: user_agent,
        consumed_ip: consumed_ip,
      })
      .eq("code", code);
    if (updatePairErr) return json({ ok: false, error: "pairing_error" }, 500);

    const { error: upsertErr } = await svc.from("device_links").upsert(
      {
        root_session_id,
        linked_session_id: newSessionId,
        linked_device_id: device_id,
        linked_device_label: device_label,
        linked_user_agent: user_agent,
        linked_created_at: nowIso,
        revoked_at: null,
      },
      { onConflict: "root_session_id" }
    );
    if (upsertErr) return json({ ok: false, error: "pairing_error" }, 500);

    return json({
      ok: true,
      token,
      expires_at,
      tier,
      root_session_id,
    });
  }

  // GET /v1/device-pair/status?code=... — check pairing status; caller must own root session
  if (req.method === "GET" && path === "/v1/device-pair/status") {
    const svc = getServiceClient();
    if (!svc) return json({ ok: false, error: "pairing_error" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);

    const { data: sessionRow } = await svc
      .from("access_sessions")
      .select("method")
      .eq("id", check.session.id)
      .maybeSingle();
    const method = (sessionRow as { method?: string } | null)?.method ?? "";
    const root_session_id = method.startsWith("pair:") ? method.slice(5).trim() : check.session.id;

    const codeParam = new URL(req.url).searchParams.get("code");
    if (codeParam == null || typeof codeParam !== "string" || !codeParam.trim()) {
      return json({ ok: false, error: "invalid_code" }, 422);
    }
    const code = codeParam.trim();

    const { data: pairing, error: pairErr } = await svc
      .from("device_pairings")
      .select("root_session_id, status, expires_at")
      .eq("code", code)
      .maybeSingle();
    if (pairErr) return json({ ok: false, error: "pairing_error" }, 500);
    if (!pairing) return json({ ok: false, error: "pair_not_found" }, 404);

    const p = pairing as { root_session_id: string; status: string; expires_at: string };
    if (p.root_session_id !== root_session_id) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    return json({ ok: true, status: p.status, expires_at: p.expires_at });
  }

  // POST /v1/device-link/unlink — revoke linked device for root session
  if (req.method === "POST" && path === "/v1/device-link/unlink") {
    const svc = getServiceClient();
    if (!svc) return json({ ok: false, error: "pairing_error" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);

    const { data: sessionRow } = await svc
      .from("access_sessions")
      .select("method")
      .eq("id", check.session.id)
      .maybeSingle();
    const method = (sessionRow as { method?: string } | null)?.method ?? "";
    const root_session_id = method.startsWith("pair:") ? method.slice(5).trim() : check.session.id;

    const { data: linkRow, error: linkErr } = await svc
      .from("device_links")
      .select("linked_session_id")
      .eq("root_session_id", root_session_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (linkErr) return json({ ok: false, error: "pairing_error" }, 500);
    if (!linkRow) return json({ ok: true, unlinked: false });

    const linked_session_id = (linkRow as { linked_session_id: string }).linked_session_id;
    const nowIso = new Date().toISOString();

    const { error: updateLinkErr } = await svc
      .from("device_links")
      .update({ revoked_at: nowIso })
      .eq("root_session_id", root_session_id);
    if (updateLinkErr) return json({ ok: false, error: "pairing_error" }, 500);

    const { error: revokeErr } = await svc
      .from("access_sessions")
      .update({ revoked: true })
      .eq("id", linked_session_id);
    if (revokeErr) return json({ ok: false, error: "pairing_error" }, 500);

    return json({ ok: true, unlinked: true });
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
      const url = new URL(req.url);
      const backfillMint = url.searchParams.get("mint")?.trim() || null;

      let rows: Record<string, unknown>[] = [];
      const { data, error } = await svc
        .from("v_paid_alertworthy_60")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(25);
      if (error) return json({ error: "query_failed", details: error.message }, 500);
      rows = (data ?? []) as Record<string, unknown>[];

      if (backfillMint && !rows.some((r) => r.mint === backfillMint)) {
        const { data: snapIds } = await svc
          .from("trending_snapshots")
          .select("id")
          .eq("window_seconds", 60)
          .order("window_end", { ascending: false })
          .limit(100);
        const ids = ((snapIds ?? []) as { id: string }[]).map((s) => s.id);
        if (ids.length) {
          const { data: backfillRow } = await svc
            .from("trending_items")
            .select("*")
            .in("snapshot_id", ids)
            .eq("mint", backfillMint)
            .eq("is_alertworthy", true)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (backfillRow) {
            const ti = backfillRow as Record<string, unknown>;
            const { data: meRow } = await svc.from("mint_entries").select("first_alert_ts, entry_fdv_usd").eq("mint", backfillMint).maybeSingle();
            const { data: tfaRow } = await svc.from("token_first_alerts").select("first_alert_fdv_usd").eq("mint", backfillMint).maybeSingle();
            const me = meRow as { first_alert_ts?: string; entry_fdv_usd?: number } | null;
            const tfa = tfaRow as { first_alert_fdv_usd?: number } | null;
            const augmented: Record<string, unknown> = { ...ti, first_alert_time: me?.first_alert_ts ?? null, fdv_at_alert: me?.entry_fdv_usd ?? null, first_alert_fdv_usd: tfa?.first_alert_fdv_usd ?? null };
            rows = [augmented, ...rows].slice(0, 25);
          }
        }
      }

      const MAX_CAPITAL_EFFICIENCY = 0.32;
      rows = rows.filter((r) => {
        const ce = r.capital_efficiency as number | null | undefined;
        return ce == null || (typeof ce === "number" && !Number.isNaN(ce) && ce <= MAX_CAPITAL_EFFICIENCY);
      });

      const withRug = rows.map((r) => {
        const buy_count = (r.buy_count as number | null | undefined) ?? 0;
        const sell_count = (r.sell_count as number | null | undefined) ?? 0;
        const total_trades = buy_count + sell_count;
        const buy_ratio = r.buy_ratio as number | null | undefined;
        let rug_risk = false;
        let rug_risk_reason: string | null = null;
        if (total_trades >= 15 && buy_ratio != null && buy_ratio > 0.7) {
          rug_risk = true;
          rug_risk_reason = "High buy ratio (>0.70) after meaningful volume";
        }
        return { ...r, rug_risk, rug_risk_reason };
      });

      const max_updated_at =
        withRug.length
          ? withRug.reduce((max, r) => {
              const u = (r as Record<string, unknown>).updated_at as string | undefined;
              return !max || (u != null && u > max) ? (u ?? max) : max;
            }, null as string | null)
          : null;
      return json({
        data: withRug,
        server_time: new Date().toISOString(),
        max_updated_at,
      });
    }

    if (req.method === "GET" && path === "/v1/paid/investable") {
      const { data, error } = await svc
        .from("v_paid_investable_60_v2")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(25);

      if (error) return json({ error: "query_failed", details: error.message }, 500);

      const rows = data ?? [];
      console.log("[paid-investable] rows", rows.length);

      const max_updated_at =
        (data && data.length)
          ? data.reduce((max, r) =>
              (!max || (r as { updated_at?: string }).updated_at! > max
                ? (r as { updated_at?: string }).updated_at!
                : max),
              null as string | null
            )
          : null;

      const meta = { source: "v_paid_investable_60_v2", version: "ath-effective-1" };

      return json({
        data: rows,
        server_time: new Date().toISOString(),
        max_updated_at,
        meta,
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
