import { candlesToBars, bucket, type Bar } from "./strategy";
import { buildEntryIntent } from "./orderIntent";
import { evaluateScalpMulti, exitReasonFor, updateTrail, type ExitParams, type ScalpSignal } from "./scalp";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const INTERVAL = "1h";
const INTERVAL_MS = 60 * 60 * 1000;
const BARS = 230;
const HTF_BARS = 240;
const SCAN_PER_CYCLE = 35;
const MIN_24H_VOLUME = 100_000;

type Level = "info" | "warn" | "error" | "trade";
async function hl<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
  return (await res.json()) as T;
}
interface AssetMeta { name: string; szDecimals: number; maxLeverage: number }
interface AssetCtx { funding: string; openInterest: string; markPx: string; dayNtlVlm: string }
export interface CycleReport { users: number; closed: number; opened: number; vetoed: number; scanned: number; errors: string[] }
interface Settings {
  user_id: string; bot_enabled: boolean; kill_switch_engaged: boolean; server_agent_enabled: boolean;
  scalp_enabled: boolean; scalp_tp_pct: number; scalp_sl_pct: number;
  trail_activate_pct: number; trail_dist_pct: number; max_positions: number; max_leverage: number;
  position_size_pct: number; max_exposure_pct: number; daily_loss_pct: number; min_confidence: number;
  paper_equity: number; mode: string; live_max_alloc_usd: number; strategy_key?: string; tp_rr?: number;
  btc_shock_enabled?: boolean; btc_shock_pct?: number; btc_shock_window_min?: number;
  last_cycle_note?: string | null;
}
interface PositionRow { id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number; entry_price: number; stop_loss: number; take_profit: number; trail_high: number | null; confidence: number }

export async function runTradingCycle(): Promise<CycleReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: CycleReport = { users: 0, closed: 0, opened: 0, vetoed: 0, scanned: 0, errors: [] };
  const { data: users, error: settingsErr } = await supabaseAdmin.from("bot_settings").select("*").eq("server_agent_enabled", true).eq("bot_enabled", true).eq("kill_switch_engaged", false);
  if (settingsErr) throw new Error(settingsErr.message);
  if (!users || users.length === 0) return report;
  report.users = users.length;
  const log = async (userId: string, level: Level, message: string, meta?: unknown) => {
    const { error } = await supabaseAdmin.from("bot_events").insert({ user_id: userId, level, message, meta: meta === undefined ? null : (JSON.parse(JSON.stringify(meta)) as never) });
    if (error) report.errors.push(`log: ${error.message}`);
  };
  const mids = await hl<Record<string, string>>({ type: "allMids" });
  const [meta, ctxs] = await hl<[{ universe: AssetMeta[] }, AssetCtx[]]>({ type: "metaAndAssetCtxs" });
  const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
  const liquid = meta.universe.map((m, i) => ({ meta: m, ctx: ctxs[i] })).filter((x) => x.ctx && +x.ctx.dayNtlVlm > MIN_24H_VOLUME && !EXCLUDED_COINS.has(x.meta.name)).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);

  const { readHlCreds, loadAssetIndex, marketOrder, setLeverage, fetchLiveAccount } = await import("./hyperliquidExchange.server");
  const creds = readHlCreds();
  let assetIndex: Awaited<ReturnType<typeof loadAssetIndex>> | null = null;
  const assets = async () => (assetIndex ??= await loadAssetIndex());
  const barCache = new Map<string, Bar[]>();
  const loadBars = async (coin: string, interval: "1h" | "4h" | "1d", count: number): Promise<Bar[] | null> => {
    const key = `${coin}:${interval}`;
    if (barCache.has(key)) return barCache.get(key)!;
    try {
      const intervalMs = interval === "1h" ? 60 * 60 * 1000 : interval === "4h" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const end = Date.now();
      const candles = await hl<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - count * intervalMs, endTime: end } });
      const bars = candlesToBars(candles as never).slice(0, -1);
      barCache.set(key, bars);
      return bars;
    } catch { return null; }
  };

  const btcMoveCache = new Map<number, number | null>();
  const btcMove = async (windowMin: number) => {
    if (!btcMoveCache.has(windowMin)) btcMoveCache.set(windowMin, await fetchBtcMovePct(windowMin));
    return btcMoveCache.get(windowMin)!;
  };

  for (const raw of users) {
    const s = raw as unknown as Settings;
    const notes: string[] = [];
    try {
      const isLive = s.mode === "live";
      if (isLive && !creds) { notes.push("live mode on but API wallet not configured — no orders sent"); await log(s.user_id, "error", "Live mode is on but Hyperliquid API credentials are missing."); }
      let canTrade = !isLive || !!creds;
      const exits: ExitParams = { tpPct: +s.scalp_tp_pct, slPct: +s.scalp_sl_pct, trailActivatePct: +s.trail_activate_pct, trailDistPct: +s.trail_dist_pct };
      let shockDir: ShockDir = null; let shockMove: number | null = null;
      if (s.btc_shock_enabled !== false) {
        const win = Math.max(1, Math.round(+(s.btc_shock_window_min ?? 15)));
        shockMove = await btcMove(win);
        shockDir = shockDirection(shockMove, +(s.btc_shock_pct ?? 2.0));
        if (shockDir) { notes.push(`BTC shock ${shockDir} ${shockMove!.toFixed(2)}% / ${win}m`); await log(s.user_id, "warn", `BTC shock detected: ${shockMove!.toFixed(2)}% over ${win}m — flattening ${shockDir === "down" ? "longs" : "shorts"} and pausing opposing entries.`, { shockDir, shockMove, windowMin: win }); }
      }
      const { data: openRaw } = await supabaseAdmin.from("paper_positions").select("*").eq("user_id", s.user_id).eq("status", "open");
      let positions = (openRaw ?? []).map((p) => ({ id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional, leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss, take_profit: p.take_profit == null ? (p.side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : +p.take_profit, trail_high: p.trail_high == null ? null : +p.trail_high, confidence: +p.confidence })) as PositionRow[];
      let liveAcct: Awaited<ReturnType<typeof fetchLiveAccount>> | null = null;
      if (isLive && creds) {
        try { liveAcct = await fetchLiveAccount(creds.accountAddress); }
        catch (err) { canTrade = false; const msg = err instanceof Error ? err.message : String(err); notes.push(`live account read failed: ${msg}`); await log(s.user_id, "error", `Could not read Hyperliquid account — trading paused this cycle: ${msg}`); }
      }
      const equityNow = isLive && liveAcct ? liveAcct.equity : +s.paper_equity;
      const held = new Set(positions.map(p => p.coin));

      const eligibleCount = liquid.length;
      const match = s.last_cycle_note?.match(/scanner_cursor=(\d+)/);
      const cursor = eligibleCount ? Math.max(0, Math.min(Number(match?.[1] ?? 0), eligibleCount - 1)) : 0;
      const scanCount = Math.min(SCAN_PER_CYCLE, eligibleCount);
      const scanTargets = Array.from({ length: scanCount }, (_, i) => liquid[(cursor + i) % eligibleCount]);
      const nextCursor = eligibleCount ? (cursor + scanCount) % eligibleCount : 0;
      notes.push(`scanner ${scanCount}/${eligibleCount} pairs · cursor ${cursor}→${nextCursor}`);

      if (s.scalp_enabled && canTrade && equityNow > 0 && positions.length < +s.max_positions) {
        for (const target of scanTargets) {
          if (positions.length >= +s.max_positions) break;
          if (held.has(target.meta.name)) continue;
          const hourly = await loadBars(target.meta.name, "1h", BARS); report.scanned++; if (!hourly || hourly.length < 80) continue;
          const daily = await loadBars(target.meta.name, "1d", HTF_BARS);
          const fourHour = await loadBars(target.meta.name, "4h", HTF_BARS);
          if (!daily || !fourHour || daily.length < 80 || fourHour.length < 80) continue;
          const sig: ScalpSignal = evaluateScalpMulti(target.meta.name, { daily, fourHour, hourly });
          if (!sig.side || sig.confidence < +s.min_confidence) continue;
          if (shockHitsSide(shockDir, sig.side)) continue;
          const b = bucket(sig.coin); if (positions.filter((p) => bucket(p.coin) === b).length >= 3) continue;
          const liveCap = +(s.live_max_alloc_usd ?? 0); const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          const quotePx = mids[sig.coin] ? +mids[sig.coin] : sig.price;
          const intent = buildEntryIntent({ side: sig.side, price: quotePx, equity, positionSizePct: +s.position_size_pct, maxExposurePct: +s.max_exposure_pct, userMaxLeverage: +s.max_leverage, assetMaxLeverage: target.meta.maxLeverage, currentExposure: positions.reduce((sum, p) => sum + p.notional, 0), slPct: exits.slPct, tpPct: exits.tpPct });
          if (!intent.ok) { if (intent.reason === "exposure cap reached") { notes.push("exposure cap reached"); break; } continue; }
          const leverage = intent.leverage;
          const quote = quotePx; let entry = quote; let size = intent.size;
          const reason = `${sig.side.toUpperCase()} ${sig.coin} [${sig.family}] — ${sig.reasons.join(" + ")}`;
          if (isLive && creds) { const asset = (await assets()).get(sig.coin); if (!asset) { report.errors.push(`${sig.coin}: unknown asset`); continue; } size = Number(size.toFixed(asset.szDecimals)); if (size <= 0) { await log(s.user_id, "warn", `Skipped ${sig.coin}: order size rounds to zero at ${asset.szDecimals} decimals.`); continue; } try { await setLeverage(creds, asset, leverage); const fill = await marketOrder(creds, asset, { isBuy: sig.side === "long", size, markPrice: quote, reduceOnly: false, slippagePct: 1 }); if (fill.size <= 0) { await log(s.user_id, "warn", `Live entry for ${sig.coin} did not fill.`); continue; } entry = fill.avgPrice || quote; size = fill.size; } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`open ${sig.coin}: ${msg}`); await log(s.user_id, "error", `Live entry failed for ${sig.coin}: ${msg}`); continue; } }
          const sl = sig.side === "long" ? entry * (1 - exits.slPct / 100) : entry * (1 + exits.slPct / 100);
          const tp = sig.side === "long" ? entry * (1 + exits.tpPct / 100) : entry * (1 - exits.tpPct / 100);
          const { error: insErr } = await supabaseAdmin.from("paper_positions").insert({ user_id: s.user_id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, confidence: sig.confidence, reason, indicators: sig.indicators });
          if (insErr) { report.errors.push(`record ${sig.coin}: ${insErr.message}`); continue; }
          positions.push({ id: crypto.randomUUID(), coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, trail_high: entry, confidence: sig.confidence }); held.add(sig.coin); report.opened++;
          await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}OPEN ${sig.side.toUpperCase()} ${sig.coin} @ ${entry.toFixed(6)} · size ${size} · ${reason}`, { agent: "server", live: isLive, signal: sig });
        }
      }
      const note = notes.length ? notes.join(" · ") + ` · scanner_cursor=${nextCursor}` : `cycle complete · scanner_cursor=${nextCursor}`;
      await supabaseAdmin.from("bot_settings").update({ last_cycle_at: new Date().toISOString(), last_cycle_note: note }).eq("user_id", s.user_id);
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`${s.user_id}: ${msg}`); await log(s.user_id, "error", `Trading cycle failed: ${msg}`); }
  }
  return report;
}
