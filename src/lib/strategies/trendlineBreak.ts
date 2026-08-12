/**
 * Trendline Price Action / Trendline Break strategy.
 * Pure price action: chained trendlines, action-line breaks and opposing
 * safety-line trailing stops. No indicator is required for an entry.
 */
import type { Bar } from "../strategy";

export const TRENDLINE_BREAK_KEY = "trendline-break" as const;
export const TB_TIMEFRAMES = ["1w", "1d", "4h", "1h", "30m", "15m"] as const;
export type TbTimeframe = (typeof TB_TIMEFRAMES)[number];

export const TB_DEFAULTS = {
  timeframes: ["1w", "1d", "4h", "1h", "30m", "15m"] as TbTimeframe[],
  pivotStrength: 3,
  riskPct: 1,
  positionSizePct: 5,
  refreshMin: 15,
};

export const TB_INTERVAL_MS: Record<TbTimeframe, number> = {
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "15m": 15 * 60 * 1000,
};

export function parseTimeframes(raw: string | null | undefined): TbTimeframe[] {
  const list = (raw ?? "").split(",").map((t) => t.trim()).filter((t): t is TbTimeframe => (TB_TIMEFRAMES as readonly string[]).includes(t));
  const unique = [...new Set(list)];
  const ordered = TB_TIMEFRAMES.filter((t) => unique.includes(t));
  return ordered.length >= 2 ? [...ordered] : [...TB_DEFAULTS.timeframes];
}

export type LineKind = "up" | "down";
export interface TbLine {
  kind: LineKind;
  i1: number; t1: number; p1: number;
  i2: number; t2: number; p2: number;
  slope: number;
  touches: number;
  valueAt: (i: number) => number;
}
interface Pivot { i: number; t: number; p: number }

function swingLows(bars: Bar[], strength: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (bars[i].l > bars[i - j].l || bars[i].l > bars[i + j].l) { ok = false; break; }
    }
    if (ok) out.push({ i, t: bars[i].t, p: bars[i].l });
  }
  return out;
}

function swingHighs(bars: Bar[], strength: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    let ok = true;
    for (let j = 1; j <= strength; j++) {
      if (bars[i].h < bars[i - j].h || bars[i].h < bars[i + j].h) { ok = false; break; }
    }
    if (ok) out.push({ i, t: bars[i].t, p: bars[i].h });
  }
  return out;
}

function tolerance(bars: Bar[]): number {
  const span = bars.slice(-100);
  const avg = span.reduce((s, b) => s + (b.h - b.l), 0) / Math.max(1, span.length);
  return avg * 0.25;
}

function fitSegment(bars: Bar[], a: Pivot, b: Pivot, kind: LineKind, tol: number): TbLine | null {
  if (b.i <= a.i) return null;
  const slope = (b.p - a.p) / (b.i - a.i);
  if (kind === "up" ? slope <= 0 : slope >= 0) return null;
  const valueAt = (i: number) => a.p + slope * (i - a.i);
  let touches = 0;
  for (let i = a.i; i <= b.i; i++) {
    const line = valueAt(i);
    if (kind === "up" ? bars[i].c < line - tol : bars[i].c > line + tol) return null;
    const distance = kind === "up" ? bars[i].l - line : line - bars[i].h;
    if (Math.abs(distance) <= tol) touches++;
  }
  return { kind, i1: a.i, t1: a.t, p1: a.p, i2: b.i, t2: b.t, p2: b.p, slope, touches, valueAt };
}

export function buildChain(bars: Bar[], kind: LineKind, pivotStrength: number, startTime?: number): TbLine[] {
  if (bars.length < pivotStrength * 3 + 5) return [];
  const pivots = kind === "up" ? swingLows(bars, pivotStrength) : swingHighs(bars, pivotStrength);
  let pool = startTime ? pivots.filter((p) => p.t >= startTime) : pivots;
  if (pool.length < 2) pool = pivots;
  if (pool.length < 2) return [];
  let anchor = pool[0];
  for (const p of pool) if (kind === "up" ? p.p < anchor.p : p.p > anchor.p) anchor = p;
  const tol = tolerance(bars);
  const chain: TbLine[] = [];
  let a = anchor;
  for (let guard = 0; guard < 32; guard++) {
    let best: TbLine | null = null;
    for (const b of pool) {
      if (b.i <= a.i) continue;
      const seg = fitSegment(bars, a, b, kind, tol);
      if (!seg) continue;
      if (!best || seg.touches > best.touches || (seg.touches === best.touches && seg.i2 > best.i2)) best = seg;
    }
    if (!best) break;
    chain.push(best);
    a = { i: best.i2, t: best.t2, p: best.p2 };
  }
  return chain;
}

export interface TbLineState {
  timeframe: TbTimeframe;
  kind: LineKind;
  line: TbLine | null;
  value: number | null;
  broken: boolean;
  freshBreak: boolean;
  brokenAt?: number;
  endTime?: number;
}

export function analyzeLine(bars: Bar[], kind: LineKind, pivotStrength: number, timeframe: TbTimeframe, startTime?: number): TbLineState {
  const chain = buildChain(bars, kind, pivotStrength, startTime);
  const line = chain.at(-1) ?? null;
  if (!line) return { timeframe, kind, line: null, value: null, broken: false, freshBreak: false };
  const tol = tolerance(bars);
  const pierced = (i: number) => {
    const v = line.valueAt(i);
    return kind === "up" ? bars[i].c < v - tol : bars[i].c > v + tol;
  };
  let broken = false;
  let brokenAt: number | undefined;
  for (let i = line.i2 + 1; i < bars.length; i++) {
    if (pierced(i)) { broken = true; brokenAt = bars[i].t; break; }
  }
  const last = bars.length - 1;
  const freshBreak = last > line.i2 && pierced(last) && (last - 1 <= line.i2 || !pierced(last - 1));
  return { timeframe, kind, line, value: line.valueAt(last), broken, freshBreak, brokenAt, endTime: line.t2 };
}

export interface TbCascadeLevel { timeframe: TbTimeframe; up: TbLineState; down: TbLineState }
export type TbSeries = Partial<Record<TbTimeframe, Bar[]>>;

export function buildCascade(series: TbSeries, timeframes: TbTimeframe[], pivotStrength: number): TbCascadeLevel[] {
  const levels: TbCascadeLevel[] = [];
  let upSeed: number | undefined;
  let downSeed: number | undefined;
  for (const tf of timeframes) {
    const bars = series[tf];
    if (!bars || bars.length < 30) continue;
    const up = analyzeLine(bars, "up", pivotStrength, tf, upSeed);
    const down = analyzeLine(bars, "down", pivotStrength, tf, downSeed);
    upSeed = up.endTime ?? upSeed;
    downSeed = down.endTime ?? downSeed;
    levels.push({ timeframe: tf, up, down });
  }
  return levels;
}

export interface TbSignal {
  coin: string;
  side: "long" | "short" | null;
  confidence: number;
  reasons: string[];
  price: number;
  timeframe?: TbTimeframe;
  actionLine?: number;
  safetyLine?: number;
  indicators: Record<string, number>;
  levels: TbCascadeLevel[];
}

export interface TbConfig {
  timeframes: TbTimeframe[];
  pivotStrength: number;
  riskPct: number;
  positionSizePct?: number;
}

export function evaluateTrendlineBreak(coin: string, series: TbSeries, cfg: TbConfig): TbSignal {
  const levels = buildCascade(series, cfg.timeframes, cfg.pivotStrength);
  const exec = levels.at(-1);
  const execBars = exec ? series[exec.timeframe] : undefined;
  const price = execBars?.at(-1)?.c ?? 0;
  const base: TbSignal = { coin, side: null, confidence: 0, reasons: [], price, indicators: {}, levels };
  if (!exec || !execBars) return { ...base, reasons: ["Waiting for weekly-to-execution trendline history"] };
  const indicators: Record<string, number> = {
    execUpLine: exec.up.value ?? NaN,
    execDownLine: exec.down.value ?? NaN,
    upTouches: exec.up.line?.touches ?? 0,
    downTouches: exec.down.line?.touches ?? 0,
  };
  let side: "long" | "short" | null = null;
  let actionLine: number | undefined;
  let safety: number | undefined;
  const reasons: string[] = [];
  if (exec.down.freshBreak && exec.down.value != null) {
    side = "long"; actionLine = exec.down.value; safety = safetyLineFor(levels, "long", price);
    reasons.push(`${exec.timeframe} close above bearish trendline — LONG action-line break`);
  } else if (exec.up.freshBreak && exec.up.value != null) {
    side = "short"; actionLine = exec.up.value; safety = safetyLineFor(levels, "short", price);
    reasons.push(`${exec.timeframe} close below bullish trendline — SHORT action-line break`);
  } else {
    return { ...base, indicators, reasons: [`No ${exec.timeframe} action-line break`] };
  }
  if (safety == null) return { ...base, indicators, reasons: ["Break detected but no valid opposing safety line is available"] };
  let agree = 0;
  for (const lvl of levels.slice(0, -1)) {
    const intact = side === "long" ? !!lvl.up.line && !lvl.up.broken : !!lvl.down.line && !lvl.down.broken;
    if (intact) { agree++; reasons.push(`${lvl.timeframe} opposing trend structure remains intact`); }
  }
  const touches = side === "long" ? exec.down.line?.touches ?? 0 : exec.up.line?.touches ?? 0;
  reasons.push(`Action line captured ${touches} touch points`);
  const confidence = Math.min(95, 60 + Math.min(touches, 5) * 5 + agree * 8);
  return { coin, side, confidence, reasons, price, timeframe: exec.timeframe, actionLine, safetyLine: safety, indicators: { ...indicators, agree, touches }, levels };
}

export function safetyLineFor(levels: TbCascadeLevel[], side: "long" | "short", price: number): number | undefined {
  for (let i = levels.length - 1; i >= 0; i--) {
    const state = side === "long" ? levels[i].up : levels[i].down;
    const v = state.value;
    if (v == null || !Number.isFinite(v)) continue;
    if (side === "long" ? v < price : v > price) return v;
  }
  return undefined;
}

export function safetyStop(side: "long" | "short", safetyLine: number, bufferPct = 0.15): number {
  return side === "long" ? safetyLine * (1 - bufferPct / 100) : safetyLine * (1 + bufferPct / 100);
}

/**
 * Dynamic price trail used as the profit-taking layer after a favorable move.
 * It never loosens: long stops only rise and short stops only fall.
 */
export function dynamicTrailStop(
  side: "long" | "short",
  entryPrice: number,
  bestPrice: number,
  currentStop: number,
  activatePct = 1,
  distancePct = 0.5,
): number {
  if (!(entryPrice > 0) || !(bestPrice > 0) || !(currentStop > 0)) return currentStop;
  const favorablePct = side === "long"
    ? ((bestPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - bestPrice) / entryPrice) * 100;
  if (favorablePct < Math.max(0, activatePct)) return currentStop;
  const candidate = side === "long"
    ? bestPrice * (1 - Math.max(0.05, distancePct) / 100)
    : bestPrice * (1 + Math.max(0.05, distancePct) / 100);
  return side === "long" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

export function riskSize(equity: number, riskPct: number, entry: number, stop: number): number {
  const distance = Math.abs(entry - stop);
  if (!(equity > 0) || !(riskPct > 0) || !(distance > 0)) return 0;
  return (equity * (riskPct / 100)) / distance;
}

export function positionSizeCap(equity: number, positionSizePct: number, leverage: number, entry: number): number {
  if (!(equity > 0) || !(positionSizePct > 0) || !(leverage > 0) || !(entry > 0)) return 0;
  return (equity * (positionSizePct / 100) * leverage) / entry;
}

export function trailToSafety(side: "long" | "short", currentStop: number, safetyLine: number, bufferPct = 0.15): number {
  const candidate = safetyStop(side, safetyLine, bufferPct);
  return side === "long" ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

export function safetyBreached(side: "long" | "short", price: number, safetyLine: number): boolean {
  return side === "long" ? price < safetyLine : price > safetyLine;
}
