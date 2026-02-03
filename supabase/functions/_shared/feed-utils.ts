/** Returns the max updated_at (ISO string) in rows, or null if none. */
export function computeMaxUpdatedAt(
  rows: { updated_at?: string }[]
): string | null {
  if (rows.length === 0) return null;
  return rows.reduce((max, r) => {
    const t = r.updated_at;
    if (!t) return max;
    return max == null || t > max ? t : max;
  }, null as string | null);
}
