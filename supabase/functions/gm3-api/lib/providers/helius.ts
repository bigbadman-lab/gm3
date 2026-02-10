/**
 * Helius Enhanced Transactions provider for recent swaps by mint.
 * Uses HELIUS_API_KEY (same as ingest-trending).
 * Endpoint: GET https://api-mainnet.helius-rpc.com/v0/addresses/{address}/transactions
 * (We pass the token mint as address to get transactions involving that token.)
 */

const HELIUS_BASE = "https://api-mainnet.helius-rpc.com/v0/addresses";
const PAGE_LIMIT = 100;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const LAMPORTS_PER_SOL = 1e9;

type HeliusTx = {
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  tokenTransfers?: Array<{
    mint?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
};

function toUnixSeconds(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? (v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)) : null;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function getTxTimeSec(tx: HeliusTx): number | null {
  return toUnixSeconds((tx as Record<string, unknown>).timestamp)
    ?? toUnixSeconds((tx as Record<string, unknown>).blockTime)
    ?? toUnixSeconds((tx as Record<string, unknown>).time)
    ?? null;
}

function getTxSignature(tx: HeliusTx): string | null {
  const sig = (tx as Record<string, unknown>).signature ?? (tx as Record<string, unknown>).transactionSignature;
  return typeof sig === "string" && sig.length > 0 ? sig : null;
}

function getWallet(tx: HeliusTx): string | null {
  if (tx.feePayer) return tx.feePayer;
  const tt = tx.tokenTransfers ?? [];
  for (const t of tt) {
    if (t.fromUserAccount) return t.fromUserAccount;
  }
  for (const t of tt) {
    if (t.toUserAccount) return t.toUserAccount;
  }
  return null;
}

function classifySide(tx: HeliusTx, mint: string, wallet: string): "buy" | "sell" | "unknown" {
  const tt = tx.tokenTransfers ?? [];
  for (const t of tt) {
    if (t.mint !== mint) continue;
    if (t.toUserAccount === wallet) return "buy";
    if (t.fromUserAccount === wallet) return "sell";
  }
  return "unknown";
}

function getSolAmountForWallet(tx: HeliusTx, wallet: string, side: "buy" | "sell"): number | null {
  const nt = tx.nativeTransfers ?? [];
  let lamports = 0;
  for (const n of nt) {
    if (side === "buy" && n.fromUserAccount === wallet) lamports += Number(n.amount ?? 0);
    if (side === "sell" && n.toUserAccount === wallet) lamports += Number(n.amount ?? 0);
  }
  return lamports > 0 ? lamports / LAMPORTS_PER_SOL : null;
}

function txInvolvesMint(tx: HeliusTx, mint: string): boolean {
  const tt = tx.tokenTransfers ?? [];
  for (const t of tt) {
    if (t.mint === mint) return true;
  }
  const swap = (tx as Record<string, unknown>).events as { swap?: { tokenInputs?: Array<{ mint?: string }>; tokenOutputs?: Array<{ mint?: string }> } } | undefined;
  for (const s of swap?.tokenInputs ?? []) {
    if (s.mint === mint) return true;
  }
  for (const s of swap?.tokenOutputs ?? []) {
    if (s.mint === mint) return true;
  }
  return false;
}

async function fetchPage(url: string): Promise<HeliusTx[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as HeliusTx[]) : [];
  } catch {
    clearTimeout(timeoutId);
    return [];
  }
}

/**
 * Fetch recent swaps for a token mint from Helius Enhanced Transactions API.
 * Fetches enough pages to cover windowSeconds (typically 300–600), then filters to the window.
 * API errors or missing data return [].
 */
export async function getHeliusRecentSwapsForMint(
  mint: string,
  windowSeconds: number
): Promise<Array<{
  ts: number;
  signature: string;
  wallet: string | null;
  side: "buy" | "sell" | "unknown";
  sol_amount: number | null;
  usd_amount: number | null;
}>> {
  const apiKey = Deno.env.get("HELIUS_API_KEY") ?? "";
  if (!apiKey) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - Math.max(1, windowSeconds);
  const out: Array<{ ts: number; signature: string; wallet: string | null; side: "buy" | "sell" | "unknown"; sol_amount: number | null; usd_amount: number | null }> = [];
  let before: string | undefined;
  let pages = 0;

  try {
    while (pages < MAX_PAGES) {
      const path = before
        ? `${HELIUS_BASE}/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(apiKey)}&limit=${PAGE_LIMIT}&before=${encodeURIComponent(before)}`
        : `${HELIUS_BASE}/${encodeURIComponent(mint)}/transactions?api-key=${encodeURIComponent(apiKey)}&limit=${PAGE_LIMIT}`;
      const page = await fetchPage(path);
      pages += 1;
      if (page.length === 0) break;

      let pastWindow = false;
      for (const tx of page) {
        const ts = getTxTimeSec(tx);
        if (ts == null) continue;
        if (ts < windowStartSec) {
          pastWindow = true;
          break;
        }
        if (ts > nowSec) continue;
        if (!txInvolvesMint(tx, mint)) continue;
        const sig = getTxSignature(tx);
        if (!sig) continue;
        const wallet = getWallet(tx);
        const side = wallet ? classifySide(tx, mint, wallet) : "unknown";
        const sol_amount = wallet && (side === "buy" || side === "sell")
          ? getSolAmountForWallet(tx, wallet, side)
          : null;
        out.push({
          ts,
          signature: sig,
          wallet,
          side,
          sol_amount,
          usd_amount: null,
        });
      }
      if (pastWindow) break;
      const lastSig = getTxSignature(page[page.length - 1]);
      if (!lastSig || lastSig === before) break;
      before = lastSig;
    }

    out.sort((a, b) => b.ts - a.ts);
    return out;
  } catch {
    return [];
  }
}
