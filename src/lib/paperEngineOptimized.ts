import { fetchCandles, fetchMetaAndCtxs, subscribeAllMids, type AssetCtx, type AssetMeta } from "./hyperliquid";
import { candlesToBars, evaluateMultiTimeframeSignal, bucket, type Bar, type Signal, MODE_MIN_CONFIDENCE, type StrategyMode } from "./strategy";
import { supabase } from "@/integrations/supabase/client";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";
import {
  TRENDLINE_BREAK_KEY, TB_INTERVAL_MS, parseTimeframes, evaluateTrendlineBreak, buildCascade,
  safetyLineFor, riskSize, trailToSafety, safetyStop, TB_SAFETY_BUFFER_PCT, TB_MIN_STOP_PCT, TB_DEFAULTS,
  type TbTimeframe, type TbSeries,
} from "./strategies/trendlineBreak";
import {
  INTRADAY_PULLBACK_KEY, INTRADAY_DEFAULTS, evaluateIntradayPullback,
  riskSizedQuantity, targetFromR, intradayRTrail,
} from "./strategies/intradayMomentumPullback";
import {
  ORIGINAL_TREND_PRICE_ACTION_KEY, ORIGINAL_TPA_DEFAULTS, evaluateOriginalTrendPriceAction,
} from "./strategies/originalTrendPriceAction";

export interface Settings {
  user_id: string;
  mode: "paper" | "live";
  strategy_mode: StrategyMode;
  paper_equity: number;
  max_leverage: number;
  position_size_pct: number;
  max_exposure_pct: number;
  daily_loss_pct: number;
  max_positions: number;
  min_confidence: number;
  sl_type: "atr" | "fixed";
  sl_atr_mult: number;
  sl_fixed_pct: number;
  tp_rr: number;
  trailing_enabled: boolean;
  bot_enabled: boolean;
  kill_switch_engaged: boolean;
  server_agent_enabled: boolean;
  ai_review_enabled: boolean;
  scalp_enabled: boolean;
  scalp_tp_pct: number;
  scalp_sl_pct: number;
  trail_activate_pct: number;
  trail_dist_pct: number;
  last_cycle_at: string | null;
  last_cycle_note: string | null;
  live_max_alloc_usd: number;
  btc_shock_enabled?: boolean;
  btc_shock_pct?: number;
  btc_shock_window_min?: number;
  strategy_key?: string;
  trendline_risk_pct?: number;
  tb_timeframes?: string;
  tb_pivot_strength?: number;
  tb_risk_pct?: number;
  tb_position_size_pct?: number;
  tb_refresh_min?: number;
}

export interface OpenPosition {
  id: string;
  coin: string;
  side: "long" | "short";
  size: number;
  notional: number;
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  trail_high: number | null;
  confidence: number;
  safety_line?: number | null;
  initial_stop?: number;
}

type Log = (level: "info" | "warn" | "error" | "trade", msg: string, meta?: any) => void;
const HOUR = 60 * 60 * 1000;
const FOUR_HOUR = 4 * HOUR;
const DAY = 24 * HOUR;
const FIFTEEN = 15 * 60 * 1000;
const LIQUIDITY_FLOOR = 5_000_000;
const EXCLUDED = new Set(["BTC", "ETH"]);

export class PaperEngine {
  private userId: string;
  private settings: Settings;
  private mids: Record<string, string> = {};
  private meta: AssetMeta[] = [];
  private ctxs: AssetCtx[] = [];
  private positions: OpenPosition[] = [];
  private unsubMids: (() => void) | null = null;
  private tickTimer: any = null;
  private evalTimer: any = null;
  private shockTimer: any = null;
  private running = false;
  private evaluating = false;
  private log: Log;
  private startEquity: number;
  private dayStartEquity: number;
  private dayStartTs = new Date().setUTCHours(0, 0, 0, 0);
  private snapshotTs = 0;
  private shockDir: ShockDir = null;
  private seriesCache = new Map<string, { bars: Bar[]; ts: number }>();

  constructor(userId: string, settings: Settings, log: Log) {
    this.userId = userId;
    this.settings = settings;
    this.log = log;
    this.startEquity = settings.paper_equity;
    this.dayStartEquity = settings.paper_equity;
  }

  private isLive() { return this.settings.mode === "live"; }
  private isTb() { return this.settings.strategy_key === TRENDLINE_BREAK_KEY; }
  private isIntraday() { return this.settings.strategy_key === INTRADAY_PULLBACK_KEY; }
  private isOriginalTpa() { return this.settings.strategy_key === ORIGINAL_TREND_PRICE_ACTION_KEY; }
  private mid(coin: string): number | null { const v = this.mids[coin]; return v ? +v : null; }

  async start() {
    if (this.running) return;
    if (this.isLive()) { this.log("info", "Live mode — optimized browser engine stays idle; existing server live engine is unchanged."); return; }
    this.running = true;
    this.log("info", "Optimized paper engine starting");
    await this.syncPositions();
    const [m, c] = await fetchMetaAndCtxs();
    this.meta = m.universe; this.ctxs = c;
    this.unsubMids = subscribeAllMids((mids) => { this.mids = { ...this.mids, ...mids }; });
    this.tickTimer = setInterval(() => this.tick(), 2000);
    this.evalTimer = setInterval(() => this.evalCycle().catch((e) => this.log("error", e.message)), 15000);
    this.pollBtcShock();
    this.shockTimer = setInterval(() => this.pollBtcShock(), 20000);
  }

  stop() {
    this.running = false;
    this.unsubMids?.(); this.unsubMids = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.shockTimer) clearInterval(this.shockTimer);
    this.log("info", "Optimized paper engine stopped");
  }

  updateSettings(s: Settings) {
    const wasLive = this.settings.mode === "live";
    const delta = s.paper_equity - this.settings.paper_equity;
    if (this.settings.paper_equity > 0 && Math.abs(delta) > this.settings.paper_equity * 0.2) {
      this.startEquity += delta; this.dayStartEquity += delta;
    }
    this.settings = s;
    if (s.mode === "live" && this.running) { this.log("warn", "Switched to live — optimized paper engine stopped."); this.stop(); }
    else if (wasLive && s.mode === "paper" && !this.running) this.start().catch((e) => this.log("error", e.message));
  }

  async syncPositions() {
    const { data } = await supabase.from("paper_positions").select("*").eq("user_id", this.userId).eq("status", "open");
    this.positions = (data ?? []).map((p) => ({
      id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional,
      leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss,
      take_profit: p.take_profit == null ? (p.side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : +p.take_profit,
      trail_high: p.trail_high == null ? null : +p.trail_high, confidence: +p.confidence,
      safety_line: p.safety_line == null ? null : +p.safety_line,
      initial_stop: p.initial_stop == null ? +p.stop_loss : +p.initial_stop,
    }));
    this.log("info", `Synced ${this.positions.length} open paper position(s)`);
  }

  getPositions() { return this.positions; }
  getMids() { return this.mids; }
  getMeta() { return this.meta; }

  private unrealizedPnl(p: OpenPosition, mark: number) {
    return p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
  }

  private currentEquity() {
    let u = 0;
    for (const p of this.positions) { const m = this.mid(p.coin); if (m != null) u += this.unrealizedPnl(p, m); }
    return this.startEquity + u;
  }

  private async pollBtcShock() {
    if (this.settings.btc_shock_enabled === false) { this.shockDir = null; return; }
    const win = Math.max(1, Math.round(Number(this.settings.btc_shock_window_min ?? 240)));
    const move = await fetchBtcMovePct(win);
    const dir = shockDirection(move, Number(this.settings.btc_shock_pct ?? 1.5));
    if (dir && dir !== this.shockDir) this.log("warn", `BTC shock ${dir} ${move!.toFixed(2)}% / ${win}m`);
    this.shockDir = dir;
  }

  private rTrail(p: OpenPosition, mark: number) {
    const initialStop = p.initial_stop ?? p.stop_loss;
    const previousBest = p.trail_high ?? p.entry_price;
    const best = p.side === "long" ? Math.max(previousBest, mark) : Math.min(previousBest, mark);
    p.trail_high = best;

    const candidate = this.isIntraday()
      ? intradayRTrail(p.side, p.entry_price, initialStop, best, p.stop_loss)
      : (() => {
          const r = Math.abs(p.entry_price - initialStop);
          if (!(r > 0)) return p.stop_loss;
          const favorableR = p.side === "long" ? (best - p.entry_price) / r : (p.entry_price - best) / r;
          let c = p.stop_loss;
          if (favorableR >= 1) {
            const be = p.side === "long" ? p.entry_price + r * 0.05 : p.entry_price - r * 0.05;
            c = p.side === "long" ? Math.max(c, be) : Math.min(c, be);
          }
          if (favorableR >= 1.5) {
            const trailed = p.side === "long" ? best - r * 0.75 : best + r * 0.75;
            c = p.side === "long" ? Math.max(c, trailed) : Math.min(c, trailed);
          }
          return c;
        })();

    if (candidate !== p.stop_loss || best !== previousBest) {
      p.stop_loss = candidate;
      this.persistPositionUpdate(p);
    }
  }

  private tick() {
    if (this.isLive()) return;
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    if (dayStart !== this.dayStartTs) { this.dayStartTs = dayStart; this.dayStartEquity = this.currentEquity(); }
    const eq = this.currentEquity();
    const dayPct = this.dayStartEquity > 0 ? ((eq - this.dayStartEquity) / this.dayStartEquity) * 100 : 0;
    if (dayPct <= -this.settings.daily_loss_pct && this.settings.bot_enabled) {
      this.log("warn", `Daily loss limit hit (${dayPct.toFixed(2)}%). Flattening paper positions and disabling bot.`);
      this.flattenAll("daily_loss_limit").catch(() => {});
      supabase.from("bot_settings").update({ bot_enabled: false }).eq("user_id", this.userId).then(() => {});
    }

    for (const p of [...this.positions]) {
      const mark = this.mid(p.coin); if (mark == null) continue;
      if (shockHitsSide(this.shockDir, p.side)) { this.closePosition(p, mark, "btc_shock").catch(() => {}); continue; }
      this.rTrail(p, mark);
      const hitStop = p.side === "long" ? mark <= p.stop_loss : mark >= p.stop_loss;
      const hitTp = Number.isFinite(p.take_profit) && (p.side === "long" ? mark >= p.take_profit : mark <= p.take_profit);
      if (hitStop) {
        const protectedProfit = p.side === "long" ? p.stop_loss >= p.entry_price : p.stop_loss <= p.entry_price;
        this.closePosition(p, mark, protectedProfit ? "r_trailing_stop" : "stop_loss").catch(() => {});
      } else if (hitTp) this.closePosition(p, mark, "take_profit").catch(() => {});
    }

    const now = Date.now();
    if (now - this.snapshotTs > 60_000) {
      this.snapshotTs = now;
      supabase.from("equity_snapshots").insert({ user_id: this.userId, equity: eq, realized_pnl: 0, unrealized_pnl: eq - this.startEquity, mode: "paper" }).then(() => {});
    }
  }

  private async evalCycle() {
    if (!this.settings.bot_enabled || this.settings.kill_switch_engaged || this.settings.mode !== "paper" || this.settings.server_agent_enabled || this.evaluating) return;
    this.evaluating = true;
    try {
      if (this.isIntraday()) await this.runIntradayCycle();
      else if (this.isTb()) await this.runTrendlineBreakCycle();
      else if (this.isOriginalTpa()) await this.runOriginalTrendPriceActionCycle();
      else await this.runTrendlinePriceActionCycle();
    } finally { this.evaluating = false; }
  }

  private candidates(limit = 35) {
    return this.meta.map((m, i) => ({ meta: m, ctx: this.ctxs[i] }))
      .filter((x) => x.ctx && +x.ctx.dayNtlVlm > LIQUIDITY_FLOOR && !EXCLUDED.has(x.meta.name))
      .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm).slice(0, limit);
  }

  private async bars(coin: string, interval: string, count: number, intervalMs: number): Promise<Bar[] | null> {
    const key = `${coin}:${interval}:${count}`;
    const cached = this.seriesCache.get(key);
    if (cached && Date.now() - cached.ts < 60_000) return cached.bars;
    try {
      const end = Date.now();
      const cs = await fetchCandles(coin, interval as any, end - count * intervalMs, end);
      const out = candlesToBars(cs).slice(0, -1);
      this.seriesCache.set(key, { bars: out, ts: Date.now() });
      return out;
    } catch { return null; }
  }

  private async runIntradayCycle() {
    const held = new Set(this.positions.map((p) => p.coin));
    for (const { meta } of this.candidates()) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const [h4, h1, m15] = await Promise.all([
        this.bars(meta.name, "4h", 180, FOUR_HOUR), this.bars(meta.name, "1h", 220, HOUR), this.bars(meta.name, "15m", 240, FIFTEEN),
      ]);
      if (!h4 || !h1 || !m15) continue;
      const sig = evaluateIntradayPullback(meta.name, h4, h1, m15);
      if (!sig.side || sig.stopLoss == null || sig.confidence < Math.max(65, this.settings.min_confidence)) continue;
      if (shockHitsSide(this.shockDir, sig.side)) continue;
      const equity = this.currentEquity();
      const leverage = Math.max(1, Math.floor(Math.min(this.settings.max_leverage, meta.maxLeverage)));
      const riskQty = riskSizedQuantity(equity, INTRADAY_DEFAULTS.riskPct, sig.price, sig.stopLoss);
      const capQty = (equity * (INTRADAY_DEFAULTS.positionSizePct / 100) * leverage) / sig.price;
      const roomQty = Math.max(0, equity * (this.settings.max_exposure_pct / 100) * leverage - this.positions.reduce((s, p) => s + p.notional, 0)) / sig.price;
      const size = Math.min(riskQty, capQty, roomQty);
      if (!(size > 0)) continue;
      const tp = targetFromR(sig.side, sig.price, sig.stopLoss);
      await this.openPaper(sig.coin, sig.side, size, leverage, sig.price, sig.stopLoss, tp, sig.confidence, sig.reasons, sig.indicators, INTRADAY_DEFAULTS.riskPct);
      held.add(meta.name);
    }
  }

  private async runOriginalTrendPriceActionCycle() {
    const held = new Set(this.positions.map((p) => p.coin));
    const riskPct = Math.min(5, Math.max(0.05, Number(this.settings.trendline_risk_pct ?? ORIGINAL_TPA_DEFAULTS.riskPct)));
    for (const { meta } of this.candidates()) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const [daily, four, hourly] = await Promise.all([
        this.bars(meta.name, "1d", 240, DAY), this.bars(meta.name, "4h", 240, FOUR_HOUR), this.bars(meta.name, "1h", 230, HOUR),
      ]);
      if (!daily || !four || !hourly || daily.length < 80 || four.length < 80 || hourly.length < 80) continue;
      const sig = evaluateOriginalTrendPriceAction(meta.name, daily, four, hourly);
      const threshold = Math.max(ORIGINAL_TPA_DEFAULTS.minConfidence, this.settings.min_confidence);
      if (!sig.side || sig.confidence < threshold || shockHitsSide(this.shockDir, sig.side)) continue;
      await this.openRiskManagedSignal(sig, meta, riskPct, ORIGINAL_TPA_DEFAULTS.positionSizePct, ORIGINAL_TPA_DEFAULTS.takeProfitR);
      held.add(meta.name);
    }
  }

  private async runTrendlinePriceActionCycle() {
    const held = new Set(this.positions.map((p) => p.coin));
    for (const { meta } of this.candidates()) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const [daily, four, hourly] = await Promise.all([
        this.bars(meta.name, "1d", 240, DAY), this.bars(meta.name, "4h", 240, FOUR_HOUR), this.bars(meta.name, "1h", 230, HOUR),
      ]);
      if (!daily || !four || !hourly || daily.length < 80 || four.length < 80 || hourly.length < 80) continue;
      const sig = evaluateMultiTimeframeSignal(meta.name, daily, four, hourly);
      const threshold = Math.max(this.settings.min_confidence, Math.min(70, MODE_MIN_CONFIDENCE[this.settings.strategy_mode]));
      if (!sig.side || sig.confidence < threshold || shockHitsSide(this.shockDir, sig.side)) continue;
      await this.openRiskManagedSignal(sig, meta, 0.4, 6, 2.2);
      held.add(meta.name);
    }
  }

  private async openRiskManagedSignal(sig: Signal, meta: AssetMeta, riskPct: number, capPct: number, takeProfitR: number) {
    const side = sig.side!;
    const price = sig.price;
    const fallback = Math.max(sig.atrValue * 1.25, price * 0.0035);
    let stop = sig.safetyLine;
    if (stop == null || !Number.isFinite(stop) || (side === "long" ? stop >= price : stop <= price)) stop = side === "long" ? price - fallback : price + fallback;
    const equity = this.currentEquity();
    const leverage = Math.max(1, Math.floor(Math.min(this.settings.max_leverage, meta.maxLeverage)));
    const riskQty = riskSize(equity, riskPct, price, stop);
    const capQty = (equity * (capPct / 100) * leverage) / price;
    const roomQty = Math.max(0, equity * (this.settings.max_exposure_pct / 100) * leverage - this.positions.reduce((s, p) => s + p.notional, 0)) / price;
    const size = Math.min(riskQty, capQty, roomQty);
    if (!(size > 0)) return;
    const tp = targetFromR(side, price, stop, takeProfitR);
    await this.openPaper(sig.coin, side, size, leverage, price, stop, tp, sig.confidence, sig.reasons, sig.indicators, riskPct);
  }

  private tbConfig() {
    return {
      timeframes: parseTimeframes(this.settings.tb_timeframes),
      pivotStrength: Math.round(Number(this.settings.tb_pivot_strength ?? TB_DEFAULTS.pivotStrength)),
      riskPct: Number(this.settings.tb_risk_pct ?? 0.4),
      positionSizePct: Number(this.settings.tb_position_size_pct ?? 6),
    };
  }

  private async loadTbSeries(coin: string, tfs: TbTimeframe[]): Promise<TbSeries | null> {
    const series: TbSeries = {};
    for (const tf of tfs) {
      const bars = await this.bars(coin, tf, 300, TB_INTERVAL_MS[tf]);
      if (bars && bars.length >= 30) series[tf] = bars;
    }
    return Object.keys(series).length === tfs.length ? series : null;
  }

  private async runTrendlineBreakCycle() {
    const cfg = this.tbConfig();
    for (const p of this.positions) {
      const series = await this.loadTbSeries(p.coin, cfg.timeframes); if (!series) continue;
      const mark = this.mid(p.coin) ?? p.entry_price;
      const levels = buildCascade(series, cfg.timeframes, cfg.pivotStrength);
      const safety = safetyLineFor(levels, p.side, mark);
      if (safety != null) {
        p.safety_line = safety;
        p.stop_loss = trailToSafety(p.side, p.stop_loss, safety, TB_SAFETY_BUFFER_PCT);
        this.persistPositionUpdate(p);
      }
    }

    const held = new Set(this.positions.map((p) => p.coin));
    for (const { meta } of this.candidates()) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const series = await this.loadTbSeries(meta.name, cfg.timeframes); if (!series) continue;
      const sig = evaluateTrendlineBreak(meta.name, series, cfg);
      if (!sig.side || sig.safetyLine == null || sig.confidence < this.settings.min_confidence || shockHitsSide(this.shockDir, sig.side)) continue;
      const stop = safetyStop(sig.side, sig.safetyLine, TB_SAFETY_BUFFER_PCT);
      const stopPct = Math.abs(sig.price - stop) / sig.price * 100;
      if (stopPct < TB_MIN_STOP_PCT || stopPct > 2.25 || (sig.side === "long" ? stop >= sig.price : stop <= sig.price)) continue;
      const equity = this.currentEquity();
      const leverage = Math.max(1, Math.floor(Math.min(this.settings.max_leverage, meta.maxLeverage)));
      const size = Math.min(
        riskSize(equity, cfg.riskPct, sig.price, stop),
        (equity * (cfg.positionSizePct / 100) * leverage) / sig.price,
        Math.max(0, equity * (this.settings.max_exposure_pct / 100) * leverage - this.positions.reduce((s, p) => s + p.notional, 0)) / sig.price,
      );
      if (!(size > 0)) continue;
      await this.openPaper(sig.coin, sig.side, size, leverage, sig.price, stop, Number.NaN, sig.confidence, sig.reasons, sig.indicators, cfg.riskPct, sig.safetyLine, sig.actionLine, sig.timeframe);
      held.add(meta.name);
    }
  }

  private async openPaper(coin: string, side: "long" | "short", size: number, leverage: number, entry: number, stop: number, tp: number,
    confidence: number, reasons: string[], indicators: Record<string, number>, riskPct: number, safetyLine?: number, actionLine?: number, timeframe?: string) {
    if (this.isLive()) return;
    const b = bucket(coin); if (this.positions.filter((p) => bucket(p.coin) === b).length >= 3) return;
    const reason = `${side.toUpperCase()} ${coin} — ${reasons.join(" + ")}`;
    const row: any = {
      user_id: this.userId, coin, side, size, notional: size * entry, leverage,
      entry_price: entry, stop_loss: stop, take_profit: Number.isFinite(tp) ? tp : null,
      confidence, reason, indicators, initial_stop: stop, risk_pct: riskPct,
    };
    if (safetyLine != null) row.safety_line = safetyLine;
    if (actionLine != null) row.action_line = actionLine;
    if (timeframe) row.timeframe = timeframe;
    const { data, error } = await supabase.from("paper_positions").insert(row).select().single();
    if (error || !data) { this.log("error", `Failed to open ${coin}: ${error?.message ?? "insert failed"}`); return; }
    this.positions.push({ id: data.id, coin, side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: stop,
      take_profit: Number.isFinite(tp) ? tp : (side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY),
      trail_high: entry, confidence, safety_line: safetyLine ?? null, initial_stop: stop });
    this.log("trade", `OPEN ${reason} @ ${entry.toFixed(6)} · SL ${stop.toFixed(6)}${Number.isFinite(tp) ? ` · TP ${tp.toFixed(6)}` : ""} · risk ${riskPct.toFixed(2)}%`);
  }

  private async closePosition(p: OpenPosition, price: number, exitReason: string) {
    if (this.isLive()) return;
    const pnl = this.unrealizedPnl(p, price);
    this.positions = this.positions.filter((x) => x.id !== p.id);
    this.startEquity += pnl;
    await supabase.from("paper_positions").update({ status: "closed", exit_price: price, exit_reason: exitReason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id);
    this.log("trade", `CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${price.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${exitReason}`);
  }

  async flattenAll(reason: string) {
    if (this.isLive()) { this.log("error", "Optimized paper engine refused live flatten request."); return; }
    for (const p of [...this.positions]) await this.closePosition(p, this.mid(p.coin) ?? p.entry_price, reason);
  }

  private persistPositionUpdate(p: OpenPosition) {
    supabase.from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high, safety_line: p.safety_line ?? null }).eq("id", p.id).then(() => {});
  }
}
