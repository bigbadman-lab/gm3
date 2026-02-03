import md5 from "https://esm.sh/blueimp-md5@2.19.0";

/** Hash session token for lookup in access_sessions (same as used when storing). */
export function hashSessionToken(token: string): string {
  return md5(token);
}
