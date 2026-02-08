import { createClient } from "npm:@supabase/supabase-js@2";
import md5 from "npm:blueimp-md5@2";
import { hashSessionToken, hashSessionTokenSha256, hashToken } from "./lib/crypto.ts";
import { requireSession, type Session } from "./lib/session.ts";
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

function normalizePath(req: Request): string {
  const pathname = new URL(req.url).pathname;
  const idx = pathname.indexOf("/v1");
  return idx >= 0 ? pathname.slice(idx) : pathname;
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

/** Generate a raw API key: prefix gm3_key_ + 32 bytes randomness as URL-safe base64 (no padding). */
function generateRawApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const base64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `gm3_key_${base64url}`;
}

/** Cached: does public.api_keys have a NOT NULL "prefix" column? (legacy PROD schema). Set once per edge instance. */
let apiKeysHasPrefixColumn: boolean | null = null;

/** Detect whether api_keys has a "prefix" column via catalog; cache result. Returns null if catalog not queryable (e.g. PostgREST). */
async function apiKeysTableHasPrefixColumn(
  svc: ReturnType<typeof createClient>
): Promise<boolean | null> {
  if (apiKeysHasPrefixColumn !== null) return apiKeysHasPrefixColumn;
  const { data, error } = await svc
    .schema("information_schema")
    .from("columns")
    .select("column_name")
    .eq("table_schema", "public")
    .eq("table_name", "api_keys")
    .eq("column_name", "prefix")
    .maybeSingle();
  if (!error && data) {
    apiKeysHasPrefixColumn = true;
    return true;
  }
  if (!error && !data) {
    apiKeysHasPrefixColumn = false;
    return false;
  }
  return null;
}

/** Client IP: x-forwarded-for (first) -> x-real-ip -> cf-connecting-ip -> null */
function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip")?.trim();
  if (xri) return xri;
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return null;
}

export type AuthResult =
  | { ok: true; session: Session }
  | { ok: true; authType: "api_key"; access_session_id: string; session: Session }
  | { ok: false; status: 401; body: { ok: false; error: string } };

/** Validates Authorization: Bearer gm3_key_* against api_keys + access_sessions. Updates last_used_at, last_used_ip. */
async function requireApiKey(
  req: Request,
  svc: ReturnType<typeof createClient>
): Promise<AuthResult> {
  const auth = (req.headers.get("Authorization") ?? "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
  }
  const rawKey = auth.slice(7).trim();
  if (!rawKey.startsWith("gm3_key_")) {
    return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
  }

  const key_hash = hashToken(rawKey);
  const { data: keyRow, error: keyErr } = await svc
    .from("api_keys")
    .select("access_session_id")
    .eq("key_hash", key_hash)
    .eq("is_active", true)
    .maybeSingle();

  if (keyErr) return { ok: false, status: 401, body: { ok: false, error: "invalid_api_key" } };
  if (!keyRow) return { ok: false, status: 401, body: { ok: false, error: "invalid_api_key" } };

  const access_session_id = (keyRow as { access_session_id: string }).access_session_id;
  const nowIso = new Date().toISOString();
  const { data: sessionRow, error: sessionErr } = await svc
    .from("access_sessions")
    .select("id, expires_at, tier")
    .eq("id", access_session_id)
    .eq("revoked", false)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (sessionErr) return { ok: false, status: 401, body: { ok: false, error: "invalid_api_key" } };
  if (!sessionRow) return { ok: false, status: 401, body: { ok: false, error: "invalid_api_key" } };

  const session: Session = {
    id: (sessionRow as { id: string }).id,
    expires_at: (sessionRow as { expires_at: string }).expires_at,
    tier: (sessionRow as { tier: string | null }).tier ?? null,
  };

  const clientIp = getClientIp(req);
  const updatePayload: { last_used_at: string; last_used_ip?: string } = { last_used_at: nowIso };
  if (clientIp != null && clientIp.length > 0) updatePayload.last_used_ip = clientIp;
  await svc.from("api_keys").update(updatePayload).eq("key_hash", key_hash);

  return { ok: true, authType: "api_key", access_session_id, session };
}

/** Session or API key: Bearer gm3_sess_* -> requireSession; Bearer gm3_key_* -> requireApiKey; else 401. */
async function requireAuth(
  req: Request,
  svc: ReturnType<typeof createClient>
): Promise<AuthResult> {
  const auth = (req.headers.get("Authorization") ?? "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
  }
  const token = auth.slice(7).trim();
  if (token.startsWith("gm3_sess_")) {
    const result = await requireSession(req, svc);
    if (!result.ok) return result;
    return { ok: true, session: result.session };
  }
  if (token.startsWith("gm3_key_")) {
    return requireApiKey(req, svc);
  }
  return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
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

  const path = normalizePath(req);

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

  // -------- API keys (session-gated only; reject gm3_key_* callers) --------
  // POST /v1/api-keys — create key; body: { label?: string }; returns raw key once.
  if (req.method === "POST" && path === "/v1/api-keys") {
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);
    const body = await parseJsonBody(req);
    const rawLabel = body && isString(body.label) ? body.label.trim() : null;
    const label = rawLabel && rawLabel.length > 0
      ? rawLabel.slice(0, 64)
      : null;
    const access_session_id = check.session.id;
    let needsPrefix: boolean | null = await apiKeysTableHasPrefixColumn(svc);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rawKey = generateRawApiKey();
      const key_hash = hashToken(rawKey);
      const insertPayload: Record<string, unknown> = {
        access_session_id,
        key_hash,
        label,
        is_active: true,
      };
      if (needsPrefix === true) insertPayload.prefix = "gm3_key";
      const { data: row, error } = await svc
        .from("api_keys")
        .insert(insertPayload)
        .select("id, created_at")
        .single();
      if (!error) {
        if (needsPrefix === null) apiKeysHasPrefixColumn = false;
        const r = row as { id: string; created_at: string };
        return json({
          api_key: rawKey,
          id: r.id,
          label,
          created_at: r.created_at,
        });
      }
      if ((error as { code?: string }).code === "23505") {
        lastError = error;
        continue;
      }
      if ((error as { code?: string; message?: string }).code === "23502") {
        const msg = String((error as { message?: string }).message ?? "");
        if (msg.includes("prefix")) {
          apiKeysHasPrefixColumn = true;
          needsPrefix = true;
          continue;
        }
      }
      return json({ error: "db_error", details: (error as Error).message }, 500);
    }
    return json({ error: "db_error", details: "key_hash collision after retries" }, 500);
  }

  // GET /v1/api-keys — list keys for current session (metadata only; no raw key, no key_hash).
  if (req.method === "GET" && path === "/v1/api-keys") {
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);
    const { data: rows, error } = await svc
      .from("api_keys")
      .select("id, label, is_active, created_at, revoked_at, last_used_at, last_used_ip")
      .eq("access_session_id", check.session.id)
      .order("created_at", { ascending: false });
    if (error) return json({ error: "db_error", details: (error as Error).message }, 500);
    return json({ keys: rows ?? [] });
  }

  // POST /v1/api-keys/:id/revoke — revoke key; must belong to current session.
  const revokeMatch = path.match(/^\/v1\/api-keys\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const keyId = revokeMatch[1];
    const svc = getServiceClient();
    if (!svc) return json({ error: "missing_server_secrets" }, 500);
    const check = await requireSession(req, svc);
    if (!check.ok) return json(check.body, check.status);
    const nowIso = new Date().toISOString();
    const { data: keyRow, error: fetchErr } = await svc
      .from("api_keys")
      .select("id")
      .eq("id", keyId)
      .eq("access_session_id", check.session.id)
      .maybeSingle();
    if (fetchErr) return json({ error: "db_error" }, 500);
    if (!keyRow) return json({ error: "not_found" }, 404);
    const { error: updateErr } = await svc
      .from("api_keys")
      .update({ is_active: false, revoked_at: nowIso })
      .eq("id", keyId)
      .eq("access_session_id", check.session.id);
    if (updateErr) return json({ error: "revoke_failed" }, 500);
    return json({ ok: true });
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
    const check = await requireAuth(req, svc);
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
