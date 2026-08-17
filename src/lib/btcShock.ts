const HL_INFO = "https://api.hyperliquid.xyz/info";

export type ShockDir = "up" | "down" | null;
export type BtcProtectionLevel = "normal" | "caution" | "protect" | "exit";
export type BtcProtectionWindow = 5 | 15 | 60 | 240;

interface Candle { t: number; o: string; h?: string; l?: string; c: string }

export interface BtcProtectionState {
  level: BtcProtectionLevel;
  dir: ShockDir;
  triggerWindowMin: BtcProtectionWindow | null;
  triggerMovePct: number | null;
  moves: Record<BtcProtectionWindow, number | null>;
}

export const BTC_PROTECTION_RULES = [
  { windowMin: 5 as const, thresholdPct: 1.0, level: "caution" as const },
  { windowMin: 15 as const, thresholdPct: 1.5, level: "protect" as const },
  { windowMin: 60 as const, thresholdPct: 2.0, level: "exit" as const },
  { windowMin: 240 as const, thresholdPct: 2.0, level: "exit" as const },
];

function largestMovePct(candles: Candle[], minutes: number): number | null {
  const window = candles.slice(-Math.max(2, Math.round(minutes)));
  if (window.length < 2) return null;
  const last = +window.at(-1)!.c;
  if (!(last > 0)) return null;

  let peak = +window[0].o;
  let trough = +window[0].o;
  let largestDown = 0;
  let largestUp = 0;

  for (const candle of window) {
    const high = Number(candle.h ?? candle.c);
    const low = Number(candle.l ?? candle.c);
    if (peak > 0) largestDown = Math.min(largestDown, ((low - peak) / peak) * 100);
    if (trough > 0) largestUp = Math.max(largestUp, ((high - trough) / trough) * 100);
    peak = Math.max(peak, high);
    trough = Math.min(trough, low);
  }

  if (peak > 0) largestDown = Math.min(largestDown, ((last - peak) / peak) * 100);
  if (trough > 0) largestUp = Math.max(largestUp, ((last - trough) / trough) * 100);
  return Math.abs(largestDown) >= largestUp ? largestDown : largestUp;
}

async function fetchBtcCandles(minutes: number): Promise<Candle[] | null> {
  try {
    const end = Date.now();
    const start = end - (Math.max(2, Math.round(minutes)) + 2) * 60_000;
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: start, endTime: end } }),
    });
    if (!res.ok) return null;
    const candles = (await res.json()) as Candle[];
    return Array.isArray(candles) && candles.length >= 2 ? candles : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the largest signed BTC move inside an arbitrary trailing window.
 * Negative = downside shock, positive = upside shock.
 */
export async function fetchBtcMovePct(windowMin: number): Promise<number | null> {
  const candles = await fetchBtcCandles(windowMin);
  return candles ? largestMovePct(candles, windowMin) : null;
}

/**
 * Multi-speed protection:
 * 5m >= 1.0%  -> caution: veto new positions that fight BTC
 * 15m >= 1.5% -> protect: keep vetoing opposing entries
 * 60m >= 2.0% -> exit: close opposing positions
 * 4h >= 2.0%  -> exit: close opposing positions even when the move was gradual
 */
export async function fetchBtcProtection(): Promise<BtcProtectionState> {
  const candles = await fetchBtcCandles(240);
  const empty: BtcProtectionState = {
    level: "normal",
    dir: null,
    triggerWindowMin: null,
    triggerMovePct: null,
    moves: { 5: null, 15: null, 60: null, 240: null },
  };
  if (!candles) return empty;

  const moves: BtcProtectionState["moves"] = {
    5: largestMovePct(candles, 5),
    15: largestMovePct(candles, 15),
    60: largestMovePct(candles, 60),
    240: largestMovePct(candles, 240),
  };

  let state = empty;
  const rank: Record<BtcProtectionLevel, number> = { normal: 0, caution: 1, protect: 2, exit: 3 };
  for (const rule of BTC_PROTECTION_RULES) {
    const move = moves[rule.windowMin];
    if (move == null || Math.abs(move) < rule.thresholdPct) continue;
    const dir: ShockDir = move > 0 ? "up" : "down";
    if (
      rank[rule.level] > rank[state.level]
      || (rank[rule.level] === rank[state.level] && Math.abs(move) > Math.abs(state.triggerMovePct ?? 0))
    ) {
      state = { level: rule.level, dir, triggerWindowMin: rule.windowMin, triggerMovePct: move, moves };
    }
  }
  return state.level === "normal" ? { ...empty, moves } : state;
}

export function shockDirection(movePct: number | null, thresholdPct: number): ShockDir {
  if (movePct == null || !(thresholdPct > 0)) return null;
  if (movePct <= -thresholdPct) return "down";
  if (movePct >= thresholdPct) return "up";
  return null;
}

/** A BTC drop hurts longs; a BTC spike hurts shorts. */
export function shockHitsSide(dir: ShockDir, side: "long" | "short") {
  return (dir === "down" && side === "long") || (dir === "up" && side === "short");
}
