/**
 * Stripe webhook signature verification (HMAC SHA256).
 * Signed payload: `${t}.${rawBody}`. Header: Stripe-Signature: t=timestamp,v1=hexsignature
 */

export function parseStripeSignature(header: string): { t: string; v1: string } | null {
  const parts = header.split(",").map((p) => p.trim());
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === "t") t = val;
    if (key === "v1") v1 = val;
  }
  if (!t || !v1) return null;
  return { t, v1 };
}

function arrayBufferToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

/** Verify Stripe-Signature using STRIPE_WEBHOOK_SECRET. Uses raw body (do not parse before). */
export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed || !secret) return false;

  const payload = `${parsed.t}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const expectedHex = arrayBufferToHex(sig);
  const expectedBytes = hexToBytes(expectedHex);
  const actualBytes = hexToBytes(parsed.v1);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
