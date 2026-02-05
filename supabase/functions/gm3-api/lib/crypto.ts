import md5 from "https://esm.sh/blueimp-md5@2.19.0";

/** MD5 (32-char hex). Legacy: access_sessions may contain this format; lookup supports both MD5 and SHA-256. */
export function hashSessionToken(token: string): string {
  return md5(token);
}

/** SHA-256 hex (64 chars). New sessions store this; lookup supports both for backward compatibility. */
export async function hashSessionTokenSha256(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
