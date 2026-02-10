/**
 * Birdeye API provider for token overview.
 * Uses BIRDEYE_API_KEY (same as ingest-trending, ath-updater, etc.).
 */

const BIRDEYE_TOKEN_OVERVIEW_URL = "https://public-api.birdeye.so/defi/token_overview";
const FETCH_TIMEOUT_MS = 10_000;

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = typeof v === "string" ? v.trim() : String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Fetch token overview from Birdeye. Returns nulls for missing/invalid data; does not throw.
 * Do not log the API key or full response bodies.
 */
export async function getBirdeyeTokenOverview(mint: string): Promise<{
  price_usd: number | null;
  fdv_usd: number | null;
  liquidity_usd: number | null;
  marketcap_usd: number | null;
  symbol: string | null;
  name: string | null;
}> {
  const apiKey = Deno.env.get("BIRDEYE_API_KEY") ?? "";
  if (!apiKey) {
    return {
      price_usd: null,
      fdv_usd: null,
      liquidity_usd: null,
      marketcap_usd: null,
      symbol: null,
      name: null,
    };
  }

  const url = `${BIRDEYE_TOKEN_OVERVIEW_URL}?address=${encodeURIComponent(mint)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
        "accept": "application/json",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        price_usd: null,
        fdv_usd: null,
        liquidity_usd: null,
        marketcap_usd: null,
        symbol: null,
        name: null,
      };
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        price?: number;
        fdv?: number;
        liquidity?: number;
        mc?: number;
        market_cap?: number;
        symbol?: string;
        name?: string;
      };
    };

    if (body?.success !== true || body?.data == null) {
      return {
        price_usd: null,
        fdv_usd: null,
        liquidity_usd: null,
        marketcap_usd: null,
        symbol: null,
        name: null,
      };
    }

    const d = body.data;
    const marketcap = toNum(d.mc ?? d.market_cap);

    return {
      price_usd: toNum(d.price),
      fdv_usd: toNum(d.fdv),
      liquidity_usd: toNum(d.liquidity),
      marketcap_usd: marketcap,
      symbol: toStr(d.symbol),
      name: toStr(d.name),
    };
  } catch {
    clearTimeout(timeoutId);
    return {
      price_usd: null,
      fdv_usd: null,
      liquidity_usd: null,
      marketcap_usd: null,
      symbol: null,
      name: null,
    };
  }
}

// --- Example usage (commented; do not run at import time) ---
// const overview = await getBirdeyeTokenOverview("So11111111111111111111111111111111111111112");
// if (overview.fdv_usd != null) console.log("FDV:", overview.fdv_usd);
