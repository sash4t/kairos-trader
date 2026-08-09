import { atr, ema, last, macd, rsi } from "./indicators";
import type { Candle } from "./hyperliquid";

export type StrategyMode = "conservative" | "balanced" | "aggressive";

export const MODE_MIN_CONFIDENCE: Record<StrategyMode, number> = {
  conservative: 80, balanced: 70, aggressive: 60,
};

export interface Signal {
  coin: string;
  side: "long" | "short" | null;
  confidence: number;
  reasons: string[];
  price: number;
  atrValue: number;
  indicators: Record<string, number>;
}

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export function candlesToBars(cs: Candle[]): Bar[] {
  return cs.map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
}

/**
 * TrendBot strategy adapted for Kairos.
 *
 * Entry: EMA fast/slow trend confirmation + RSI momentum + MACD confirmation.
 * At least two of the three confirmations must agree, with ATR filtering out
 * dead/choppy markets. The same rules are mirrored for longs and shorts.
 *
 * Kairos trades Hyperliquid USDC perpetuals, so both directions are valid.
 * No spot balance assumptions belong in this strategy.
 */
export const STRATEGY_PARAMS = {
  interval: "1h",
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiThreshold: 55,
  atrPeriod: 14,
  atrMinPct: 0.05,
  atrMaxPct: 6,
  tpPct: 12,
  slPct: 1.5,
  trailActivatePct: 1.5,
  trailDistPct: 1.2,
  maxHoldBars: 24,
} as const;

export function evaluateSignal(coin: string, bars: Bar[]): Signal {
  const P = STRATEGY_PARAMS;
  const empty: Signal = { coin, side: null, confidence: 0, reasons: [], price: 0, atrValue: 0, indicators: {} };
  if (bars.length < Math.max(P.emaSlow, 60)) return empty;

  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const vols = bars.map(b => b.v);
  const price = last(closes)!;

  const eFast = ema(closes, P.emaFast);
  const eSlow = ema(closes, P.emaSlow);
  const rs = rsi(closes, P.rsiPeriod);
  const md = macd(closes);
  const at = atr(bars, P.atrPeriod);
  const atrV = last(at)!;
  const atrPct = (atrV / price) * 100;
  const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volX = last(vols)! / (avgVol || 1);

  const indicators = {
    emaFast: last(eFast)!,
    emaSlow: last(eSlow)!,
    rsi: last(rs)!,
    macdHist: last(md.hist)!,
    atrPct,
    volX,
  };

  if (!isFinite(price) || !isFinite(atrV) || !isFinite(indicators.emaFast) || !isFinite(indicators.emaSlow)) {
    return { ...empty, price, atrValue: atrV, indicators };
  }

  if (atrPct < P.atrMinPct || atrPct > P.atrMaxPct) {
    return { ...empty, price, atrValue: atrV, indicators,
      reasons: [`ATR% ${atrPct.toFixed(2)} outside ${P.atrMinPct}–${P.atrMaxPct} band`] };
  }

  // Trend confirmation.
  const emaBull = eFast[eFast.length - 1] > eSlow[eSlow.length - 1]
    && price > eFast[eFast.length - 1]
    && eFast[eFast.length - 1] > eFast[eFast.length - 2];
  const emaBear = eFast[eFast.length - 1] < eSlow[eSlow.length - 1]
    && price < eFast[eFast.length - 1]
    && eFast[eFast.length - 1] < eFast[eFast.length - 2];

  // Momentum confirmation. RSI thresholds are mirrored around 50.
  const rsiBull = rs[rs.length - 1] > P.rsiThreshold && rs[rs.length - 1] > rs[rs.length - 2];
  const rsiBear = rs[rs.length - 1] < (100 - P.rsiThreshold) && rs[rs.length - 1] < rs[rs.length - 2];

  // MACD confirmation.
  const macdBull = md.hist[md.hist.length - 1] > 0 && md.hist[md.hist.length - 1] > md.hist[md.hist.length - 2];
  const macdBear = md.hist[md.hist.length - 1] < 0 && md.hist[md.hist.length - 1] < md.hist[md.hist.length - 2];

  const longScore = Number(emaBull) + Number(rsiBull) + Number(macdBull);
  const shortScore = Number(emaBear) + Number(rsiBear) + Number(macdBear);

  let side: "long" | "short" | null = null;
  if (longScore >= 2 && longScore > shortScore) side = "long";
  else if (shortScore >= 2 && shortScore > longScore) side = "short";

  if (!side) {
    return { ...empty, price, atrValue: atrV, indicators,
      reasons: ["No TrendBot trend + momentum confirmation"] };
  }

  const reasons: string[] = [];
  const score = side === "long" ? longScore : shortScore;
  if (side === "long" ? emaBull : emaBear) reasons.push(`EMA${P.emaFast}/${P.emaSlow} ${side === "long" ? "bullish" : "bearish"} trend`);
  if (side === "long" ? rsiBull : rsiBear) reasons.push(`RSI ${indicators.rsi.toFixed(1)} ${side === "long" ? "rising above" : "falling below"} ${side === "long" ? P.rsiThreshold : 100 - P.rsiThreshold}`);
  if (side === "long" ? macdBull : macdBear) reasons.push(`MACD histogram ${side === "long" ? "positive & expanding" : "negative & expanding"}`);
  if (volX > 1.2) reasons.push(`Volume ${volX.toFixed(2)}x average`);
  reasons.push(`ATR ${atrPct.toFixed(2)}% volatility filter passed`);

  // 60% base + 10% per confirmed component; optional volume confluence.
  let confidence = 40 + score * 15;
  if (volX > 1.2) confidence += 10;
  return { coin, side, confidence: Math.min(95, confidence), reasons, price, atrValue: atrV, indicators };
}

const CORRELATION_BUCKETS: Record<string, string> = {
  BTC: "btc", ETH: "eth",
  SOL: "l1", AVAX: "l1", NEAR: "l1", APT: "l1", SUI: "l1", SEI: "l1", TIA: "l1", INJ: "l1",
  ARB: "l2", OP: "l2", MATIC: "l2", STRK: "l2",
  DOGE: "meme", SHIB: "meme", PEPE: "meme", WIF: "meme", BONK: "meme", FLOKI: "meme",
  LINK: "defi", UNI: "defi", AAVE: "defi", MKR: "defi", CRV: "defi", COMP: "defi",
};
export function bucket(coin: string): string {
  return CORRELATION_BUCKETS[coin] ?? "other";
}
