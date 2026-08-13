import { fetchCandles, fetchMetaAndCtxs, subscribeAllMids, type AssetCtx, type AssetMeta } from "./hyperliquid";
import { candlesToBars, evaluateMultiTimeframeSignal, bucket, type Signal, type Bar, MODE_MIN_CONFIDENCE, type StrategyMode } from "./strategy";
import { supabase } from "@/integrations/supabase/client";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";
import {
  TRENDLINE_BREAK_KEY, TB_INTERVAL_MS, parseTimeframes, evaluateTrendlineBreak, buildCascade,
  safetyLineFor, riskSize, trailToSafety, dynamicTrailStop, safetyStop, TB_SAFETY_BUFFER_PCT, TB_MIN_STOP_PCT, TB_DEFAULTS,
  type TbTimeframe, type TbSeries,
} from "./strategies/trendlineBreak";

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
  tb_timeframes?: string;
  tb_pivot_strength?: number;
  tb_risk_pct?: number;
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
}

type Log = (level: "info" | "warn" | "error" | "trade", msg: string, meta?: any) => void;
const CANDLE_INTERVAL = "1h";
const CANDLE_MS = 60 * 60 * 1000;
const BARS_NEEDED = 220;
interface CoinCache { bars: Bar[]; daily: Bar[]; fourHour: Bar[]; lastFetch: number; nextEval: number }
const HTF_BARS = 240;

export class PaperEngine {
  private userId: string;
  private settings: Settings;
  private mids: Record<string, string> = {};
  private meta: AssetMeta[] = [];
  private ctxs: AssetCtx[] = [];
  private cache = new Map<string, CoinCache>();
  private positions: OpenPosition[] = [];
  private unsubMids: (() => void) | null = null;
  private tickTimer: any = null;
  private evalTimer: any = null;
  private log: Log;
  private startEquity: number;
  private dayStartEquity: number;
  private dayStartTs: number = new Date().setUTCHours(0, 0, 0, 0);
  private snapshotTs = 0;
  private running = false;
  private evaluating = false;
  private shockDir: ShockDir = null;
  private shockTimer: any = null;
  private tbSeries = new Map<string, { series: TbSeries; ts: number }>();

  constructor(userId: string, settings: Settings, log: Log) {
    this.userId = userId;
    this.settings = settings;
    this.log = log;
    this.startEquity = settings.paper_equity;
    this.dayStartEquity = settings.paper_equity;
  }

  private isLive() { return this.settings.mode === "live"; }
  private isTrendlineBreak() { return this.settings.strategy_key === TRENDLINE_BREAK_KEY; }
  private hardSlPct() {
    const v = Number(this.settings.scalp_sl_pct ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  private trailActivatePct() {
    const v = Number(this.settings.trail_activate_pct ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  private trailDistPct() {
    const v = Number(this.settings.trail_dist_pct ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0.5;
  }

  private tbConfig() {
    return {
      timeframes: parseTimeframes(this.settings.tb_timeframes),
      pivotStrength: Math.round(Number(this.settings.tb_pivot_strength ?? 3)),
      riskPct: Number(this.settings.tb_risk_pct ?? TB_DEFAULTS.riskPct),
      refreshMs: Math.max(1, Number(this.settings.tb_refresh_min ?? TB_DEFAULTS.refreshMin)) * 60_000,
    };
  }

  private async tbLoadSeries(coin: string, timeframes: TbTimeframe[], refreshMs: number): Promise<TbSeries | null> {
    const cached = this.tbSeries.get(coin);
    if (cached && Date.now() - cached.ts < refreshMs) return cached.series;
    const end = Date.now();
    const series: TbSeries = {};
    try {
      for (const tf of timeframes) {
        const cs = await fetchCandles(coin, tf, end - 300 * TB_INTERVAL_MS[tf], end);
        const bars = candlesToBars(cs);
        if (bars.length >= 30) series[tf] = bars;
      }
    } catch { return null; }
    if (Object.keys(series).length < timeframes.length) return null;
    this.tbSeries.set(coin, { series, ts: end });
    return series;
  }

  private async runTrendlineBreakCycle() {
    const cfg = this.tbConfig();
    for (const p of [...this.positions]) {
      const series = await this.tbLoadSeries(p.coin, cfg.timeframes, cfg.refreshMs);
      if (!series) continue;
      const mark = this.mid(p.coin) ?? p.entry_price;
      const levels = buildCascade(series, cfg.timeframes, cfg.pivotStrength);
      const safety = safetyLineFor(levels, p.side, mark);
      if (safety == null) continue;
      p.safety_line = safety;
      // Structural stop trails from the start and never loosens.
      p.stop_loss = trailToSafety(p.side, p.stop_loss, safety, TB_SAFETY_BUFFER_PCT);
      supabase.from("paper_positions").update({ stop_loss: p.stop_loss, safety_line: safety, trail_high: p.trail_high }).eq("id", p.id).then(() => {});
    }

    const held = new Set(this.positions.map(p => p.coin));
    const EXCLUDED = new Set(["BTC", "ETH"]);
    const scored = this.meta.map((m, i) => ({ meta: m, ctx: this.ctxs[i] }))
      .filter(x => x.ctx && +x.ctx.dayNtlVlm > 5_000_000 && !EXCLUDED.has(x.meta.name))
      .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm).slice(0, 30);

    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const series = await this.tbLoadSeries(meta.name, cfg.timeframes, cfg.refreshMs);
      if (!series) continue;
      const sig = evaluateTrendlineBreak(meta.name, series, cfg);
      if (!sig.side || sig.safetyLine == null) continue;
      if (shockHitsSide(this.shockDir, sig.side)) continue;
      if (sig.confidence < this.settings.min_confidence) continue;
      held.add(meta.name);
      await this.tbOpen(sig.coin, sig.side, sig.price, sig.safetyLine, sig.actionLine ?? sig.price, sig.confidence, sig.reasons, sig.timeframe ?? cfg.timeframes.at(-1)!, cfg.riskPct, meta);
    }
  }

  private async tbOpen(coin: string, side: "long" | "short", price: number, safetyLine: number, actionLine: number,
    confidence: number, reasons: string[], timeframe: string, riskPct: number, meta: AssetMeta) {
    const b = bucket(coin);
    if (this.positions.filter(p => bucket(p.coin) === b).length >= 3) return;
    const equity = this.currentEquity();
    const leverage = Math.max(1, Math.floor(Math.min(this.settings.max_leverage, meta.maxLeverage)));
    const stop = safetyStop(side, safetyLine, TB_SAFETY_BUFFER_PCT);
    const stopOnWrongSide = side === "long" ? stop >= price : stop <= price;
    const stopDistPct = Math.abs(price - stop) / price * 100;
    if (stopOnWrongSide) { this.log("info", `Skipped ${coin}: safety-line stop is on the wrong side of price.`); return; }
    if (stopDistPct < TB_MIN_STOP_PCT) { this.log("info", `Skipped ${coin}: safety-line stop only ${stopDistPct.toFixed(3)}% away.`); return; }
    if (stopDistPct > this.hardSlPct()) { this.log("info", `Skipped ${coin}: safety-line stop ${stopDistPct.toFixed(2)}% exceeds the ${this.hardSlPct().toFixed(2)}% hard stop limit.`); return; }
    let size = riskSize(equity, riskPct, price, stop);
    const room = equity * (this.settings.max_exposure_pct / 100) * leverage - this.positions.reduce((s, p) => s + p.notional, 0);
    if (room <= 0) return;
    if (size * price > room) size = room / price;
    if (!(size > 0) || !Number.isFinite(size)) return;

    const reason = `${side.toUpperCase()} ${coin} — ${reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({
      user_id: this.userId, coin, side, size, notional: size * price, leverage,
      entry_price: price, stop_loss: stop, take_profit: null, confidence, reason,
      indicators: { actionLine, safetyLine }, action_line: actionLine, safety_line: safetyLine,
      timeframe, initial_stop: stop, risk_pct: riskPct,
    }).select().single();
    if (error || !data) { this.log("error", `Failed to open ${coin}: ${error?.message}`); return; }
    this.positions.push({ id: data.id, coin, side, size, notional: size * price, leverage, entry_price: price,
      stop_loss: stop, take_profit: side === "long" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      trail_high: price, confidence, safety_line: safetyLine });
    this.log("trade", `OPEN ${reason} @ ${price.toFixed(6)} · structural SL ${stop.toFixed(6)} · safety ${safetyLine.toFixed(6)}`);
  }

  async start() {
    if (this.running) return;
    if (this.isLive()) { this.log("info", "Live mode — browser engine stays idle; the server agent handles live trading."); return; }
    this.running = true;
    this.log("info", "Engine starting (paper mode)");
    await this.syncPositions();
    const [m, c] = await fetchMetaAndCtxs();
    this.meta = m.universe; this.ctxs = c;
    this.unsubMids = subscribeAllMids(mids => { this.mids = { ...this.mids, ...mids }; });
    this.tickTimer = setInterval(() => this.tick(), 2000);
    this.evalTimer = setInterval(() => this.evalCycle().catch(err => this.log("error", err.message)), 15000);
    this.pollBtcShock(); this.shockTimer = setInterval(() => this.pollBtcShock(), 20000);
  }

  async syncPositions() {
    const { data: openPos } = await supabase.from("paper_positions").select("*").eq("user_id", this.userId).eq("status", "open");
    this.positions = (openPos ?? []).map(p => ({ id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional,
      leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss,
      take_profit: p.take_profit != null ? +p.take_profit : Number.POSITIVE_INFINITY * (p.side === "long" ? 1 : -1),
      trail_high: p.trail_high != null ? +p.trail_high : null, confidence: +p.confidence,
      safety_line: p.safety_line != null ? +p.safety_line : null }));
    this.log("info", `Synced ${this.positions.length} open paper position(s)`);
  }

  stop() {
    this.running = false; this.unsubMids?.(); this.unsubMids = null;
    if (this.tickTimer) clearInterval(this.tickTimer); if (this.evalTimer) clearInterval(this.evalTimer); if (this.shockTimer) clearInterval(this.shockTimer);
    this.log("info", "Engine stopped");
  }

  updateSettings(s: Settings) {
    const wasLive = this.settings.mode === "live";
    const prevEq = this.settings.paper_equity; const delta = s.paper_equity - prevEq;
    if (prevEq > 0 && Math.abs(delta) > prevEq * 0.2) { this.startEquity += delta; this.dayStartEquity += delta; }
    this.settings = s;
    if (s.mode === "live" && this.running) { this.log("warn", "Switched to live mode — browser engine stopped; the server agent owns live trading."); this.stop(); }
    else if (wasLive && s.mode === "paper" && !this.running) this.start().catch(err => this.log("error", err.message));
  }

  getPositions() { return this.positions; }
  getMids() { return this.mids; }
  getMeta() { return this.meta; }
  private mid(coin: string): number | null { const v = this.mids[coin]; return v ? +v : null; }
  private unrealizedPnl(p: OpenPosition, mark: number): number { return p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size; }
  private currentEquity(): number { let u = 0; for (const p of this.positions) { const m = this.mid(p.coin); if (m != null) u += this.unrealizedPnl(p, m); } return this.startEquity + u; }

  private async pollBtcShock() {
    if (this.settings.btc_shock_enabled === false) { this.shockDir = null; return; }
    const win = Math.max(1, Math.round(Number(this.settings.btc_shock_window_min ?? 15)));
    const move = await fetchBtcMovePct(win); const dir = shockDirection(move, Number(this.settings.btc_shock_pct ?? 2.0));
    if (dir && dir !== this.shockDir) this.log("warn", `BTC shock ${dir} ${move!.toFixed(2)}% over ${win}m — closing ${dir === "down" ? "longs" : "shorts"}.`);
    this.shockDir = dir;
  }

  private tick() {
    if (this.isLive()) return;
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    if (dayStart !== this.dayStartTs) { this.dayStartTs = dayStart; this.dayStartEquity = this.currentEquity(); }
    const eq = this.currentEquity(); const dayPnl = eq - this.dayStartEquity; const dayPnlPct = (dayPnl / this.dayStartEquity) * 100;
    if (dayPnlPct <= -this.settings.daily_loss_pct && this.settings.bot_enabled) {
      this.log("warn", `Daily loss limit hit (${dayPnlPct.toFixed(2)}%). Flattening & disabling bot.`);
      this.flattenAll("daily_loss_limit").catch(() => {});
      supabase.from("bot_settings").update({ bot_enabled: false }).eq("user_id", this.userId).then(() => {});
    }

    for (const p of [...this.positions]) {
      const m = this.mid(p.coin); if (m == null) continue;
      if (shockHitsSide(this.shockDir, p.side)) { this.closePosition(p, m, "btc_shock").catch(() => {}); continue; }
      if (this.isTrendlineBreak()) {
        const previousPeak = p.trail_high ?? p.entry_price;
        const best = p.side === "long" ? Math.max(previousPeak, m) : Math.min(previousPeak, m);
        const next = dynamicTrailStop(p.side, p.entry_price, best, p.stop_loss, this.trailActivatePct(), this.trailDistPct());
        if (best !== p.trail_high || next !== p.stop_loss) { p.trail_high = best; p.stop_loss = next; this.persistPositionUpdate(p); }
        if (p.side === "long" ? m <= p.stop_loss : m >= p.stop_loss) {
          const protectedProfit = p.side === "long" ? p.stop_loss >= p.entry_price : p.stop_loss <= p.entry_price;
          this.closePosition(p, m, protectedProfit ? "dynamic_trailing_stop" : "stop_loss").catch(() => {});
        }
        continue;
      }

      if (this.settings.trailing_enabled) {
        if (p.side === "long") {
          const th = p.trail_high == null ? p.entry_price : Math.max(p.trail_high, m);
          if (th !== p.trail_high) { p.trail_high = th; const r = p.entry_price - p.stop_loss; if (m > p.entry_price + r) { const newSl = Math.max(p.stop_loss, th - r); if (newSl > p.stop_loss) { p.stop_loss = newSl; this.persistPositionUpdate(p); } } }
        } else {
          const th = p.trail_high == null ? p.entry_price : Math.min(p.trail_high, m);
          if (th !== p.trail_high) { p.trail_high = th; const r = p.stop_loss - p.entry_price; if (m < p.entry_price - r) { const newSl = Math.min(p.stop_loss, th + r); if (newSl < p.stop_loss) { p.stop_loss = newSl; this.persistPositionUpdate(p); } } }
        }
      }
      if (p.side === "long") { const label = p.stop_loss > p.entry_price ? "trailing_stop" : "stop_loss"; if (m <= p.stop_loss) this.closePosition(p, m, label).catch(() => {}); else if (m >= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {}); }
      else { const label = p.stop_loss < p.entry_price ? "trailing_stop" : "stop_loss"; if (m >= p.stop_loss) this.closePosition(p, m, label).catch(() => {}); else if (m <= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {}); }
    }

    const now = Date.now();
    if (now - this.snapshotTs > 60_000) { this.snapshotTs = now; const unreal = eq - this.startEquity; supabase.from("equity_snapshots").insert({ user_id: this.userId, equity: eq, realized_pnl: 0, unrealized_pnl: unreal, mode: "paper" }).then(() => {}); }
  }

  private async evalCycle() {
    if (!this.settings.bot_enabled || this.settings.kill_switch_engaged) return;
    if (this.settings.mode !== "paper" || this.settings.server_agent_enabled || this.evaluating) return;
    this.evaluating = true; try { if (this.isTrendlineBreak()) await this.runTrendlineBreakCycle(); else await this.runEvalCycle(); } finally { this.evaluating = false; }
  }

  private async runEvalCycle() {
    const held = new Set(this.positions.map(p => p.coin)); const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
    const scored = this.meta.map((m, i) => ({ meta: m, ctx: this.ctxs[i] })).filter(x => x.ctx && +x.ctx.dayNtlVlm > 5_000_000 && !EXCLUDED_COINS.has(x.meta.name)).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);
    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions) break; if (held.has(meta.name)) continue;
      const now = Date.now(); const cached = this.cache.get(meta.name); if (cached && now < cached.nextEval) continue;
      let bars = cached?.bars, daily = cached?.daily, fourHour = cached?.fourHour;
      if (!bars || !daily || !fourHour || now - (cached?.lastFetch ?? 0) > 5 * 60 * 1000) {
        try { const end = now; const [cs, cd, c4] = await Promise.all([fetchCandles(meta.name, CANDLE_INTERVAL, end - BARS_NEEDED * CANDLE_MS, end), fetchCandles(meta.name, "1d", end - HTF_BARS * 24 * 60 * 60 * 1000, end), fetchCandles(meta.name, "4h", end - HTF_BARS * 4 * 60 * 60 * 1000, end)]); bars = candlesToBars(cs); daily = candlesToBars(cd); fourHour = candlesToBars(c4); this.cache.set(meta.name, { bars, daily, fourHour, lastFetch: now, nextEval: now + 30_000 }); } catch { continue; }
      }
      if (!bars || bars.length < BARS_NEEDED || !daily || !fourHour || daily.length < 80 || fourHour.length < 80) continue;
      const sig = evaluateMultiTimeframeSignal(meta.name, daily, fourHour, bars); this.cache.get(meta.name)!.nextEval = now + 60_000;
      if (!sig.side || shockHitsSide(this.shockDir, sig.side)) continue;
      const threshold = Math.max(this.settings.min_confidence, MODE_MIN_CONFIDENCE[this.settings.strategy_mode]); if (sig.confidence < threshold || this.positions.some(p => p.coin === meta.name)) continue;
      held.add(meta.name); await this.tryOpen(sig, meta);
    }
  }

  private async tryOpen(sig: Signal, meta: AssetMeta) {
    const side = sig.side!; const b = bucket(sig.coin); if (this.positions.filter(p => bucket(p.coin) === b).length >= 3) return;
    const equity = this.currentEquity(); const notionalCap = equity * (this.settings.position_size_pct / 100) * Math.min(this.settings.max_leverage, meta.maxLeverage);
    const currentExposure = this.positions.reduce((s, p) => s + p.notional, 0); if (currentExposure + notionalCap > equity * (this.settings.max_exposure_pct / 100) * this.settings.max_leverage) return;
    const leverage = Math.min(this.settings.max_leverage, meta.maxLeverage); const size = notionalCap / sig.price;
    const stopDist = this.settings.sl_type === "atr" ? sig.atrValue * this.settings.sl_atr_mult : sig.price * (this.settings.sl_fixed_pct / 100);
    const sl = side === "long" ? sig.price - stopDist : sig.price + stopDist; const tp = side === "long" ? sig.price + stopDist * this.settings.tp_rr : sig.price - stopDist * this.settings.tp_rr;
    const reason = `${side.toUpperCase()} ${sig.coin} — ${sig.reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({ user_id: this.userId, coin: sig.coin, side, size, notional: size * sig.price, leverage, entry_price: sig.price, stop_loss: sl, take_profit: tp, confidence: sig.confidence, reason, indicators: sig.indicators }).select().single();
    if (error || !data) return;
    this.positions.push({ id: data.id, coin: sig.coin, side, size, notional: size * sig.price, leverage, entry_price: sig.price, stop_loss: sl, take_profit: tp, trail_high: null, confidence: sig.confidence });
    this.log("trade", `OPEN ${reason} @ ${sig.price.toFixed(6)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)} · conf ${sig.confidence}`);
  }

  private async closePosition(p: OpenPosition, price: number, exitReason: string) {
    if (this.isLive()) { this.log("error", `Refused to close ${p.coin} from the browser: live positions must be closed by the server agent via a real order.`); return; }
    const pnl = this.unrealizedPnl(p, price); this.positions = this.positions.filter(x => x.id !== p.id); this.startEquity += pnl;
    await supabase.from("paper_positions").update({ status: "closed", exit_price: price, exit_reason: exitReason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id);
    this.log("trade", `CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${price.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${exitReason}`);
  }

  async flattenAll(reason: string) {
    if (this.isLive()) { this.log("error", "Refused to flatten from the browser in live mode — engage the kill switch so the server agent closes positions with real orders."); return; }
    for (const p of [...this.positions]) { const m = this.mid(p.coin) ?? p.entry_price; await this.closePosition(p, m, reason); }
  }

  private persistPositionUpdate(p: OpenPosition) { supabase.from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high }).eq("id", p.id).then(() => {}); }
}
