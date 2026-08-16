import { candlesToBars, bucket, type Bar } from "./strategy";
import { buildEntryIntent } from "./orderIntent";
import { clampMaxPositions, evaluateScalpMulti, type ExitParams, type ScalpSignal } from "./scalp";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";
import {
  TRENDLINE_BREAK_KEY, TB_INTERVAL_MS, parseTimeframes, buildCascade, evaluateTrendlineBreak,
  safetyLineFor, riskSize, trailToSafety, dynamicTrailStop, safetyStop, TB_SAFETY_BUFFER_PCT, TB_MIN_STOP_PCT, TB_DEFAULTS,
  type TbTimeframe, type TbSeries,
} from "./strategies/trendlineBreak";
import {
  ORIGINAL_TREND_PRICE_ACTION_KEY, ORIGINAL_TPA_DEFAULTS, evaluateOriginalTrendPriceAction,
} from "./strategies/originalTrendPriceAction";
import { targetFromR } from "./strategies/intradayMomentumPullback";
import {
  VOLATILITY_SQUEEZE_BREAKOUT_KEY, SQUEEZE_DEFAULTS, evaluateVolatilitySqueezeBreakout,
  favorablePct as squeezeFavorablePct, adverseAbsPct, squeezeTrailStop,
} from "./strategies/volatilitySqueezeBreakout";
import {
  RSI_EXTREMES_KEY, RSI_EXTREMES_DEFAULTS, evaluateRsiExtremes, latestRsi,
  rsiTakeProfitHit, rsiTakeProfitPrice, updateRsiExitTrail,
} from "./strategies/rsiExtremes";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const BARS = 230;
const HTF_BARS = 240;
const SCAN_PER_CYCLE = 35;
const SCAN_PER_CYCLE_ORIGINAL_TPA = 50;
const MIN_24H_VOLUME = 500_000;

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
  paper_equity: number; mode: string; live_max_alloc_usd: number; strategy_key?: string; tp_rr?: number; trendline_risk_pct?: number;
  btc_shock_enabled?: boolean; btc_shock_pct?: number; btc_shock_window_min?: number;
  tb_timeframes?: string; tb_pivot_strength?: number; tb_risk_pct?: number; tb_position_size_pct?: number; tb_refresh_min?: number;
  last_cycle_at?: string | null; last_cycle_note?: string | null; squeeze_last_scan_at?: string | null; rsi_last_scan_at?: string | null;
}
interface PositionRow {
  id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number;
  entry_price: number; stop_loss: number; take_profit: number; trail_high: number | null; confidence: number;
  initial_stop?: number; safety_line?: number | null; opened_at?: string; reason?: string;
  partial_taken?: boolean; realized_pnl?: number; indicators?: Record<string, number>;
}

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
  const allMarkets = meta.universe.map((m, i) => ({ meta: m, ctx: ctxs[i] })).filter((x) => x.ctx);
  const liquid = allMarkets.filter((x) => +x.ctx.dayNtlVlm > MIN_24H_VOLUME && !EXCLUDED_COINS.has(x.meta.name)).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);
  const rsiLiquid = allMarkets.filter((x) => +x.ctx.dayNtlVlm > MIN_24H_VOLUME).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);

  const { readHlCreds, loadAssetIndex, marketOrder, setLeverage, fetchLiveAccount, ensureNativeStopLoss, ensureNativeTakeProfit } = await import("./hyperliquidExchange.server");
  const creds = readHlCreds();
  let assetIndex: Awaited<ReturnType<typeof loadAssetIndex>> | null = null;
  const assets = async () => (assetIndex ??= await loadAssetIndex());
  const barCache = new Map<string, Bar[]>();
  const loadBars = async (coin: string, interval: "15m" | "1h" | "4h" | "1d" | TbTimeframe, count: number): Promise<Bar[] | null> => {
    const key = `${coin}:${interval}`;
    if (barCache.has(key)) return barCache.get(key)!;
    try {
      const intervalMs = interval === "15m" ? 15 * 60 * 1000 : (TB_INTERVAL_MS[interval as TbTimeframe] ?? 60 * 60 * 1000);
      const end = Date.now();
      const candles = await hl<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - count * intervalMs, endTime: end } });
      const bars = candlesToBars(candles as never).slice(0, -1);
      barCache.set(key, bars);
      return bars;
    } catch { return null; }
  };

  for (const raw of users) {
    const s = raw as unknown as Settings;
    const notes: string[] = [];
    try {
      const isLive = s.mode === "live";
      if (isLive && !creds) { notes.push("live mode on but API wallet not configured — no orders sent"); await log(s.user_id, "error", "Live mode is on but Hyperliquid API credentials are missing."); }
      let canTrade = !isLive || !!creds;
      const hardSlPct = Number.isFinite(+(s.scalp_sl_pct ?? 0)) && +(s.scalp_sl_pct ?? 0) > 0 ? +(s.scalp_sl_pct ?? 0) : 1;
      const trailActivatePct = Number.isFinite(+(s.trail_activate_pct ?? 0)) && +(s.trail_activate_pct ?? 0) > 0 ? +(s.trail_activate_pct ?? 0) : 1;
      const trailDistPct = Number.isFinite(+(s.trail_dist_pct ?? 0)) && +(s.trail_dist_pct ?? 0) > 0 ? +(s.trail_dist_pct ?? 0) : 0.5;
      const exits: ExitParams = { tpPct: +s.scalp_tp_pct, slPct: hardSlPct, trailActivatePct, trailDistPct };
      const shockWindow = Math.max(1, Math.round(+(s.btc_shock_window_min ?? 240)));
      let shockDir: ShockDir = null; let shockMove: number | null = null;
      if (s.btc_shock_enabled !== false) {
        shockMove = await fetchBtcMovePct(shockWindow);
        shockDir = shockDirection(shockMove, +(s.btc_shock_pct ?? 1.5));
        if (shockDir) {
          notes.push(`BTC shock ${shockDir} ${shockMove!.toFixed(2)}% / ${shockWindow}m`);
          await log(s.user_id, "warn", `BTC shock detected: ${shockMove!.toFixed(2)}% within ${shockWindow}m — flattening ${shockDir === "down" ? "longs" : "shorts"} and pausing opposing entries.`, { shockDir, shockMove, windowMin: shockWindow });
        }
      }

      const { data: openRaw } = await supabaseAdmin.from("paper_positions").select("*").eq("user_id", s.user_id).eq("status", "open");
      let positions = (openRaw ?? []).map((p) => ({
        id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional,
        leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss,
        take_profit: p.take_profit == null ? (p.side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : +p.take_profit,
        trail_high: p.trail_high == null ? null : +p.trail_high, confidence: +p.confidence,
        initial_stop: p.initial_stop == null ? +p.stop_loss : +p.initial_stop,
        safety_line: p.safety_line == null ? null : +p.safety_line,
        opened_at: p.opened_at,
        reason: p.reason,
        partial_taken: Boolean((p as any).partial_taken),
        realized_pnl: p.pnl == null ? 0 : +p.pnl,
        indicators: (p.indicators ?? {}) as Record<string, number>,
      })) as PositionRow[];
      const isSqueezePosition = (p: PositionRow) => p.reason?.includes(`[${VOLATILITY_SQUEEZE_BREAKOUT_KEY}]`) === true;
      const isRsiPosition = (p: PositionRow) => p.reason?.includes(`[${RSI_EXTREMES_KEY}]`) === true;
      let liveAcct: Awaited<ReturnType<typeof fetchLiveAccount>> | null = null;
      if (isLive && creds) {
        try {
          liveAcct = await fetchLiveAccount(creds.accountAddress);
          const liveKeys = new Set(liveAcct.positions.map((p) => `${p.coin}:${p.side}`));
          const stale = positions.filter((p) => !liveKeys.has(`${p.coin}:${p.side}`));
          for (const p of stale) {
            const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
            const remainingPnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
            const pnl = (p.realized_pnl ?? 0) + remainingPnl;
            await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: "exchange_already_closed", pnl, closed_at: new Date().toISOString() }).eq("id", p.id).eq("status", "open");
            await log(s.user_id, "info", `Reconciled ${p.coin}: exchange position is already closed; removed stale local open position.`);
          }
          if (stale.length) positions = positions.filter((p) => liveKeys.has(`${p.coin}:${p.side}`));
        } catch (err) {
          canTrade = false;
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`live account read failed: ${msg}`);
          await log(s.user_id, "error", `Could not read Hyperliquid account — trading paused this cycle: ${msg}`);
        }
      }
      const equityNow = isLive && liveAcct ? liveAcct.accountValue : +s.paper_equity;
      const held = new Set(positions.map(p => p.coin));

      const isTb = (s.strategy_key ?? "") === TRENDLINE_BREAK_KEY;
      const isOriginalTpa = (s.strategy_key ?? "") === ORIGINAL_TREND_PRICE_ACTION_KEY;
      const isSqueeze = (s.strategy_key ?? "") === VOLATILITY_SQUEEZE_BREAKOUT_KEY;
      const isRsi = (s.strategy_key ?? "") === RSI_EXTREMES_KEY;
      const maxPositions = clampMaxPositions(+s.max_positions);
      const squeezeLastScanMs = s.squeeze_last_scan_at ? Date.parse(s.squeeze_last_scan_at) : 0;
      const squeezeScanDue = isSqueeze && (!Number.isFinite(squeezeLastScanMs) || Date.now() - squeezeLastScanMs >= SQUEEZE_DEFAULTS.scanEveryMs);
      const rsiLastScanMs = s.rsi_last_scan_at ? Date.parse(s.rsi_last_scan_at) : 0;
      const rsiScanDue = isRsi && (!Number.isFinite(rsiLastScanMs) || Date.now() - rsiLastScanMs >= RSI_EXTREMES_DEFAULTS.scanEveryMs);
      const originalRiskPct = Math.min(5, Math.max(0.05, +(s.trendline_risk_pct ?? ORIGINAL_TPA_DEFAULTS.riskPct)));
      const tbCfg = {
        timeframes: parseTimeframes(s.tb_timeframes),
        pivotStrength: Math.round(+(s.tb_pivot_strength ?? 3)),
        riskPct: +(s.tb_risk_pct ?? TB_DEFAULTS.riskPct),
        positionSizePct: +(s.tb_position_size_pct ?? s.position_size_pct ?? 5),
      };

      for (const p of positions) {
        if (isTb || isSqueezePosition(p) || isRsiPosition(p)) continue;
        const hardStop = p.side === "long"
          ? p.entry_price * (1 - hardSlPct / 100)
          : p.entry_price * (1 + hardSlPct / 100);
        const best = p.trail_high ?? p.entry_price;
        const favorable = p.side === "long"
          ? ((best - p.entry_price) / p.entry_price) * 100
          : ((p.entry_price - best) / p.entry_price) * 100;
        const profitProtectionActive = favorable >= trailActivatePct;
        if (!profitProtectionActive) {
          const stopDiff = Math.abs(p.stop_loss - hardStop) / p.entry_price * 100;
          const initialDiff = Math.abs((p.initial_stop ?? p.stop_loss) - hardStop) / p.entry_price * 100;
          if (stopDiff > 0.0001 || initialDiff > 0.0001) {
            p.stop_loss = hardStop;
            p.initial_stop = hardStop;
            await supabaseAdmin.from("paper_positions").update({ stop_loss: hardStop, initial_stop: hardStop }).eq("id", p.id).eq("status", "open");
            await log(s.user_id, "info", `Normalized ${p.coin} hard SL to ${hardSlPct.toFixed(2)}% @ ${hardStop.toFixed(6)}.`);
          }
        }
      }

      const loadTbSeries = async (coin: string): Promise<TbSeries> => {
        const series: TbSeries = {};
        for (const tf of tbCfg.timeframes) {
          const bars = await loadBars(coin, tf, 300);
          if (bars && bars.length >= 30) series[tf] = bars;
        }
        return series;
      };
      const closeTbPosition = async (p: PositionRow, mark: number, exitReason: string) => {
        if (isLive && creds) {
          const asset = (await assets()).get(p.coin);
          if (!asset) { report.errors.push(`${p.coin}: unknown asset on close`); return; }
          try {
            const before = await fetchLiveAccount(creds.accountAddress);
            const current = before.positions.find((x) => x.coin === p.coin && x.side === p.side);
            if (!current || current.size <= 0) {
              const remainingPnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
              const pnl = (p.realized_pnl ?? 0) + remainingPnl;
              await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: "exchange_already_closed", pnl, closed_at: new Date().toISOString() }).eq("id", p.id).eq("status", "open");
              positions = positions.filter((x) => x.id !== p.id);
              held.delete(p.coin);
              report.closed++;
              await log(s.user_id, "info", `${p.coin} was already closed on Hyperliquid; reconciled local record without sending another reduce-only order.`);
              return;
            }

            let remainingTarget = current.size;
            let tries = 0;
            let lastMark = mark;
            while (remainingTarget > Math.max(10 ** -(asset.szDecimals + 1), current.size * 0.0001) && tries < 3) {
              const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: remainingTarget, markPrice: lastMark, reduceOnly: true, slippagePct: 2 });
              tries++;
              if (fill.size <= 0) break;
              const after = await fetchLiveAccount(creds.accountAddress);
              const remaining = after.positions.find((x) => x.coin === p.coin && x.side === p.side);
              if (!remaining) { remainingTarget = 0; break; }
              remainingTarget = remaining.size;
              lastMark = mids[p.coin] ? +mids[p.coin] : remaining.entryPrice;
            }
            if (remainingTarget > Math.max(10 ** -(asset.szDecimals + 1), current.size * 0.0001)) {
              await supabaseAdmin.from("paper_positions").update({ size: remainingTarget, notional: remainingTarget * lastMark }).eq("id", p.id).eq("status", "open");
              p.size = remainingTarget; p.notional = remainingTarget * lastMark;
              await log(s.user_id, "error", `URGENT: ${p.coin} stop triggered but ${remainingTarget} remains after 3 reduce-only close attempts.`);
              report.errors.push(`${p.coin}: stop triggered but ${remainingTarget} remains after retry`);
              return;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/reduce only order would increase position/i.test(msg)) {
              try {
                const after = await fetchLiveAccount(creds.accountAddress);
                const stillOpen = after.positions.find((x) => x.coin === p.coin && x.side === p.side);
                if (!stillOpen || stillOpen.size <= 0) {
                  const remainingPnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
                  const pnl = (p.realized_pnl ?? 0) + remainingPnl;
                  await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: "exchange_already_closed", pnl, closed_at: new Date().toISOString() }).eq("id", p.id).eq("status", "open");
                  positions = positions.filter((x) => x.id !== p.id);
                  held.delete(p.coin);
                  report.closed++;
                  await log(s.user_id, "info", `${p.coin} close skipped because Hyperliquid reports no matching live position; reconciled local record.`);
                  return;
                }
              } catch {}
            }
            report.errors.push(`close ${p.coin}: ${msg}`);
            await log(s.user_id, "error", `Failed to close ${p.coin}: ${msg}`);
            return;
          }
        }
        const remainingPnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
        const pnl = (p.realized_pnl ?? 0) + remainingPnl;
        await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: exitReason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id).eq("status", "open");
        positions = positions.filter((x) => x.id !== p.id);
        held.delete(p.coin);
        report.closed++;
        await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${mark.toFixed(6)} · ${exitReason} · PnL ${pnl.toFixed(2)}`, { strategy: p.reason?.includes("[") ? p.reason : (s.strategy_key ?? "default") });
      };

      const partialCloseSqueeze = async (p: PositionRow, mark: number) => {
        if (p.partial_taken || !(p.size > 0)) return;
        let closeSize = p.size * SQUEEZE_DEFAULTS.partialFraction;
        let exitPrice = mark;
        if (isLive && creds) {
          const asset = (await assets()).get(p.coin);
          if (!asset) { report.errors.push(`${p.coin}: unknown asset on squeeze partial`); return; }
          const before = await fetchLiveAccount(creds.accountAddress);
          const current = before.positions.find((x) => x.coin === p.coin && x.side === p.side);
          if (!current || current.size <= 0) { await closeTbPosition(p, mark, "exchange_already_closed"); return; }
          closeSize = Number((current.size * SQUEEZE_DEFAULTS.partialFraction).toFixed(asset.szDecimals));
          if (!(closeSize > 0)) return;
          const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: closeSize, markPrice: mark, reduceOnly: true, slippagePct: 2 });
          if (!(fill.size > 0)) { await log(s.user_id, "warn", `Squeeze partial for ${p.coin} did not fill.`); return; }
          closeSize = fill.size;
          exitPrice = fill.avgPrice || mark;
          const after = await fetchLiveAccount(creds.accountAddress);
          const remaining = after.positions.find((x) => x.coin === p.coin && x.side === p.side);
          p.size = remaining?.size ?? Math.max(0, current.size - closeSize);
        } else {
          p.size = Math.max(0, p.size - closeSize);
        }
        const pnl = p.side === "long" ? (exitPrice - p.entry_price) * closeSize : (p.entry_price - exitPrice) * closeSize;
        p.realized_pnl = (p.realized_pnl ?? 0) + pnl;
        p.notional = p.size * p.entry_price;
        p.partial_taken = true;
        p.trail_high = exitPrice;
        p.stop_loss = squeezeTrailStop(p.side, exitPrice, p.entry_price);
        if (!(p.size > 0)) {
          await (supabaseAdmin as any).from("paper_positions").update({ status: "closed", exit_price: exitPrice, exit_reason: "squeeze_partial_rounding_full_close", pnl: p.realized_pnl, closed_at: new Date().toISOString(), partial_taken: true }).eq("id", p.id).eq("status", "open");
          positions = positions.filter((x) => x.id !== p.id); held.delete(p.coin); report.closed++;
          return;
        }
        await (supabaseAdmin as any).from("paper_positions").update({ size: p.size, notional: p.notional, pnl: p.realized_pnl, partial_taken: true, stop_loss: p.stop_loss, trail_high: p.trail_high, indicators: p.indicators ?? {} }).eq("id", p.id).eq("status", "open");
        if (isLive && creds) {
          const asset = (await assets()).get(p.coin);
          if (asset) await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
        }
        await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}PARTIAL ${p.side.toUpperCase()} ${p.coin} @ ${exitPrice.toFixed(6)} · closed 50% · realized ${pnl.toFixed(2)} · runner trail ${SQUEEZE_DEFAULTS.trailPct.toFixed(2)}%`);
      };

      if (canTrade) {
        for (const p of [...positions]) {
          const squeezePosition = isSqueezePosition(p);
          const rsiPosition = isRsiPosition(p);
          // RSI positions are managed only by completed-candle RSI exits.
          if (rsiPosition) continue;
          const protectiveStop = squeezePosition ? p.stop_loss : (p.side === "long" ? p.entry_price * (1 - hardSlPct / 100) : p.entry_price * (1 + hardSlPct / 100));
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          const breached = p.side === "long" ? mark <= protectiveStop : mark >= protectiveStop;
          if (breached) {
            if (squeezePosition) await log(s.user_id, "warn", `${p.coin} breached squeeze stop @ ${protectiveStop.toFixed(6)}.`);
            else await log(s.user_id, "warn", `${p.coin} breached hard ${hardSlPct.toFixed(2)}% stop (${protectiveStop.toFixed(6)}); forcing close now.`, { mark, hardStop: protectiveStop, side: p.side });
            await closeTbPosition(p, mark, squeezePosition ? "squeeze_stop_loss" : "hard_stop_loss");
            continue;
          }
          if (isLive && creds) {
            const asset = (await assets()).get(p.coin);
            if (!asset) { await log(s.user_id, "error", `${p.coin}: cannot install native SL; asset metadata missing.`); continue; }
            try {
              const native = await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
              if (!native.alreadyPresent) await log(s.user_id, "info", `Installed/updated native Hyperliquid SL for ${p.coin} @ ${p.stop_loss.toFixed(6)}.`, { oid: native.oid, trigger: p.stop_loss });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              report.errors.push(`native SL ${p.coin}: ${msg}`);
              await log(s.user_id, "error", `Could not install native Hyperliquid SL for ${p.coin}: ${msg}`);
            }
          }
        }
      }

      if (canTrade && shockDir) {
        for (const p of [...positions]) {
          if (!shockHitsSide(shockDir, p.side)) continue;
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          await closeTbPosition(p, mark, "btc_shock");
        }
      }

      if (canTrade) {
        for (const p of [...positions]) {
          if (!isRsiPosition(p)) continue;
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          if (rsiTakeProfitHit(p.side, mark, p.take_profit)) {
            await closeTbPosition(p, mark, "rsi_take_profit");
            continue;
          }
          if (isLive && creds && Number.isFinite(p.take_profit)) {
            const asset = (await assets()).get(p.coin);
            if (asset) {
              try {
                await ensureNativeTakeProfit(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.take_profit });
              } catch (err) {
                await log(s.user_id, "error", `Could not install native RSI take profit for ${p.coin}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          const hourly = await loadBars(p.coin, "1h", 100);
          if (!hourly || hourly.length < 40) continue;
          const value = latestRsi(hourly);
          if (!Number.isFinite(value)) continue;
          const trail = updateRsiExitTrail(p.side, value, p.indicators?.rsiExitTrail);
          p.indicators = { ...(p.indicators ?? {}), rsi: value, rsiExitTrail: trail.extreme, rsiExitReversal: trail.reversalPoints };
          await (supabaseAdmin as any).from("paper_positions").update({ indicators: p.indicators }).eq("id", p.id).eq("status", "open");
          if (trail.shouldExit) {
            await closeTbPosition(p, mark, `rsi_trail_reversal_${RSI_EXTREMES_DEFAULTS.exitReversalPoints}`);
          }
        }
      }

      if (canTrade) {
        for (const p of [...positions]) {
          if (!isSqueezePosition(p)) continue;
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          const opened = Date.parse(p.opened_at ?? "");
          const ageMs = Number.isFinite(opened) ? Date.now() - opened : 0;
          const absMove = adverseAbsPct(p.entry_price, mark);
          const indicators = p.indicators ?? (p.indicators = {});
          indicators.maxAbsMovePct = Math.max(Number(indicators.maxAbsMovePct ?? 0), absMove);

          if (ageMs >= SQUEEZE_DEFAULTS.maxMinutes * 60_000) { await closeTbPosition(p, mark, "squeeze_hard_time_exit"); continue; }
          if (ageMs >= SQUEEZE_DEFAULTS.staleMinutes * 60_000 && indicators.maxAbsMovePct < SQUEEZE_DEFAULTS.staleMovePct) { await closeTbPosition(p, mark, "squeeze_stale_exit"); continue; }

          const favorable = squeezeFavorablePct(p.side, p.entry_price, mark);
          const previousPeak = p.trail_high ?? p.entry_price;
          const best = p.side === "long" ? Math.max(previousPeak, mark) : Math.min(previousPeak, mark);
          let stopChanged = false;
          if (best !== p.trail_high) p.trail_high = best;
          if (favorable >= SQUEEZE_DEFAULTS.breakevenAtPct) {
            const next = p.side === "long" ? Math.max(p.stop_loss, p.entry_price) : Math.min(p.stop_loss, p.entry_price);
            if (next !== p.stop_loss) { p.stop_loss = next; stopChanged = true; }
          }
          if (favorable >= SQUEEZE_DEFAULTS.partialAtPct && !p.partial_taken) { await partialCloseSqueeze(p, mark); continue; }
          if (p.partial_taken) {
            const next = squeezeTrailStop(p.side, p.trail_high ?? mark, p.stop_loss);
            if (next !== p.stop_loss) { p.stop_loss = next; stopChanged = true; }
          }
          await (supabaseAdmin as any).from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high, indicators }).eq("id", p.id).eq("status", "open");
          if (stopChanged && isLive && creds) {
            const asset = (await assets()).get(p.coin);
            if (asset) await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
          }
        }
      }

      if (isTb && canTrade) {
        for (const p of [...positions]) {
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          const previousPeak = p.trail_high ?? p.entry_price;
          const best = p.side === "long" ? Math.max(previousPeak, mark) : Math.min(previousPeak, mark);
          const dynamicStop = dynamicTrailStop(p.side, p.entry_price, best, p.stop_loss, trailActivatePct, trailDistPct);
          if (best !== p.trail_high || dynamicStop !== p.stop_loss) {
            p.trail_high = best; p.stop_loss = dynamicStop;
            await supabaseAdmin.from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high }).eq("id", p.id).eq("status", "open");
            if (isLive && creds) {
              const asset = (await assets()).get(p.coin);
              if (asset) await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
            }
          }

          const series = await loadTbSeries(p.coin);
          const levels = buildCascade(series, tbCfg.timeframes, tbCfg.pivotStrength);
          const safety = safetyLineFor(levels, p.side, mark);
          if (safety != null) {
            p.safety_line = safety;
            const structuralStop = trailToSafety(p.side, p.stop_loss, safety, TB_SAFETY_BUFFER_PCT);
            if (structuralStop !== p.stop_loss) {
              p.stop_loss = structuralStop;
              if (isLive && creds) {
                const asset = (await assets()).get(p.coin);
                if (asset) await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
              }
            }
            await supabaseAdmin.from("paper_positions").update({ stop_loss: p.stop_loss, safety_line: safety, trail_high: p.trail_high }).eq("id", p.id).eq("status", "open");
          }

          if (p.side === "long" ? mark <= p.stop_loss : mark >= p.stop_loss) {
            const protectedProfit = p.side === "long" ? p.stop_loss >= p.entry_price : p.stop_loss <= p.entry_price;
            await closeTbPosition(p, mark, protectedProfit ? "dynamic_trailing_stop" : "stop_loss");
          }
        }
      }

      if (!isTb && canTrade) {
        for (const p of [...positions]) {
          if (isSqueezePosition(p) || isRsiPosition(p)) continue;
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          const previousPeak = p.trail_high ?? p.entry_price;
          const best = p.side === "long" ? Math.max(previousPeak, mark) : Math.min(previousPeak, mark);
          const dynamicStop = dynamicTrailStop(p.side, p.entry_price, best, p.stop_loss, trailActivatePct, trailDistPct);
          if (best !== p.trail_high || dynamicStop !== p.stop_loss) {
            p.trail_high = best; p.stop_loss = dynamicStop;
            await supabaseAdmin.from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high }).eq("id", p.id).eq("status", "open");
            if (isLive && creds) {
              const asset = (await assets()).get(p.coin);
              if (asset) await ensureNativeStopLoss(creds, asset, { positionSide: p.side, size: p.size, triggerPrice: p.stop_loss });
            }
          }
          const hitStop = p.side === "long" ? mark <= p.stop_loss : mark >= p.stop_loss;
          const hitTp = Number.isFinite(p.take_profit) && (p.side === "long" ? mark >= p.take_profit : mark <= p.take_profit);
          if (hitStop || hitTp) {
            const reason = hitStop ? ((p.side === "long" ? p.stop_loss > p.entry_price : p.stop_loss < p.entry_price) ? "dynamic_trailing_stop" : "stop_loss") : "take_profit";
            await closeTbPosition(p, mark, reason);
          }
        }
      }

      const scanUniverse = isRsi ? rsiLiquid : liquid;
      const eligibleCount = scanUniverse.length;
      const match = s.last_cycle_note?.match(/scanner_cursor=(\d+)/);
      const cursor = eligibleCount ? Math.max(0, Math.min(Number(match?.[1] ?? 0), eligibleCount - 1)) : 0;
      const scanCount = isRsi
        ? (rsiScanDue ? Math.min(RSI_EXTREMES_DEFAULTS.scanLimit, eligibleCount) : 0)
        : isSqueeze
          ? (squeezeScanDue ? Math.min(SQUEEZE_DEFAULTS.scanLimit, eligibleCount) : 0)
          : Math.min(isOriginalTpa ? SCAN_PER_CYCLE_ORIGINAL_TPA : SCAN_PER_CYCLE, eligibleCount);
      const scanTargets = isRsi || isSqueeze
        ? scanUniverse.slice(0, scanCount)
        : Array.from({ length: scanCount }, (_, i) => scanUniverse[(cursor + i) % eligibleCount]);
      const nextCursor = isRsi || isSqueeze ? cursor : (eligibleCount ? (cursor + scanCount) % eligibleCount : 0);
      notes.push(isRsi && !rsiScanDue ? "RSI scan waiting for 1m cadence" : isSqueeze && !squeezeScanDue ? "squeeze scan waiting for 5m cadence" : `scanner ${scanCount}/${eligibleCount} pairs · cursor ${cursor}→${nextCursor}`);

      if (s.scalp_enabled && canTrade && equityNow > 0 && positions.length < maxPositions) {
        for (const target of scanTargets) {
          if (positions.length >= maxPositions) break;
          if (held.has(target.meta.name)) continue;
          let sig: ScalpSignal;
          let tbSafety: number | undefined;
          let tbTimeframe: string | undefined;
          let originalSafety: number | undefined;
          let squeezeStop = 0;
          let squeezeTp = 0;
          if (isRsi) {
            const hourly = await loadBars(target.meta.name, "1h", 100); report.scanned++;
            if (!hourly || hourly.length < 40) continue;
            const q = evaluateRsiExtremes(target.meta.name, hourly);
            sig = { coin: q.coin, side: q.side, family: RSI_EXTREMES_KEY, confidence: q.confidence, reasons: q.reasons, price: q.price, atrPct: 0, indicators: q.indicators };
          } else if (isSqueeze) {
            const [hourly, fifteen] = await Promise.all([loadBars(target.meta.name, "1h", 100), loadBars(target.meta.name, "15m", 120)]);
            report.scanned++;
            if (!hourly || !fifteen || hourly.length < 60 || fifteen.length < 40) continue;
            const q = evaluateVolatilitySqueezeBreakout(target.meta.name, hourly, fifteen);
            squeezeStop = q.stopLoss ?? 0; squeezeTp = q.takeProfit ?? 0;
            sig = { coin: q.coin, side: q.side, family: VOLATILITY_SQUEEZE_BREAKOUT_KEY, confidence: q.confidence, reasons: q.reasons, price: q.price, atrPct: 0, indicators: q.indicators };
          } else if (isTb) {
            const series = await loadTbSeries(target.meta.name); report.scanned++;
            if (Object.keys(series).length < tbCfg.timeframes.length) continue;
            const tb = evaluateTrendlineBreak(target.meta.name, series, tbCfg);
            tbSafety = tb.safetyLine; tbTimeframe = tb.timeframe;
            sig = { coin: tb.coin, side: tb.side, family: TRENDLINE_BREAK_KEY, confidence: tb.confidence, reasons: tb.reasons, price: tb.price, atrPct: 0, indicators: tb.indicators, actionLine: tb.actionLine, safetyLine: tb.safetyLine };
          } else {
            const hourly = await loadBars(target.meta.name, "1h", BARS); report.scanned++; if (!hourly || hourly.length < 80) continue;
            const daily = await loadBars(target.meta.name, "1d", HTF_BARS);
            const fourHour = await loadBars(target.meta.name, "4h", HTF_BARS);
            if (!daily || !fourHour || daily.length < 80 || fourHour.length < 80) continue;
            if (isOriginalTpa) {
              const o = evaluateOriginalTrendPriceAction(target.meta.name, daily, fourHour, hourly);
              originalSafety = o.safetyLine;
              sig = { coin: o.coin, side: o.side, family: ORIGINAL_TREND_PRICE_ACTION_KEY, confidence: o.confidence, reasons: o.reasons, price: o.price, atrPct: o.indicators["atrPct"] ?? 0, indicators: o.indicators, actionLine: o.actionLine, safetyLine: o.safetyLine };
            } else {
              sig = evaluateScalpMulti(target.meta.name, { daily, fourHour, hourly });
            }
          }
          const minConfidence = isRsi
            ? Math.max(RSI_EXTREMES_DEFAULTS.minConfidence, +s.min_confidence)
            : isSqueeze
              ? Math.max(SQUEEZE_DEFAULTS.minConfidence, +s.min_confidence)
              : isOriginalTpa ? Math.max(ORIGINAL_TPA_DEFAULTS.minConfidence, +s.min_confidence) : +s.min_confidence;
          if (!sig.side || sig.confidence < minConfidence) continue;
          if (shockHitsSide(shockDir, sig.side)) continue;
          if (isRsi) {
            const signalCandleTs = sig.indicators.signalCandleTs;
            const { data: consumed } = await (supabaseAdmin as any).from("paper_positions")
              .select("id").eq("user_id", s.user_id).eq("coin", sig.coin).eq("side", sig.side)
              .contains("indicators", { signalCandleTs }).limit(1);
            if (consumed?.length) continue;
          }
          const b = bucket(sig.coin); if (positions.filter((p) => bucket(p.coin) === b).length >= 3) continue;
          const liveCap = +(s.live_max_alloc_usd ?? 0); const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          const quotePx = mids[sig.coin] ? +mids[sig.coin] : sig.price;
          let leverage: number; let size: number; let tbStop = 0; let originalStop = 0;
          if (isRsi) {
            leverage = Math.max(1, Math.floor(Math.min(RSI_EXTREMES_DEFAULTS.maxLeverage, +s.max_leverage, target.meta.maxLeverage)));
            const positionNotionalCap = equity * (Math.max(0, +s.position_size_pct) / 100) * leverage;
            const room = equity * (+s.max_exposure_pct / 100) * leverage - positions.reduce((sum, p) => sum + p.notional, 0);
            if (room <= 0) { notes.push("exposure cap reached"); break; }
            size = Math.min(positionNotionalCap, room) / quotePx;
            if (!(size > 0) || !Number.isFinite(size)) continue;
          } else if (isSqueeze) {
            leverage = Math.max(1, Math.floor(Math.min(3, +s.max_leverage, target.meta.maxLeverage)));
            squeezeStop = sig.side === "long" ? quotePx * (1 - SQUEEZE_DEFAULTS.stopPct / 100) : quotePx * (1 + SQUEEZE_DEFAULTS.stopPct / 100);
            squeezeTp = sig.side === "long" ? quotePx * (1 + SQUEEZE_DEFAULTS.targetPct / 100) : quotePx * (1 - SQUEEZE_DEFAULTS.targetPct / 100);
            const riskBasedSize = riskSize(equity, SQUEEZE_DEFAULTS.riskPct, quotePx, squeezeStop);
            const room = equity * (+s.max_exposure_pct / 100) * leverage - positions.reduce((sum, p) => sum + p.notional, 0);
            if (room <= 0) { notes.push("exposure cap reached"); break; }
            size = Math.min(riskBasedSize, room / quotePx);
            if (!(size > 0) || !Number.isFinite(size)) continue;
          } else if (isOriginalTpa) {
            const atrValue = (sig.atrPct / 100) * quotePx;
            const fallback = Math.max(atrValue * 1.25, quotePx * 0.0035);
            let stop = originalSafety;
            if (stop == null || !Number.isFinite(stop) || (sig.side === "long" ? stop >= quotePx : stop <= quotePx)) {
              stop = sig.side === "long" ? quotePx - fallback : quotePx + fallback;
            }
            originalStop = stop;
            leverage = Math.max(1, Math.floor(Math.min(+s.max_leverage, target.meta.maxLeverage)));
            const riskBasedSize = riskSize(equity, originalRiskPct, quotePx, originalStop);
            const positionNotionalCap = equity * (ORIGINAL_TPA_DEFAULTS.positionSizePct / 100) * leverage;
            const used = positions.reduce((sum, p) => sum + p.notional, 0);
            const room = equity * (+s.max_exposure_pct / 100) * leverage - used;
            if (room <= 0) { notes.push("exposure cap reached"); break; }
            size = Math.min(riskBasedSize, positionNotionalCap / quotePx, room / quotePx);
            if (!(size > 0) || !Number.isFinite(size)) continue;
          } else if (isTb) {
            if (tbSafety == null) continue;
            leverage = Math.max(1, Math.floor(Math.min(+s.max_leverage, target.meta.maxLeverage)));
            tbStop = safetyStop(sig.side, tbSafety, TB_SAFETY_BUFFER_PCT);
            const stopOnWrongSide = sig.side === "long" ? tbStop >= quotePx : tbStop <= quotePx;
            const stopDistPct = Math.abs(quotePx - tbStop) / quotePx * 100;
            if (stopOnWrongSide) { await log(s.user_id, "info", `Skipped ${sig.coin}: safety-line stop is on the wrong side of price.`); continue; }
            if (stopDistPct < TB_MIN_STOP_PCT) { await log(s.user_id, "info", `Skipped ${sig.coin}: safety-line stop only ${stopDistPct.toFixed(3)}% away.`); continue; }
            if (stopDistPct > hardSlPct) { await log(s.user_id, "info", `Skipped ${sig.coin}: safety-line stop ${stopDistPct.toFixed(2)}% exceeds the ${hardSlPct.toFixed(2)}% hard stop limit.`); continue; }
            const riskBasedSize = riskSize(equity, tbCfg.riskPct, quotePx, tbStop);
            const positionNotionalCap = equity * (tbCfg.positionSizePct / 100) * leverage;
            const exposureCap = equity * (+s.max_exposure_pct / 100) * leverage;
            const used = positions.reduce((sum, p) => sum + p.notional, 0);
            const room = exposureCap - used;
            if (room <= 0) { notes.push("exposure cap reached"); break; }
            size = Math.min(riskBasedSize, positionNotionalCap / quotePx, room / quotePx);
            if (!(size > 0) || !Number.isFinite(size)) continue;
          } else {
            const intent = buildEntryIntent({ side: sig.side, price: quotePx, equity, positionSizePct: +s.position_size_pct, maxExposurePct: +s.max_exposure_pct, userMaxLeverage: +s.max_leverage, assetMaxLeverage: target.meta.maxLeverage, currentExposure: positions.reduce((sum, p) => sum + p.notional, 0), slPct: exits.slPct, tpPct: exits.tpPct });
            if (!intent.ok) { if (intent.reason === "exposure cap reached") { notes.push("exposure cap reached"); break; } continue; }
            leverage = intent.leverage; size = intent.size;
          }
          const quote = quotePx; let entry = quote;
          const reason = `${sig.side.toUpperCase()} ${sig.coin} [${sig.family}] — ${sig.reasons.join(" + ")}`;
          let liveAsset: Awaited<ReturnType<typeof assets>> extends Map<string, infer A> ? A | undefined : never;
          if (isLive && creds) {
            liveAsset = (await assets()).get(sig.coin) as typeof liveAsset;
            if (!liveAsset) { report.errors.push(`${sig.coin}: unknown asset`); continue; }
            size = Number(size.toFixed(liveAsset.szDecimals));
            if (size <= 0) { await log(s.user_id, "warn", `Skipped ${sig.coin}: order size rounds to zero at ${liveAsset.szDecimals} decimals.`); continue; }
            try {
              leverage = isTb ? Math.max(1, Math.floor(Math.min(+s.max_leverage, liveAsset.maxLeverage))) : leverage;
              await setLeverage(creds, liveAsset, leverage);
              const fill = await marketOrder(creds, liveAsset, { isBuy: sig.side === "long", size, markPrice: quote, reduceOnly: false, slippagePct: 1 });
              if (fill.size <= 0) { await log(s.user_id, "warn", `Live entry for ${sig.coin} did not fill.`); continue; }
              entry = fill.avgPrice || quote; size = fill.size;
            } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`open ${sig.coin}: ${msg}`); await log(s.user_id, "error", `Live entry failed for ${sig.coin}: ${msg}`); continue; }
          }
          const sl = isTb && tbStop > 0
            ? tbStop
            : isRsi
              ? 0 // persisted sentinel: RSI positions have no price stop
              : isSqueeze
                ? (sig.side === "long" ? entry * (1 - SQUEEZE_DEFAULTS.stopPct / 100) : entry * (1 + SQUEEZE_DEFAULTS.stopPct / 100))
                : isOriginalTpa && originalStop > 0
                  ? originalStop
                  : sig.side === "long" ? entry * (1 - hardSlPct / 100) : entry * (1 + hardSlPct / 100);
          const tp = isTb
            ? null
            : isRsi
              ? rsiTakeProfitPrice(sig.side, entry, exits.tpPct)
            : isSqueeze
              ? (sig.side === "long" ? entry * (1 + SQUEEZE_DEFAULTS.targetPct / 100) : entry * (1 - SQUEEZE_DEFAULTS.targetPct / 100))
              : isOriginalTpa
                ? targetFromR(sig.side, entry, sl, ORIGINAL_TPA_DEFAULTS.takeProfitR)
                : sig.side === "long" ? entry * (1 + exits.tpPct / 100) : entry * (1 - exits.tpPct / 100);

          if (isLive && creds && liveAsset && !isRsi) {
            try {
              await ensureNativeStopLoss(creds, liveAsset, { positionSide: sig.side, size, triggerPrice: sl });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await log(s.user_id, "error", `Native SL placement failed for new ${sig.coin} position; flattening immediately: ${msg}`);
              try { await marketOrder(creds, liveAsset, { isBuy: sig.side === "short", size, markPrice: entry, reduceOnly: true, slippagePct: 2 }); }
              catch (flattenErr) { report.errors.push(`UNPROTECTED ${sig.coin}: ${flattenErr instanceof Error ? flattenErr.message : String(flattenErr)}`); }
              report.errors.push(`native SL ${sig.coin}: ${msg}`);
              continue;
            }
          }
          if (isLive && creds && liveAsset && isRsi && Number.isFinite(tp)) {
            try {
              await ensureNativeTakeProfit(creds, liveAsset, { positionSide: sig.side, size, triggerPrice: tp! });
            } catch (err) {
              await log(s.user_id, "error", `Native RSI take-profit placement failed for ${sig.coin}; server polling remains active: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          const extra = isTb
            ? { safety_line: tbSafety ?? null, action_line: sig.actionLine ?? null, timeframe: tbTimeframe ?? null, initial_stop: sl, risk_pct: tbCfg.riskPct }
            : isRsi
              ? { timeframe: "1h", initial_stop: null }
              : isSqueeze
                ? { timeframe: "15m", initial_stop: sl, risk_pct: SQUEEZE_DEFAULTS.riskPct, partial_taken: false }
                : isOriginalTpa
                  ? { safety_line: originalSafety ?? null, action_line: sig.actionLine ?? null, initial_stop: sl, risk_pct: originalRiskPct }
                  : { initial_stop: sl };
          const insertRow: any = { user_id: s.user_id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, confidence: sig.confidence, reason, indicators: sig.indicators, ...extra };
          const { data: inserted, error: insErr } = await (supabaseAdmin as any).from("paper_positions").insert(insertRow).select("id,opened_at").single();
          if (insErr || !inserted) { report.errors.push(`record ${sig.coin}: ${insErr?.message ?? "insert returned no row"}`); continue; }
          positions.push({ id: inserted.id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp ?? (sig.side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY), trail_high: entry, confidence: sig.confidence, initial_stop: sl, safety_line: (isOriginalTpa ? originalSafety : tbSafety) ?? null, opened_at: inserted.opened_at, reason, partial_taken: false, realized_pnl: 0, indicators: sig.indicators });
          held.add(sig.coin); report.opened++;
          await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}OPEN ${sig.side.toUpperCase()} ${sig.coin} @ ${entry.toFixed(6)} · size ${size} · leverage ${leverage}x · ${reason}`, { agent: "server", live: isLive, signal: sig, riskPct: isRsi ? null : isSqueeze ? SQUEEZE_DEFAULTS.riskPct : isTb ? tbCfg.riskPct : isOriginalTpa ? originalRiskPct : null, positionSizePct: isRsi ? +s.position_size_pct : isTb ? tbCfg.positionSizePct : null, hardSlPct: isRsi ? null : isSqueeze ? SQUEEZE_DEFAULTS.stopPct : hardSlPct, leverage, nativeStop: isLive && !isRsi ? sl : null });
        }
      }
      const note = notes.length ? notes.join(" · ") + ` · scanner_cursor=${nextCursor}` : `cycle complete · scanner_cursor=${nextCursor}`;
      const settingsUpdate: Record<string, unknown> = { last_cycle_at: new Date().toISOString(), last_cycle_note: note };
      if (squeezeScanDue) settingsUpdate.squeeze_last_scan_at = new Date().toISOString();
      if (rsiScanDue) settingsUpdate.rsi_last_scan_at = new Date().toISOString();
      await (supabaseAdmin as any).from("bot_settings").update(settingsUpdate).eq("user_id", s.user_id);
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`${s.user_id}: ${msg}`); await log(s.user_id, "error", `Trading cycle failed: ${msg}`); }
  }
  return report;
}
