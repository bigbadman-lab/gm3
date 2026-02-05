import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashSessionToken, hashSessionTokenSha256 } from "./crypto.ts";

export type Session = { id: string; expires_at: string; tier: string | null };

export type RequireSessionResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401; body: { ok: false; error: string } };

/** Validates Authorization: Bearer gm3_sess_* against access_sessions. Does not throw. */
/** Backward compat: session_token_hash may be MD5 (32 hex) or SHA-256 (64 hex); we match both. */
export async function requireSession(
  req: Request,
  svc: SupabaseClient
): Promise<RequireSessionResult> {
  const auth = (req.headers.get("Authorization") ?? "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
  }
  const token = auth.slice(7).trim();
  if (!token.startsWith("gm3_sess_")) {
    return { ok: false, status: 401, body: { ok: false, error: "missing_or_invalid_token" } };
  }

  const md5Hash = hashSessionToken(token);
  const sha256Hex = await hashSessionTokenSha256(token);
  const { data, error } = await svc
    .from("access_sessions")
    .select("id, expires_at, revoked, tier")
    .in("session_token_hash", [md5Hash, sha256Hex])
    .maybeSingle();

  if (error) {
    return { ok: false, status: 401, body: { ok: false, error: "invalid_session" } };
  }
  if (!data || data.revoked || (data.expires_at && new Date(data.expires_at).getTime() <= Date.now())) {
    return { ok: false, status: 401, body: { ok: false, error: "invalid_session" } };
  }

  return {
    ok: true,
    session: { id: data.id, expires_at: data.expires_at, tier: data.tier ?? null },
  };
}
