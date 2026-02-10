/**
 * Live decision metrics and verdict for a single mint over a time window.
 * Matches Lola's spec: core checks (capital_efficiency, buy_ratio, unique_buyers) -> invest | watch | avoid.
 */

export type LiveMetrics = {
  window_seconds: number;
  observed_from: string; // ISO
  observed_to: string;   // ISO
  buy_count: number;
  sell_count: number;
  unique_buyers: number;
  buy_ratio: number | null;
  net_sol_inflow: number | null;
  fdv_usd: number | null;
  capital_efficiency: number | null;
  liquidity_usd: number | null;
};

export type SwapInput = {
  ts: number;
  wallet: string | null;
  side: "buy" | "sell" | "unknown";
  sol_amount: number | null;
};

/**
 * Compute live metrics from a list of swaps in a window.
 * capital_efficiency uses the same definition as the feed: (net_sol_inflow * 200) / fdv_usd
 * (200 = placeholder SOL/USD; see migration 015_capital_efficiency_and_mc_structure.sql).
 */
export function computeLiveMetrics(params: {
  swaps: SwapInput[];
  windowSeconds: number;
  fdv_usd: number | null;
  liquidity_usd: number | null;
}): LiveMetrics {
  const { swaps, windowSeconds, fdv_usd, liquidity_usd } = params;

  const buys = swaps.filter((s) => s.side === "buy");
  const sells = swaps.filter((s) => s.side === "sell");
  const buyCount = buys.length;
  const sellCount = sells.length;
  const uniqueBuyers = new Set(buys.map((s) => s.wallet).filter((w): w is string => w != null)).size;

  const total = buyCount + sellCount;
  const buyRatio = total > 0 ? buyCount / total : null;

  let netSolInflow: number | null = null;
  let buySol = 0;
  let sellSol = 0;
  for (const s of swaps) {
    if (s.sol_amount == null) continue;
    if (s.side === "buy") buySol += s.sol_amount;
    else if (s.side === "sell") sellSol += s.sol_amount;
  }
  const hasAnySol = buys.some((s) => s.sol_amount != null) || sells.some((s) => s.sol_amount != null);
  if (hasAnySol) {
    netSolInflow = buySol - sellSol;
  }

  // Same as feed: (net_sol_inflow * 200) / fdv_usd (migration 015)
  let capitalEfficiency: number | null = null;
  if (netSolInflow != null && fdv_usd != null && fdv_usd > 0) {
    capitalEfficiency = (netSolInflow * 200) / fdv_usd;
  }

  const now = new Date();
  const observedTo = new Date(now);
  const observedFrom = new Date(now.getTime() - windowSeconds * 1000);

  return {
    window_seconds: windowSeconds,
    observed_from: observedFrom.toISOString(),
    observed_to: observedTo.toISOString(),
    buy_count: buyCount,
    sell_count: sellCount,
    unique_buyers: uniqueBuyers,
    buy_ratio: buyRatio,
    net_sol_inflow: netSolInflow,
    fdv_usd: fdv_usd ?? null,
    capital_efficiency: capitalEfficiency,
    liquidity_usd: liquidity_usd ?? null,
  };
}

export type LiveVerdictResult = {
  verdict: "invest" | "watch" | "avoid";
  confidence: number;
  reasons: string[];
};

/**
 * Core checks (Lola spec):
 * 1) capital_efficiency < 0.20 (if null -> fail, reason "Capital efficiency unavailable")
 * 2) buy_ratio in [0.70, 0.80] (if null -> fail)
 * 3) unique_buyers > 20
 * invest = 3/3, watch = 2/3, avoid = else.
 * Confidence = passCount/3; optional small bump if liquidity_usd is high.
 */
export function makeLiveVerdict(metrics: LiveMetrics): LiveVerdictResult {
  const reasons: string[] = [];

  const ceOk = metrics.capital_efficiency != null && metrics.capital_efficiency < 0.2;
  if (metrics.capital_efficiency == null) {
    reasons.push("Capital efficiency unavailable");
  } else if (!ceOk) {
    reasons.push(`Capital efficiency ${metrics.capital_efficiency.toFixed(3)} >= 0.20`);
  }

  const ratioOk =
    metrics.buy_ratio != null && metrics.buy_ratio >= 0.7 && metrics.buy_ratio <= 0.8;
  if (metrics.buy_ratio == null) {
    reasons.push("Buy ratio unavailable");
  } else if (!ratioOk) {
    reasons.push(`Buy ratio ${metrics.buy_ratio.toFixed(2)} not in [0.70, 0.80]`);
  }

  const buyersOk = metrics.unique_buyers > 20;
  if (!buyersOk) {
    reasons.push(`Unique buyers ${metrics.unique_buyers} <= 20`);
  }

  const passCount = [ceOk, ratioOk, buyersOk].filter(Boolean).length;
  let confidence = passCount / 3;
  // Optional: small bump if liquidity is high (e.g. > 50k)
  if (metrics.liquidity_usd != null && metrics.liquidity_usd > 50_000 && confidence > 0) {
    confidence = Math.min(1, confidence + 0.05);
  }

  let verdict: "invest" | "watch" | "avoid";
  if (passCount === 3) verdict = "invest";
  else if (passCount === 2) verdict = "watch";
  else verdict = "avoid";

  return { verdict, confidence, reasons };
}
