import { candlesToBars, bucket, type Bar } from "./strategy";
import { buildEntryIntent } from "./orderIntent";
import { evaluateScalpMulti, type ExitParams, type ScalpSignal } from "./scalp";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";
import {
  TRENDLINE_BREAK_KEY, TB_INTERVAL_MS, parseTimeframes, buildCascade, evaluateTrendlineBreak,
  safetyLineFor, riskSize, trailToSafety, dynamicTrailStop, safetyStop, TB_SAFETY_BUFFER_PCT, TB_MIN_STOP_PCT, TB_DEFAULTS,
  type TbTimeframe, type TbSeries,
} from "./strategies/trendlineBreak";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const BARS = 230;
const HTF_BARS = 240;
const SCAN_PER_CYCLE = 35;
const MIN_24H_VOLUME = 5_000_000;

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
  tb_timeframes?: string; tb_pivot_strength?: number; tb_risk_pct?: number; tb_position_size_pct?: number; tb_refresh_min?: number;
  last_cycle_note?: string | null;
}
interface PositionRow {
  id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number;
  entry_price: number; stop_loss: number; take_profit: number; trail_high: number | null; confidence: number;
  initial_stop?: number; safety_line?: number | null;
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
  const liquid = meta.universe.map((m, i) => ({ meta: m, ctx: ctxs[i] })).filter((x) => x.ctx && +x.ctx.dayNtlVlm > MIN_24H_VOLUME && !EXCLUDED_COINS.has(x.meta.name)).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);

  const { readHlCreds, loadAssetIndex, marketOrder, setLeverage, fetchLiveAccount, ensureNativeStopLoss } = await import("./hyperliquidExchange.server");
  const creds = readHlCreds();
  let assetIndex: Awaited<ReturnType<typeof loadAssetIndex>> | null = null;
  const assets = async () => (assetIndex ??= await loadAssetIndex());
  const barCache = new Map<string, Bar[]>();
  const loadBars = async (coin: string, interval: "1h" | "4h" | "1d" | TbTimeframe, count: number): Promise<Bar[] | null> => {
    const key = `${coin}:${interval}`;
    if (barCache.has(key)) return barCache.get(key)!;
    try {
      const intervalMs = TB_INTERVAL_MS[interval as TbTimeframe] ?? 60 * 60 * 1000;
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
      })) as PositionRow[];
      let liveAcct: Awaited<ReturnType<typeof fetchLiveAccount>> | null = null;
      if (isLive && creds) {
        try {
          liveAcct = await fetchLiveAccount(creds.accountAddress);
          const liveKeys = new Set(liveAcct.positions.map((p) => `${p.coin}:${p.side}`));
          const stale = positions.filter((p) => !liveKeys.has(`${p.coin}:${p.side}`));
          for (const p of stale) {
            const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
            const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
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
      const tbCfg = {
        timeframes: parseTimeframes(s.tb_timeframes),
        pivotStrength: Math.round(+(s.tb_pivot_strength ?? 3)),
        riskPct: +(s.tb_risk_pct ?? TB_DEFAULTS.riskPct),
        positionSizePct: +(s.tb_position_size_pct ?? s.position_size_pct ?? 5),
      };

      for (const p of positions) {
        if (isTb) continue; // Trendline Break uses a structural safety-line stop, not the fixed hard stop
        const hardStop = p.side === "long"
          ? p.entry_price * (1 - hardSlPct / 100)
          : p.entry_price * (1 + hardSlPct / 100);
        const best = p.trail_high ?? p.entry_price;
        const favorablePct = p.side === "long"
          ? ((best - p.entry_price) / p.entry_price) * 100
          : ((p.entry_price - best) / p.entry_price) * 100;
        const profitProtectionActive = favorablePct >= trailActivatePct;
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
              const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
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
                  const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
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
        const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
        await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: exitReason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id).eq("status", "open");
        positions = positions.filter((x) => x.id !== p.id);
        held.delete(p.coin);
        report.closed++;
        await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${mark.toFixed(6)} · ${exitReason} · PnL ${pnl.toFixed(2)}`, { strategy: s.strategy_key ?? "default" });
      };

      if (canTrade) {
        for (const p of [...positions]) {
          const hardStop = p.side === "long"
            ? p.entry_price * (1 - hardSlPct / 100)
            : p.entry_price * (1 + hardSlPct / 100);
          const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price;
          const breached = p.side === "long" ? mark <= hardStop : mark >= hardStop;
          if (breached) {
            await log(s.user_id, "warn", `${p.coin} breached hard ${hardSlPct.toFixed(2)}% stop (${hardStop.toFixed(6)}); forcing close now.`, { mark, hardStop, side: p.side });
            await closeTbPosition(p, mark, "hard_stop_loss");
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
            // Structural stop trails from the start and never loosens.
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
          let sig: ScalpSignal;
          let tbSafety: number | undefined;
          let tbTimeframe: string | undefined;
          if (isTb) {
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
            sig = evaluateScalpMulti(target.meta.name, { daily, fourHour, hourly });
          }
          if (!sig.side || sig.confidence < +s.min_confidence) continue;
          if (shockHitsSide(shockDir, sig.side)) continue;
          const b = bucket(sig.coin); if (positions.filter((p) => bucket(p.coin) === b).length >= 3) continue;
          const liveCap = +(s.live_max_alloc_usd ?? 0); const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          const quotePx = mids[sig.coin] ? +mids[sig.coin] : sig.price;
          let leverage: number; let size: number; let tbStop = 0;
          if (isTb) {
            if (tbSafety == null) continue;
            leverage = Math.max(1, Math.floor(target.meta.maxLeverage));
            tbStop = sig.side === "long"
              ? quotePx * (1 - hardSlPct / 100)
              : quotePx * (1 + hardSlPct / 100);
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
              leverage = isTb ? Math.max(1, Math.floor(liveAsset.maxLeverage)) : leverage;
              await setLeverage(creds, liveAsset, leverage);
              const fill = await marketOrder(creds, liveAsset, { isBuy: sig.side === "long", size, markPrice: quote, reduceOnly: false, slippagePct: 1 });
              if (fill.size <= 0) { await log(s.user_id, "warn", `Live entry for ${sig.coin} did not fill.`); continue; }
              entry = fill.avgPrice || quote; size = fill.size;
            } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`open ${sig.coin}: ${msg}`); await log(s.user_id, "error", `Live entry failed for ${sig.coin}: ${msg}`); continue; }
          }
          const sl = sig.side === "long" ? entry * (1 - hardSlPct / 100) : entry * (1 + hardSlPct / 100);
          const tp = isTb ? null : sig.side === "long" ? entry * (1 + exits.tpPct / 100) : entry * (1 - exits.tpPct / 100);

          if (isLive && creds && liveAsset) {
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

          const extra = isTb ? { safety_line: tbSafety ?? null, action_line: sig.actionLine ?? null, timeframe: tbTimeframe ?? null, initial_stop: sl, risk_pct: tbCfg.riskPct } : { initial_stop: sl };
          const { data: inserted, error: insErr } = await supabaseAdmin.from("paper_positions").insert({ user_id: s.user_id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, confidence: sig.confidence, reason, indicators: sig.indicators, ...extra }).select("id").single();
          if (insErr || !inserted) { report.errors.push(`record ${sig.coin}: ${insErr?.message ?? "insert returned no row"}`); continue; }
          positions.push({ id: inserted.id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp ?? (sig.side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY), trail_high: entry, confidence: sig.confidence, initial_stop: sl, safety_line: tbSafety ?? null });
          held.add(sig.coin); report.opened++;
          await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}OPEN ${sig.side.toUpperCase()} ${sig.coin} @ ${entry.toFixed(6)} · size ${size} · leverage ${leverage}x · ${reason}`, { agent: "server", live: isLive, signal: sig, riskPct: isTb ? tbCfg.riskPct : null, positionSizePct: isTb ? tbCfg.positionSizePct : null, hardSlPct, leverage, nativeStop: isLive ? sl : null });
        }
      }
      const note = notes.length ? notes.join(" · ") + ` · scanner_cursor=${nextCursor}` : `cycle complete · scanner_cursor=${nextCursor}`;
      await supabaseAdmin.from("bot_settings").update({ last_cycle_at: new Date().toISOString(), last_cycle_note: note }).eq("user_id", s.user_id);
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`${s.user_id}: ${msg}`); await log(s.user_id, "error", `Trading cycle failed: ${msg}`); }
  }
  return report;
}
