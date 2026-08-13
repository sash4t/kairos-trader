import { AssetMeta } from "./hyperliquid";

export interface ScannerAssetContext {
  funding: string;
  openInterest: string;
  markPx: string;
  dayNtlVlm: string;
  midPx?: string | null;
  impactPxs?: [string, string] | null;
}

export interface ScannerConfig {
  /** Minimum 24h notional volume in USDC. */
  min24hVolume: number;
  /** Minimum open interest in USDC notional. */
  minOpenInterest: number;
  /** Minimum mark price in USDC. */
  minPrice: number;
  /** Maximum absolute funding rate used as a basic quality guard. */
  maxAbsFundingRate: number;
  /** Maximum estimated bid/ask spread as a fraction of mid. */
  maxSpreadPct: number;
  /** Never scan spot assets; this scanner is for Hyperliquid perps. */
  perpsOnly: boolean;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  min24hVolume: 5_000_000,
  minOpenInterest: 100_000,
  minPrice: 0.000001,
  maxAbsFundingRate: 0.01,
  maxSpreadPct: 0.75,
  perpsOnly: true,
};

export interface ScannedMarket {
  meta: AssetMeta;
  ctx: ScannerAssetContext;
  volume24h: number;
  openInterest: number;
  markPrice: number;
  spreadPct: number | null;
}

export interface RejectedMarket {
  coin: string;
  reasons: string[];
}

export interface ScanResult {
  markets: ScannedMarket[];
  rejected: RejectedMarket[];
}

function finitePositive(value: string | number | null | undefined): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function estimatedSpreadPct(ctx: ScannerAssetContext): number | null {
  const mid = finitePositive(ctx.midPx) ?? finitePositive(ctx.markPx);
  if (!mid || !ctx.impactPxs || ctx.impactPxs.length !== 2) return null;
  const bid = finitePositive(ctx.impactPxs[0]);
  const ask = finitePositive(ctx.impactPxs[1]);
  if (!bid || !ask || ask < bid) return null;
  return ((ask - bid) / mid) * 100;
}

/**
 * Build the complete, filtered perp universe. There is intentionally no top-N
 * selection here: every market that passes the quality gates is returned.
 */
export function filterPerpUniverse(
  universe: AssetMeta[],
  ctxs: ScannerAssetContext[],
  config: ScannerConfig = DEFAULT_SCANNER_CONFIG,
): ScanResult {
  const markets: ScannedMarket[] = [];
  const rejected: RejectedMarket[] = [];

  for (let i = 0; i < universe.length; i++) {
    const meta = universe[i];
    const ctx = ctxs[i];
    const reasons: string[] = [];
    if (!ctx) reasons.push("missing market context");

    const volume24h = ctx ? Number(ctx.dayNtlVlm) : NaN;
    const openInterest = ctx ? Number(ctx.openInterest) : NaN;
    const markPrice = ctx ? Number(ctx.markPx) : NaN;
    const funding = ctx ? Number(ctx.funding) : NaN;

    if (!Number.isFinite(volume24h) || volume24h < config.min24hVolume) reasons.push(`24h volume below ${config.min24hVolume}`);
    if (!Number.isFinite(openInterest) || openInterest < config.minOpenInterest) reasons.push(`open interest below ${config.minOpenInterest}`);
    if (!Number.isFinite(markPrice) || markPrice < config.minPrice) reasons.push("invalid/too-small mark price");
    if (!Number.isFinite(funding) || Math.abs(funding) > config.maxAbsFundingRate) reasons.push("funding rate outside quality band");

    const spreadPct = ctx ? estimatedSpreadPct(ctx) : null;
    if (spreadPct !== null && spreadPct > config.maxSpreadPct) reasons.push(`spread above ${config.maxSpreadPct}%`);

    if (reasons.length) {
      rejected.push({ coin: meta.name, reasons });
      continue;
    }

    markets.push({ meta, ctx, volume24h, openInterest, markPrice, spreadPct });
  }

  markets.sort((a, b) => b.volume24h - a.volume24h);
  return { markets, rejected };
}
