import { atr, ema, last, macd, rsi } from "../indicators";
import { getTrendlineState, type Bar, type Signal } from "../strategy";

export const ORIGINAL_TREND_PRICE_ACTION_KEY = "original-trend-price-action" as const;

export const ORIGINAL_TPA_DEFAULTS = {
  atrPeriod: 14,
  atrMinPct: 0.15,
  atrMaxPct: 6,
  minConfidence: 65,
  riskPct: 0.4,
  positionSizePct: 6,
  takeProfitR: 2.2,
} as const;

type Side = "long" | "short";

function directionalBias(bars: Bar[]): Side | null {
  if (bars.length < 50) return null;
  const closes = bars.map((b) => b.c);
  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const price = bars.at(-1)?.c;
  if (price == null || e20 == null || e50 == null) return null;
  if (price > e20 && e20 > e50) return "long";
  if (price < e20 && e20 < e50) return "short";
  return null;
}

export function evaluateOriginalTrendPriceAction(coin: string, daily: Bar[], fourHour: Bar[], hourly: Bar[]): Signal {
  const empty: Signal = {
    coin,
    side: null,
    confidence: 0,
    reasons: [],
    price: hourly.at(-1)?.c ?? 0,
    atrValue: 0,
    indicators: {},
  };
  if (daily.length < 80 || fourHour.length < 80 || hourly.length < 80) {
    return { ...empty, reasons: ["Waiting for Daily/4H/1H history"] };
  }

  const dailyBias = directionalBias(daily);
  const fourHourBias = directionalBias(fourHour);
  if (!dailyBias || dailyBias !== fourHourBias) {
    return {
      ...empty,
      reasons: [`Daily/4H directional alignment missing (Daily=${dailyBias ?? "neutral"}, 4H=${fourHourBias ?? "neutral"})`],
    };
  }

  const completed = hourly.slice(0, -1);
  const previous = hourly.at(-2)!.c;
  const price = hourly.at(-1)!.c;
  const state = getTrendlineState(completed);
  const supportNow = state.support?.valueAt(completed.length);
  const resistanceNow = state.resistance?.valueAt(completed.length);
  const supportPrev = state.support?.valueAt(completed.length - 1);
  const resistancePrev = state.resistance?.valueAt(completed.length - 1);

  const closes = hourly.map((b) => b.c);
  const volumes = hourly.map((b) => b.v);
  const e20 = last(ema(closes, 20)) ?? price;
  const e50 = last(ema(closes, 50)) ?? price;
  const rsiValue = last(rsi(closes, 14)) ?? 50;
  const macdHist = last(macd(closes).hist) ?? 0;
  const atrValue = last(atr(hourly, ORIGINAL_TPA_DEFAULTS.atrPeriod)) ?? 0;
  const atrPct = price > 0 ? (atrValue / price) * 100 : 0;
  const avgVolume = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / 20;
  const volumeX = (last(volumes) ?? 0) / (avgVolume || 1);

  const brokeLong = resistancePrev != null && resistanceNow != null && previous <= resistancePrev && price > resistanceNow;
  const brokeShort = supportPrev != null && supportNow != null && previous >= supportPrev && price < supportNow;
  const side: Side | null = dailyBias === "long" && brokeLong ? "long" : dailyBias === "short" && brokeShort ? "short" : null;

  const indicators = {
    dailyBias: dailyBias === "long" ? 1 : -1,
    fourHourBias: fourHourBias === "long" ? 1 : -1,
    ema20: e20,
    ema50: e50,
    rsi: rsiValue,
    macdHist,
    volX: volumeX,
    atrPct,
    hourlySupport: supportNow ?? Number.NaN,
    hourlyResistance: resistanceNow ?? Number.NaN,
  };

  if (atrPct < ORIGINAL_TPA_DEFAULTS.atrMinPct || atrPct > ORIGINAL_TPA_DEFAULTS.atrMaxPct) {
    return { ...empty, price, atrValue, indicators, reasons: [`ATR% ${atrPct.toFixed(2)} outside volatility band`] };
  }
  if (!side) {
    return { ...empty, price, atrValue, indicators, reasons: [`No fresh 1H trend-line break in ${dailyBias} direction`] };
  }

  const reasons = [
    `Daily and 4H aligned ${side}`,
    `Fresh 1H trend-line break ${side}`,
  ];
  let confidence = 68;

  const emaAligned = side === "long" ? price > e20 && e20 > e50 : price < e20 && e20 < e50;
  if (emaAligned) { confidence += 8; reasons.push("EMA20/50 trend confirms"); }
  else confidence -= 5;

  const rsiAligned = side === "long" ? rsiValue >= 52 : rsiValue <= 48;
  if (rsiAligned) { confidence += 5; reasons.push(`RSI ${rsiValue.toFixed(1)} confirms`); }

  const macdAligned = side === "long" ? macdHist > 0 : macdHist < 0;
  if (macdAligned) { confidence += 6; reasons.push("MACD histogram confirms"); }

  if (volumeX >= 1.2) { confidence += 5; reasons.push(`Volume ${volumeX.toFixed(2)}x average`); }
  else if (volumeX < 0.8) confidence -= 4;

  const lineTouches = side === "long" ? (state.resistance?.touches ?? 0) : (state.support?.touches ?? 0);
  if (lineTouches >= 3) { confidence += 4; reasons.push(`${lineTouches} trend-line touches`); }

  const actionLine = side === "long" ? resistanceNow : supportNow;
  const safetyLine = side === "long" ? supportNow : resistanceNow;
  return {
    coin,
    side,
    confidence: Math.max(0, Math.min(98, confidence)),
    reasons,
    price,
    atrValue,
    indicators,
    actionLine,
    safetyLine,
  };
}
