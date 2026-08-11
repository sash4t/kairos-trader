const HL_INFO = "https://api.hyperliquid.xyz/info";

export type ShockDir = "up" | "down" | null;
interface Candle { t: number; o: string; h?: string; l?: string; c: string }

/**
 * Detect the largest adverse BTC move that has occurred within the trailing
 * window. Unlike an open-to-close calculation, this catches a 1.5% move that
 * occurs in 15m, 1h, 2h, 3h or 4h even if the move did not start at the window
 * boundary. One-minute candles are used so callers can poll this frequently.
 * The result is signed: negative = downside shock, positive = upside shock.
 */
export async function fetchBtcMovePct(windowMin: number): Promise<number | null> {
  try {
    const minutes = Math.max(2, Math.round(windowMin));
    const end = Date.now();
    const start = end - (minutes + 2) * 60_000;
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: start, endTime: end } }),
    });
    if (!res.ok) return null;
    const candles = (await res.json()) as Candle[];
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const window = candles.slice(-minutes);
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

    // Also evaluate the current close against the highest/lowest prices seen.
    if (peak > 0) largestDown = Math.min(largestDown, ((last - peak) / peak) * 100);
    if (trough > 0) largestUp = Math.max(largestUp, ((last - trough) / trough) * 100);
    return Math.abs(largestDown) >= largestUp ? largestDown : largestUp;
  } catch {
    return null;
  }
}

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
