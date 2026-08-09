import { atr, bollinger, ema, last, macd, rsi, sma } from "./indicators";
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

/** Current parameters — see the backtest note under evaluateSignal. */
export const STRATEGY_PARAMS = {
  interval: "1h",
  bbPeriod: 20,
  bbK: 2.0,
  trendPeriod: 200,
  atrMinPct: 0.5,
  atrMaxPct: 6,
  tpPct: 12,
  slPct: 1.5,
  trailActivatePct: 1.5,
  trailDistPct: 1.2,
  maxHoldBars: 24,
} as const;

/** Bollinger breakout with an SMA200 trend filter, on 1-hour bars. */
export function evaluateSignal(coin: string, bars: Bar[]): Signal {
  const P = STRATEGY_PARAMS;
  const empty: Signal = { coin, side: null, confidence: 0, reasons: [], price: 0, atrValue: 0, indicators: {} };
  if (bars.length < P.trendPeriod + 10) return empty;

  const closes = bars.map(b => b.c);
  const vols = bars.map(b => b.v);
  const price = last(closes)!;
  const bb = bollinger(closes, P.bbPeriod, P.bbK);
  const trend = sma(closes, P.trendPeriod);
  const rs = rsi(closes, 14);
  const md = macd(closes);
  const at = atr(bars, 14);
  const e50 = ema(closes, 50);
  const upper = last(bb.upper)!, lower = last(bb.lower)!, mid = last(bb.mid)!, width = last(bb.width)!;
  const sma200 = last(trend)!;
  const rsiV = last(rs)!;
  const macdHist = last(md.hist)!;
  const atrV = last(at)!;
  const atrPct = (atrV / price) * 100;
  const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volX = last(vols)! / (avgVol || 1);
  const indicators = { bbUpper: upper, bbLower: lower, bbMid: mid, bbWidth: width, sma200, ema50: last(e50)!, rsi: rsiV, macdHist, atrPct, volX };
  if (!isFinite(upper) || !isFinite(sma200) || !isFinite(atrV)) return { ...empty, price, atrValue: atrV, indicators };
  if (atrPct < P.atrMinPct || atrPct > P.atrMaxPct) return { ...empty, price, atrValue: atrV, indicators, reasons: [`ATR% ${atrPct.toFixed(2)} outside ${P.atrMinPct}–${P.atrMaxPct} band`] };

  let side: "long" | "short" | null = null;
  const reasons: string[] = [];
  if (price > sma200 && price >= upper && rsiV > 50) {
    side = "long";
    reasons.push(`Closed above ${P.bbK}σ Bollinger band (${upper.toFixed(4)})`, `Above SMA200 (${sma200.toFixed(4)})`, `RSI ${rsiV.toFixed(1)}`);
  } else if (price < sma200 && price <= lower && rsiV < 50) {
    side = "short";
    reasons.push(`Closed below ${P.bbK}σ Bollinger band (${lower.toFixed(4)})`, `Below SMA200 (${sma200.toFixed(4)})`, `RSI ${rsiV.toFixed(1)}`);
  }
  if (!side) return { ...empty, price, atrValue: atrV, indicators, reasons: ["No Bollinger breakout in trend direction"] };

  let confidence = 60;
  const stretch = side === "long" ? (price - upper) / (atrV || 1e-9) : (lower - price) / (atrV || 1e-9);
  if (stretch > 0.1) { confidence += 8; reasons.push(`${stretch.toFixed(2)} ATR beyond the band`); }
  if (volX > 1.2) { confidence += 10; reasons.push(`Volume ${volX.toFixed(2)}x average`); }
  if (side === "long" ? macdHist > 0 : macdHist < 0) { confidence += 10; reasons.push("MACD histogram confirms"); }
  if (side === "long" ? rsiV > 58 && rsiV < 80 : rsiV < 42 && rsiV > 20) { confidence += 7; reasons.push("RSI in momentum zone"); }
  if (side === "long" ? price > last(e50)! : price < last(e50)!) { confidence += 5; reasons.push("On trend side of EMA50"); }
  return { coin, side, confidence: Math.min(95, confidence), reasons, price, atrValue: atrV, indicators };
}

const CORRELATION_BUCKETS: Record<string, string> = {
  BTC: "btc", ETH: "eth", SOL: "l1", AVAX: "l1", NEAR: "l1", APT: "l1", SUI: "l1", SEI: "l1", TIA: "l1", INJ: "l1",
  ARB: "l2", OP: "l2", MATIC: "l2", STRK: "l2", DOGE: "meme", SHIB: "meme", PEPE: "meme", WIF: "meme", BONK: "meme", FLOKI: "meme",
  LINK: "defi", UNI: "defi", AAVE: "defi", MKR: "defi", CRV: "defi", COMP: "defi",
};
export function bucket(coin: string): string { return CORRELATION_BUCKETS[coin] ?? "other"; }
