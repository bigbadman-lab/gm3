import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hashSessionToken } from "./crypto.ts";

export type Session = { id: string; expires_at: string; tier: string | null };

export type RequireSessionResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401; body: { ok: false; error: string } };

/** Validates Authorization: Bearer gm3_sess_* against access_sessions. Does not throw. */
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

  const hash = hashSessionToken(token);
  const { data, error } = await svc
    .from("access_sessions")
    .select("id, expires_at, revoked, tier")
    .eq("session_token_hash", hash)
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
