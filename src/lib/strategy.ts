import { atr, ema, last, macd, rsi, sma } from "./indicators";
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
  actionLine?: number;
  safetyLine?: number;
}

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export function candlesToBars(cs: Candle[]): Bar[] {
  return cs.map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
}

/**
 * Trend-line price-action strategy translated from the supplied transcript.
 * Discretionary charting rules are made deterministic with confirmed swing pivots.
 */
export const STRATEGY_PARAMS = {
  interval: "1h",
  pivotStrength: 3,
  pivotSearch: 80,
  minTouches: 2,
  lineToleranceAtr: 0.12,
  atrPeriod: 14,
  atrMinPct: 0.05,
  atrMaxPct: 6,
  maxHoldBars: 0,
  tpPct: 100,
  slPct: 0,
  trailActivatePct: 0,
  trailDistPct: 0,
} as const;

export const TRENDLINE_STRATEGY_KEY = "trendline_price_action" as const;

interface Pivot { i: number; price: number }
interface TrendLine { i1: number; p1: number; i2: number; p2: number; slope: number; touches: number; valueAt: (i: number) => number }

function pivotLows(bars: Bar[], strength: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) { ok = false; break; }
    }
    if (ok) out.push({ i, price: bars[i].l });
  }
  return out;
}

function pivotHighs(bars: Bar[], strength: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) { ok = false; break; }
    }
    if (ok) out.push({ i, price: bars[i].h });
  }
  return out;
}

function buildLine(bars: Bar[], a: Pivot, b: Pivot, support: boolean, tolerance: number): TrendLine | null {
  if (b.i <= a.i) return null;
  const slope = (b.price - a.price) / (b.i - a.i);
  if (support && slope <= 0) return null;
  if (!support && slope >= 0) return null;
  const valueAt = (i: number) => a.price + slope * (i - a.i);
  let touches = 0;
  for (let i = a.i; i <= b.i; i++) {
    const line = valueAt(i);
    const distance = support ? bars[i].l - line : line - bars[i].h;
    if (distance < -tolerance) return null;
    if (Math.abs(distance) <= tolerance) touches++;
  }
  if (touches < STRATEGY_PARAMS.minTouches) return null;
  return { i1: a.i, p1: a.price, i2: b.i, p2: b.price, slope, touches, valueAt };
}

function findBestLine(bars: Bar[], pivots: Pivot[], support: boolean, currentIndex: number, tolerance: number): TrendLine | null {
  const usable = pivots.filter(p => p.i < currentIndex).slice(-STRATEGY_PARAMS.pivotSearch);
  if (usable.length < 2) return null;
  let best: TrendLine | null = null;
  const latest = usable[usable.length - 1];
  for (let j = usable.length - 2; j >= 0; j--) {
    const candidate = buildLine(bars, usable[j], latest, support, tolerance);
    if (!candidate) continue;
    if (!best || candidate.touches > best.touches || (candidate.touches === best.touches && candidate.i1 > best.i1)) best = candidate;
  }
  return best;
}

/** Returns the current bullish support and bearish resistance trend lines. */
export function getTrendlineState(bars: Bar[]): { support: TrendLine | null; resistance: TrendLine | null; atrValue: number } {
  const at = atr(bars, STRATEGY_PARAMS.atrPeriod);
  const atrValue = last(at) ?? 0;
  const tolerance = atrValue * STRATEGY_PARAMS.lineToleranceAtr;
  return {
    support: findBestLine(bars, pivotLows(bars, STRATEGY_PARAMS.pivotStrength), true, bars.length, tolerance),
    resistance: findBestLine(bars, pivotHighs(bars, STRATEGY_PARAMS.pivotStrength), false, bars.length, tolerance),
    atrValue,
  };
}

/**
 * Long = break above resistance. Short = break below support. The opposing
 * trend line is required as the safety line and becomes the structure stop.
 */
export function evaluateSignal(coin: string, bars: Bar[]): Signal {
  const empty: Signal = { coin, side: null, confidence: 0, reasons: [], price: 0, atrValue: 0, indicators: {} };
  const minBars = Math.max(80, STRATEGY_PARAMS.pivotStrength * 2 + 20);
  if (bars.length < minBars) return empty;

  const closed = bars.slice(0, -1);
  const closes = bars.map(b => b.c);
  const vols = bars.map(b => b.v);
  const price = closes.at(-1)!;
  const previous = closes.at(-2)!;
  const at = atr(bars, STRATEGY_PARAMS.atrPeriod);
  const atrValue = last(at)!;
  const atrPct = (atrValue / price) * 100;
  const rs = rsi(closes, 14);
  const md = macd(closes);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const trend = sma(closes, 200);
  const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volX = last(vols)! / (avgVol || 1);
  const state = getTrendlineState(closed);
  const support = state.support;
  const resistance = state.resistance;
  const supportNow = support?.valueAt(closed.length);
  const resistanceNow = resistance?.valueAt(closed.length);
  const supportPrev = support?.valueAt(closed.length - 1);
  const resistancePrev = resistance?.valueAt(closed.length - 1);
  const rsiV = last(rs)!;
  const macdHist = last(md.hist)!;
  const indicators = {
    supportLine: supportNow ?? NaN,
    resistanceLine: resistanceNow ?? NaN,
    supportTouches: support?.touches ?? 0,
    resistanceTouches: resistance?.touches ?? 0,
    atrPct,
    rsi: rsiV,
    macdHist,
    ema20: last(e20)!,
    ema50: last(e50)!,
    sma200: last(trend)!,
    volX,
  };

  if (!isFinite(price) || !isFinite(atrValue) || atrPct < STRATEGY_PARAMS.atrMinPct || atrPct > STRATEGY_PARAMS.atrMaxPct) {
    return { ...empty, price, atrValue, indicators, reasons: [`ATR% ${atrPct.toFixed(2)} outside ${STRATEGY_PARAMS.atrMinPct}–${STRATEGY_PARAMS.atrMaxPct} band`] };
  }

  const brokeResistance = !!resistance && resistancePrev != null && resistanceNow != null && previous <= resistancePrev && price > resistanceNow;
  const brokeSupport = !!support && supportPrev != null && supportNow != null && previous >= supportPrev && price < supportNow;

  let side: "long" | "short" | null = null;
  let actionLine: number | undefined;
  let safetyLine: number | undefined;
  const reasons: string[] = [];

  if (brokeResistance && supportNow != null) {
    side = "long";
    actionLine = resistanceNow;
    safetyLine = supportNow;
    reasons.push(`Closed above descending resistance trend line (${resistanceNow.toFixed(6)})`, `Safety line is rising support (${supportNow.toFixed(6)})`, `${resistance.touches} resistance touches`);
  } else if (brokeSupport && resistanceNow != null) {
    side = "short";
    actionLine = supportNow;
    safetyLine = resistanceNow;
    reasons.push(`Closed below rising support trend line (${supportNow.toFixed(6)})`, `Safety line is falling resistance (${resistanceNow.toFixed(6)})`, `${support.touches} support touches`);
  }

  if (!side || safetyLine == null || !isFinite(safetyLine)) {
    return { ...empty, price, atrValue, indicators, reasons: ["No confirmed trend-line action break with an opposing safety line"] };
  }

  const momentumConfirmed = side === "long"
    ? price > e20.at(-1)! && e20.at(-1)! > e50.at(-1)! && macdHist > 0
    : price < e20.at(-1)! && e20.at(-1)! < e50.at(-1)! && macdHist < 0;
  if (momentumConfirmed) reasons.push("Momentum confirms the break");
  if (volX > 1.2) reasons.push(`Volume ${volX.toFixed(2)}x average`);
  reasons.push(`ATR ${atrPct.toFixed(2)}% volatility filter passed`);

  let confidence = 70;
  if (momentumConfirmed) confidence += 12;
  if (volX > 1.2) confidence += 8;
  if (side === "long" ? rsiV > 50 : rsiV < 50) confidence += 5;
  if (support?.touches >= 3 || resistance?.touches >= 3) confidence += 5;

  return { coin, side, confidence: Math.min(95, confidence), reasons, price, atrValue, indicators, actionLine, safetyLine };
}

const CORRELATION_BUCKETS: Record<string, string> = {
  BTC: "btc", ETH: "eth", SOL: "l1", AVAX: "l1", NEAR: "l1", APT: "l1", SUI: "l1", SEI: "l1", TIA: "l1", INJ: "l1",
  ARB: "l2", OP: "l2", MATIC: "l2", STRK: "l2", DOGE: "meme", SHIB: "meme", PEPE: "meme", WIF: "meme", BONK: "meme", FLOKI: "meme",
  LINK: "defi", UNI: "defi", AAVE: "defi", MKR: "defi", CRV: "defi", COMP: "defi",
};
export function bucket(coin: string): string { return CORRELATION_BUCKETS[coin] ?? "other"; }
