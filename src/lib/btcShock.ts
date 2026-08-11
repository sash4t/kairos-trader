const HL_INFO = "https://api.hyperliquid.xyz/info";

export type ShockDir = "up" | "down" | null;

interface Candle { t: number; o: string; c: string }

/**
 * Percentage move of BTC over the trailing `windowMin` minutes, measured on 1m
 * candles (open of the first candle in the window vs. the latest close).
 * Returns null when the feed is unavailable — callers must treat that as "no shock".
 */
export async function fetchBtcMovePct(windowMin: number): Promise<number | null> {
  try {
    const end = Date.now();
    const start = end - (Math.max(1, windowMin) + 2) * 60_000;
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: start, endTime: end } }),
    });
    if (!res.ok) return null;
    const candles = (await res.json()) as Candle[];
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const window = candles.slice(-Math.max(2, windowMin));
    const first = +window[0].o;
    const last = +window[window.length - 1].c;
    if (!first || !last) return null;
    return ((last - first) / first) * 100;
  } catch {
    return null;
  }
}

/** Direction of a BTC shock, or null when the move is inside the threshold. */
export function shockDirection(movePct: number | null, thresholdPct: number): ShockDir {
  if (movePct == null || !(thresholdPct > 0)) return null;
  if (movePct <= -thresholdPct) return "down";
  if (movePct >= thresholdPct) return "up";
  return null;
}

/** A BTC drop kills longs; a BTC spike kills shorts. */
export function shockHitsSide(dir: ShockDir, side: "long" | "short") {
  return (dir === "down" && side === "long") || (dir === "up" && side === "short");
}
