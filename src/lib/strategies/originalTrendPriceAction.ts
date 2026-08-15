import { atr, ema, last, macd, rsi } from "../indicators";
import { getTrendlineState, type Bar, type Signal } from "../strategy";

export const ORIGINAL_TREND_PRICE_ACTION_KEY = "original-trend-price-action" as const;

export const ORIGINAL_TPA_DEFAULTS = {
  atrPeriod: 14,
  atrMinPct: 0.10,
  atrMaxPct: 6,
  minConfidence: 60,
  // Current crossing bar plus the prior three completed 1H bars.
  maxBreakoutAgeBars: 3,
  riskPct: 0.4,
  positionSizePct: 6,
  takeProfitR: 2.2,
} as const;

type Side = "long" | "short";
type TrendStrength = "strong" | "transition";

interface DirectionState {
  side: Side | null;
  strength: TrendStrength | null;
  ema20: number;
  ema50: number;
}

function directionState(bars: Bar[]): DirectionState {
  if (bars.length < 51) return { side: null, strength: null, ema20: NaN, ema50: NaN };
  const closes = bars.map((b) => b.c);
  const e20Series = ema(closes, 20);
  const e50Series = ema(closes, 50);
  const e20 = last(e20Series) ?? NaN;
  const e50 = last(e50Series) ?? NaN;
  const e20Prev = e20Series.at(-2) ?? e20;
  const price = bars.at(-1)?.c ?? NaN;
  if (![price, e20, e50].every(Number.isFinite)) return { side: null, strength: null, ema20: e20, ema50: e50 };

  if (price > e20 && e20 > e50) return { side: "long", strength: "strong", ema20: e20, ema50: e50 };
  if (price < e20 && e20 < e50) return { side: "short", strength: "strong", ema20: e20, ema50: e50 };

  // Transitional trend: price has reclaimed EMA20 and EMA20 is moving toward a crossover.
  // This admits early trend phases without treating a clearly opposite 4H trend as valid.
  if (price > e20 && e20 <= e50 && e20 > e20Prev) return { side: "long", strength: "transition", ema20: e20, ema50: e50 };
  if (price < e20 && e20 >= e50 && e20 < e20Prev) return { side: "short", strength: "transition", ema20: e20, ema50: e50 };
  return { side: null, strength: null, ema20: e20, ema50: e50 };
}

function strongDirectionalBias(bars: Bar[]): Side | null {
  const state = directionState(bars);
  return state.strength === "strong" ? state.side : null;
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

  const dailyBias = strongDirectionalBias(daily);
  const fourState = directionState(fourHour);
  if (!fourState.side) {
    return { ...empty, reasons: ["4H has no established or transitional EMA20/50 directional bias"] };
  }
  if (dailyBias && dailyBias !== fourState.side) {
    return { ...empty, reasons: [`Daily bias (${dailyBias}) opposes 4H bias (${fourState.side})`] };
  }
  const bias = fourState.side;

  const completed = hourly.slice(0, -1);
  const price = hourly.at(-1)!.c;
  const state = getTrendlineState(completed);
  const supportNow = state.support?.valueAt(completed.length);
  const resistanceNow = state.resistance?.valueAt(completed.length);

  let breakSide: Side | null = null;
  let breakoutAge = 0;
  for (let age = 0; age <= ORIGINAL_TPA_DEFAULTS.maxBreakoutAgeBars; age++) {
    const idx = completed.length - 1 - age;
    if (idx < 1) break;
    const closeAt = completed[idx]!.c;
    const closeBefore = completed[idx - 1]!.c;
    const resAt = state.resistance?.valueAt(idx);
    const resBefore = state.resistance?.valueAt(idx - 1);
    const supAt = state.support?.valueAt(idx);
    const supBefore = state.support?.valueAt(idx - 1);
    const crossedUp = resAt != null && resBefore != null && closeBefore <= resBefore && closeAt > resAt;
    const crossedDown = supAt != null && supBefore != null && closeBefore >= supBefore && closeAt < supAt;
    if (crossedUp || crossedDown) {
      breakSide = crossedUp ? "long" : "short";
      breakoutAge = age;
      break;
    }
  }

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

  const holds = breakSide === "long"
    ? resistanceNow == null || price > resistanceNow
    : breakSide === "short"
      ? supportNow == null || price < supportNow
      : false;
  const side: Side | null = breakSide && breakSide === bias && holds ? breakSide : null;

  const indicators = {
    dailyBias: dailyBias === "long" ? 1 : dailyBias === "short" ? -1 : 0,
    fourHourBias: bias === "long" ? 1 : -1,
    fourHourTransition: fourState.strength === "transition" ? 1 : 0,
    fourHourEma20: fourState.ema20,
    fourHourEma50: fourState.ema50,
    breakoutAge,
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
    return { ...empty, price, atrValue, indicators, reasons: [`No recent 1H trend-line crossing in ${bias} direction`] };
  }

  const reasons = [
    fourState.strength === "strong" ? `4H EMA20/50 trend ${side}` : `4H transitional EMA20 trend ${side}`,
    breakoutAge === 0 ? `Fresh 1H trend-line crossing ${side}` : `1H trend-line crossing ${side} (${breakoutAge} bar(s) ago)`,
  ];
  let confidence = 65;

  if (fourState.strength === "strong") confidence += 3;
  if (dailyBias === side) { confidence += 6; reasons.push("Daily bias agrees"); }
  else reasons.push("Daily neutral");

  if (breakoutAge === 0) confidence += 4;
  else if (breakoutAge === 1) confidence += 2;
  else if (breakoutAge === 3) confidence -= 3;

  const emaAligned = side === "long" ? price > e20 && e20 > e50 : price < e20 && e20 < e50;
  if (emaAligned) { confidence += 8; reasons.push("1H EMA20/50 trend confirms"); }
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
