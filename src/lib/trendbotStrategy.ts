import { atr, ema, last, macd, rsi } from "./indicators";
import type { Bar, Signal } from "./strategy";

export const TRENDBOT_STRATEGY_KEY = "trendbot_momentum" as const;

export const TRENDBOT_PARAMS = {
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

/** TrendBot-style EMA/RSI/MACD momentum strategy, mirrored for long/short perps. */
export function evaluateTrendBotSignal(coin: string, bars: Bar[]): Signal {
  const P = TRENDBOT_PARAMS;
  const empty: Signal = { coin, side: null, confidence: 0, reasons: [], price: 0, atrValue: 0, indicators: {} };
  if (bars.length < Math.max(P.emaSlow, 60)) return empty;

  const closes = bars.map(b => b.c);
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
  const indicators = { emaFast: last(eFast)!, emaSlow: last(eSlow)!, rsi: last(rs)!, macdHist: last(md.hist)!, atrPct, volX };

  if (!isFinite(price) || !isFinite(atrV) || !isFinite(indicators.emaFast) || !isFinite(indicators.emaSlow)) {
    return { ...empty, price, atrValue: atrV, indicators };
  }
  if (atrPct < P.atrMinPct || atrPct > P.atrMaxPct) {
    return { ...empty, price, atrValue: atrV, indicators, reasons: [`ATR% ${atrPct.toFixed(2)} outside ${P.atrMinPct}–${P.atrMaxPct} band`] };
  }

  const emaBull = eFast.at(-1)! > eSlow.at(-1)! && price > eFast.at(-1)! && eFast.at(-1)! > eFast.at(-2)!;
  const emaBear = eFast.at(-1)! < eSlow.at(-1)! && price < eFast.at(-1)! && eFast.at(-1)! < eFast.at(-2)!;
  const rsiBull = rs.at(-1)! > P.rsiThreshold && rs.at(-1)! > rs.at(-2)!;
  const rsiBear = rs.at(-1)! < (100 - P.rsiThreshold) && rs.at(-1)! < rs.at(-2)!;
  const macdBull = md.hist.at(-1)! > 0 && md.hist.at(-1)! > md.hist.at(-2)!;
  const macdBear = md.hist.at(-1)! < 0 && md.hist.at(-1)! < md.hist.at(-2)!;
  const longScore = Number(emaBull) + Number(rsiBull) + Number(macdBull);
  const shortScore = Number(emaBear) + Number(rsiBear) + Number(macdBear);

  let side: "long" | "short" | null = null;
  if (longScore >= 2 && longScore > shortScore) side = "long";
  else if (shortScore >= 2 && shortScore > longScore) side = "short";
  if (!side) return { ...empty, price, atrValue: atrV, indicators, reasons: ["No TrendBot trend + momentum confirmation"] };

  const score = side === "long" ? longScore : shortScore;
  const reasons: string[] = [];
  if (side === "long" ? emaBull : emaBear) reasons.push(`EMA${P.emaFast}/${P.emaSlow} ${side === "long" ? "bullish" : "bearish"} trend`);
  if (side === "long" ? rsiBull : rsiBear) reasons.push(`RSI ${indicators.rsi.toFixed(1)} ${side === "long" ? "rising above" : "falling below"} ${side === "long" ? P.rsiThreshold : 100 - P.rsiThreshold}`);
  if (side === "long" ? macdBull : macdBear) reasons.push(`MACD histogram ${side === "long" ? "positive & expanding" : "negative & expanding"}`);
  if (volX > 1.2) reasons.push(`Volume ${volX.toFixed(2)}x average`);
  reasons.push(`ATR ${atrPct.toFixed(2)}% volatility filter passed`);

  let confidence = 40 + score * 15;
  if (volX > 1.2) confidence += 10;
  return { coin, side, confidence: Math.min(95, confidence), reasons, price, atrValue: atrV, indicators };
}
