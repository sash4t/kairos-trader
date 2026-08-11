import { fetchCandles, fetchMetaAndCtxs, subscribeAllMids, type AssetCtx, type AssetMeta } from "./hyperliquid";
import { candlesToBars, bucket, type Bar, type StrategyMode } from "./strategy";
import {
  DEFAULT_TRENDLINE_CONFIG, TIMEFRAME_MS, ladderFor, evaluateTrendline, currentSafetyLine,
  ratchetSafetyStop, safetyExitReason, sizeAtMaxLeverage,
  type Timeframe, type TrendlineConfig, type TrendlineSignal,
} from "./trendline";
import { evaluateScalp, exitReasonFor, updateTrail, type ExitParams, type ScalpSignal } from "./scalp";
import { normalizeStrategyKey, PURE_PRICE_STRATEGY_KEY, type StrategyKey } from "./strategies";
import { detectBtcShock, sideToFlatten, DEFAULT_BTC_SHOCK, type ShockDirection } from "./btcShock";
import { supabase } from "@/integrations/supabase/client";

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
  // Always-on server agent
  server_agent_enabled: boolean;
  ai_review_enabled: boolean;
  scalp_enabled: boolean;
  scalp_tp_pct: number;
  scalp_sl_pct: number;
  trail_activate_pct: number;
  trail_dist_pct: number;
  last_cycle_at: string | null;
  last_cycle_note: string | null;
  strategy_key?: string;
  btc_shock_enabled?: boolean;
  btc_shock_pct?: number;
  btc_shock_window_min?: number;

  execution_timeframe?: string;
  safety_buffer_pct?: number;
  /** Max USD of the real account the bot may size positions from in live mode (0 = whole account). */
  live_max_alloc_usd: number;
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
  take_profit: number | null;
  trail_high: number | null;
  confidence: number;
}

type Log = (level: "info" | "warn" | "error" | "trade", msg: string, meta?: any) => void;

// Backtested (3mo, BTC/SOL/ARB/LINK/DOGE): 1h bars materially outperform 15m —
// 15m churns (1217 trades, PF 0.66) while 1h fresh-cross entries yield PF 1.78.
const LADDER_BARS = 300;

interface CoinCache { ladder: Partial<Record<Timeframe, Bar[]>>; lastFetch: number; nextEval: number }

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
  private shockDir: ShockDirection | null = null;

  constructor(userId: string, settings: Settings, log: Log) {
    this.userId = userId;
    this.settings = settings;
    this.log = log;
    this.startEquity = settings.paper_equity;
    this.dayStartEquity = settings.paper_equity;
  }

  /** The browser engine simulates fills; it must never touch a live account. */
  private isLive() { return this.settings.mode === "live"; }

  async start() {
    if (this.running) return;
    if (this.isLive()) {
      this.log("info", "Live mode — browser engine stays idle; the server agent handles live trading.");
      return;
    }
    this.running = true;
    this.log("info", "Engine starting (paper mode)");
    await this.syncPositions();
    // Prime meta + prices
    const [m, c] = await fetchMetaAndCtxs();
    this.meta = m.universe;
    this.ctxs = c;
    this.unsubMids = subscribeAllMids(mids => { this.mids = { ...this.mids, ...mids }; });
    // Tick loop — every 2s check SL/TP/trailing on open positions
    this.tickTimer = setInterval(() => this.tick(), 2000);
    // Strategy eval — every 15s scan a slice of universe
    this.evalTimer = setInterval(() => this.evalCycle().catch(err => this.log("error", err.message)), 15000);
  }

  async syncPositions() {
    // Load current open positions from DB so the engine never manages stale rows.
    const { data: openPos } = await supabase.from("paper_positions").select("*").eq("user_id", this.userId).eq("status", "open");
    this.positions = (openPos ?? []).map(p => ({
      id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional,
      leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss,
      take_profit: p.take_profit == null ? null : +p.take_profit, trail_high: p.trail_high != null ? +p.trail_high : null,
      confidence: +p.confidence,
    }));
    this.log("info", `Synced ${this.positions.length} open paper position(s)`);
  }

  stop() {
    this.running = false;
    this.unsubMids?.(); this.unsubMids = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    this.log("info", "Engine stopped");
  }

  updateSettings(s: Settings) {
    const wasLive = this.settings.mode === "live";
    // A balance change that isn't a trade (paper reset, manual edit, deposit)
    // must move the baseline too, otherwise the breaker reads the jump as a
    // huge daily loss. Only large discontinuities qualify — small deltas are
    // realised P&L written by the server agent and must stay in the day's P&L.
    const prevEq = this.settings.paper_equity;
    const delta = s.paper_equity - prevEq;
    if (prevEq > 0 && Math.abs(delta) > prevEq * 0.2) {
      this.startEquity += delta;
      this.dayStartEquity += delta;
    }

    this.settings = s;
    if (s.mode === "live" && this.running) {

      this.log("warn", "Switched to live mode — browser engine stopped; the server agent owns live trading.");
      this.stop();
    } else if (wasLive && s.mode === "paper" && !this.running) {
      this.start().catch(err => this.log("error", err.message));
    }
  }

  getPositions() { return this.positions; }
  getMids() { return this.mids; }
  getMeta() { return this.meta; }

  private mid(coin: string): number | null {
    const v = this.mids[coin]; return v ? +v : null;
  }

  private unrealizedPnl(p: OpenPosition, mark: number): number {
    return p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
  }

  private currentEquity(): number {
    let u = 0;
    for (const p of this.positions) {
      const m = this.mid(p.coin); if (m == null) continue;
      u += this.unrealizedPnl(p, m);
    }
    return this.startEquity + u;
  }

  private tick() {
    // Never manage positions or write snapshots while the account is live.
    if (this.isLive()) return;
    // Reset day start at UTC midnight
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    if (dayStart !== this.dayStartTs) {
      this.dayStartTs = dayStart;
      this.dayStartEquity = this.currentEquity();
    }

    // Daily circuit breaker
    const eq = this.currentEquity();
    const dayPnl = eq - this.dayStartEquity;
    const dayPnlPct = (dayPnl / this.dayStartEquity) * 100;
    if (dayPnlPct <= -this.settings.daily_loss_pct && this.settings.bot_enabled) {
      this.log("warn", `Daily loss limit hit (${dayPnlPct.toFixed(2)}%). Flattening & disabling bot.`);
      this.flattenAll("daily_loss_limit").catch(() => {});
      supabase.from("bot_settings").update({ bot_enabled: false }).eq("user_id", this.userId).then(() => {});
    }

    // Manage each open position
    for (const p of [...this.positions]) {
      const m = this.mid(p.coin); if (m == null) continue;
      // BTC shock protection runs BEFORE ordinary Safety Line / stop processing.
      if (this.shockDir && p.side === sideToFlatten(this.shockDir)) {
        this.closePosition(p, m, `btc_shock_${this.shockDir}`).catch(() => {});
        continue;
      }
      if (this.isPure()) {
        // The Safety Line (recomputed on each eval cycle) IS the stop, and
        // Pure Price has no fixed take-profit.
        const label = safetyExitReason(p.side, p.entry_price, m, p.stop_loss);
        if (label) this.closePosition(p, m, label).catch(() => {});
      } else {
        const t = updateTrail(p.side, p.entry_price, m, p.stop_loss, p.trail_high, this.exits());
        if (t.changed) { p.stop_loss = t.stopLoss; p.trail_high = t.trailHigh; this.persistPositionUpdate(p); }
        const label = exitReasonFor(p.side, m, p.stop_loss, p.take_profit ?? (p.side === "long" ? Infinity : 0), p.entry_price);
        if (label) this.closePosition(p, m, label).catch(() => {});
      }
    }

    // Equity snapshot every 60s
    const now = Date.now();
    if (now - this.snapshotTs > 60_000) {
      this.snapshotTs = now;
      const unreal = eq - this.startEquity;
      supabase.from("equity_snapshots").insert({
        user_id: this.userId, equity: eq, realized_pnl: 0, unrealized_pnl: unreal,
        mode: "paper",
      }).then(() => {});
    }
  }

  private async evalCycle() {
    if (!this.settings.bot_enabled || this.settings.kill_switch_engaged) return;
    if (this.settings.mode !== "paper") return; // safety
    // The always-on server agent owns entries when it is enabled; running both
    // races and can open two positions in the same coin.
    if (this.settings.server_agent_enabled) return;
    // Cycles can outlive the 15s timer (network waits) — never overlap them.
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      await this.runEvalCycle();
    } finally {
      this.evaluating = false;
    }
  }

  private cfg(): TrendlineConfig {
    return { ...DEFAULT_TRENDLINE_CONFIG, safetyBufferPct: +(this.settings.safety_buffer_pct ?? DEFAULT_TRENDLINE_CONFIG.safetyBufferPct) };
  }
  private execTf(): Timeframe {
    const tf = (this.settings.execution_timeframe ?? "1h") as Timeframe;
    return TIMEFRAME_MS[tf] ? tf : "1h";
  }
  private strategyKey(): StrategyKey { return normalizeStrategyKey(this.settings.strategy_key); }
  private isPure(): boolean { return this.strategyKey() === PURE_PRICE_STRATEGY_KEY; }
  private exits(): ExitParams {
    return {
      tpPct: +this.settings.scalp_tp_pct, slPct: +this.settings.scalp_sl_pct,
      trailActivatePct: +this.settings.trail_activate_pct, trailDistPct: +this.settings.trail_dist_pct,
    };
  }

  /** BTC shock protection — identical rule for paper and live. */
  private async refreshBtcShock() {
    try {
      const end = Date.now();
      const cs = await fetchCandles("BTC", "5m", end - 60 * 5 * 60_000, end);
      const bars = candlesToBars(cs).slice(0, -1);
      const shock = detectBtcShock(bars, {
        enabled: this.settings.btc_shock_enabled !== false,
        thresholdPct: +(this.settings.btc_shock_pct ?? DEFAULT_BTC_SHOCK.thresholdPct),
        windowMin: +(this.settings.btc_shock_window_min ?? DEFAULT_BTC_SHOCK.windowMin),
      });
      const prev = this.shockDir;
      this.shockDir = shock.direction;
      if (shock.direction && shock.direction !== prev) {
        this.log("warn", `BTC shock ${shock.direction} (${shock.movePct.toFixed(2)}%) — flattening all ${sideToFlatten(shock.direction).toUpperCase()} positions.`, { btcShock: shock });
      }
    } catch { /* leave the previous shock state on a fetch failure */ }
  }

  /** Confirmed 1H bars for the indicator strategies. */
  private async loadBars(coin: string): Promise<Bar[] | null> {
    try {
      const end = Date.now();
      const cs = await fetchCandles(coin, "1h", end - 230 * 60 * 60 * 1000, end);
      const bars = candlesToBars(cs).slice(0, -1);
      return bars.length ? bars : null;
    } catch { return null; }
  }

  /** Confirmed bars for the full Monthly → … → execution ladder (in-progress candle dropped). */
  private async loadLadder(coin: string): Promise<Partial<Record<Timeframe, Bar[]>>> {
    const out: Partial<Record<Timeframe, Bar[]>> = {};
    for (const tf of ladderFor(this.execTf())) {
      try {
        const end = Date.now();
        const cs = await fetchCandles(coin, tf, end - LADDER_BARS * TIMEFRAME_MS[tf], end);
        const bars = candlesToBars(cs).slice(0, -1);
        if (bars.length) out[tf] = bars;
      } catch { /* symbol has no history at this timeframe */ }
    }
    return out;
  }

  private async runEvalCycle() {
    const cfg = this.cfg();
    const execTf = this.execTf();
    await this.refreshBtcShock();
    if (!this.isPure()) { await this.runIndicatorCycle(); return; }

    // 1) Maintain open positions: re-derive the Safety Line and ratchet stops.
    for (const p of [...this.positions]) {
      const mark = this.mid(p.coin); if (mark == null) continue;
      const ladder = await this.loadLadder(p.coin);
      const { state } = evaluateTrendline({ coin: p.coin, barsByTimeframe: ladder, execution: execTf, cfg });
      const safety = currentSafetyLine(state, p.side, Date.now(), mark);
      const r = ratchetSafetyStop({ side: p.side, entry: p.entry_price, currentStop: p.stop_loss, safetyLineValue: safety, bufferPct: cfg.safetyBufferPct });
      if (r.changed) { p.stop_loss = r.stop; this.persistPositionUpdate(p); this.log("info", `Safety Line trail ${p.coin} → stop ${r.stop.toPrecision(6)}`); }
    }

    // 2) Scan for new Action Line breaks.
    const held = new Set(this.positions.map(p => p.coin));
    const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
    const scored = this.meta
      .map((m, i) => ({ meta: m, ctx: this.ctxs[i] }))
      .filter(x => x.ctx && +x.ctx.dayNtlVlm > 100_000 && !EXCLUDED_COINS.has(x.meta.name))
      .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm)
      .slice(0, 40);

    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const now = Date.now();
      const cached = this.cache.get(meta.name);
      if (cached && now < cached.nextEval) continue;
      let ladder = cached?.ladder;
      if (!ladder || now - (cached?.lastFetch ?? 0) > 5 * 60 * 1000) {
        ladder = await this.loadLadder(meta.name);
        this.cache.set(meta.name, { ladder, lastFetch: now, nextEval: now + 60_000 });
      }
      const { signal } = evaluateTrendline({ coin: meta.name, barsByTimeframe: ladder, execution: execTf, cfg });
      this.cache.get(meta.name)!.nextEval = Date.now() + 60_000;
      if (!signal.side || signal.initialStop == null) continue;
      if (this.positions.some(p => p.coin === meta.name)) continue;
      held.add(meta.name);
      await this.tryOpen(signal, meta);
    }
  }

  /** Entry scan for the two indicator strategies (Adaptive Trend Momentum, TrendBot). */
  private async runIndicatorCycle() {
    const key = this.strategyKey();
    const held = new Set(this.positions.map(p => p.coin));
    const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
    const scored = this.meta
      .map((m, i) => ({ meta: m, ctx: this.ctxs[i] }))
      .filter(x => x.ctx && +x.ctx.dayNtlVlm > 100_000 && !EXCLUDED_COINS.has(x.meta.name))
      .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm)
      .slice(0, 40);

    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const bars = await this.loadBars(meta.name);
      if (!bars || bars.length < 210) continue;
      const sig = evaluateScalp(meta.name, bars, key);
      if (!sig.side || sig.confidence < this.settings.min_confidence) continue;
      if (this.positions.some(p => p.coin === meta.name)) continue;
      held.add(meta.name);
      await this.tryOpenIndicator(sig, meta);
    }
  }

  private async tryOpenIndicator(sig: ScalpSignal, meta: AssetMeta) {
    const side = sig.side!;
    const b = bucket(sig.coin);
    if (this.positions.filter(p => bucket(p.coin) === b).length >= 3) { this.log("info", `Skip ${sig.coin}: correlation bucket ${b} full`); return; }

    const equity = this.currentEquity();
    const leverage = Math.min(this.settings.max_leverage, meta.maxLeverage);
    const currentExposure = this.positions.reduce((s, p) => s + p.notional, 0);
    const headroom = equity * (this.settings.max_exposure_pct / 100) * this.settings.max_leverage - currentExposure;
    if (headroom <= 0) { this.log("info", `Skip ${sig.coin}: portfolio exposure would exceed limit`); return; }

    const notional = Math.min(equity * (this.settings.position_size_pct / 100) * leverage, headroom);
    const size = Number((notional / sig.price).toFixed(meta.szDecimals));
    if (!(size > 0)) { this.log("info", `Skip ${sig.coin}: size rounds to zero`); return; }
    const stopDist = sig.price * (this.settings.scalp_sl_pct / 100);
    const stop = side === "long" ? sig.price - stopDist : sig.price + stopDist;
    const tpDist = sig.price * (this.settings.scalp_tp_pct / 100);
    const tp = side === "long" ? sig.price + tpDist : sig.price - tpDist;

    const reason = `${side.toUpperCase()} ${sig.coin} [${sig.family}] — ${sig.reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({
      user_id: this.userId, coin: sig.coin, side, size, notional: size * sig.price,
      leverage, entry_price: sig.price, stop_loss: stop, take_profit: tp,
      confidence: sig.confidence, reason, indicators: sig.indicators as never,
      timeframe: "1h", initial_stop: stop,
    }).select().single();
    if (error || !data) { this.log("error", `Failed to open ${sig.coin}: ${error?.message}`); return; }
    this.positions.push({
      id: data.id, coin: sig.coin, side, size, notional: size * sig.price, leverage,
      entry_price: sig.price, stop_loss: stop, take_profit: tp, trail_high: sig.price, confidence: sig.confidence,
    });
    this.log("trade", `OPEN ${reason} @ ${sig.price.toPrecision(6)} · stop ${stop.toPrecision(6)} · tp ${tp.toPrecision(6)} · size ${size}`);
  }

  private async tryOpen(sig: TrendlineSignal, meta: AssetMeta) {
    const side = sig.side!;
    const b = bucket(sig.coin);
    if (this.positions.filter(p => bucket(p.coin) === b).length >= 3) { this.log("info", `Skip ${sig.coin}: correlation bucket ${b} full`); return; }

    const equity = this.currentEquity();
    const currentExposure = this.positions.reduce((s, p) => s + p.notional, 0);
    const headroom = equity * (this.settings.max_exposure_pct / 100) * this.settings.max_leverage - currentExposure;
    if (headroom <= 0) { this.log("info", `Skip ${sig.coin}: portfolio exposure would exceed limit`); return; }

    // Pure Price uses the market's MAXIMUM Hyperliquid leverage, not 1x and not
    // a 1%-of-equity risk budget. Exposure headroom still bounds the notional.
    const stop = sig.initialStop!;
    const sized = sizeAtMaxLeverage({ equity, entry: sig.price, stop, marketMaxLeverage: meta.maxLeverage, szDecimals: meta.szDecimals, maxNotional: headroom });
    if (!sized.ok) { this.log("info", `Skip ${sig.coin}: ${sized.reason}`); return; }

    const reason = `${side.toUpperCase()} ${sig.coin} — ${sig.reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({
      user_id: this.userId, coin: sig.coin, side, size: sized.size, notional: sized.notional,
      leverage: sized.leverage, entry_price: sig.price, stop_loss: stop, take_profit: null,
      confidence: sig.confidence, reason, indicators: sig.detail as never,
      safety_line: sig.safetyLine?.value ?? null, action_line: sig.actionLine?.value ?? null,
      timeframe: sig.timeframe, initial_stop: stop, risk_pct: null,
    }).select().single();
    if (error || !data) { this.log("error", `Failed to open ${sig.coin}: ${error?.message}`); return; }
    this.positions.push({
      id: data.id, coin: sig.coin, side, size: sized.size, notional: sized.notional,
      leverage: sized.leverage, entry_price: sig.price, stop_loss: stop, take_profit: null,
      trail_high: null, confidence: sig.confidence,
    });
    this.log("trade", `OPEN ${reason} @ ${sig.price.toPrecision(6)} · stop ${stop.toPrecision(6)} · leverage ${sized.leverage}x (market max) · size ${sized.size}`);
  }

  private async closePosition(p: OpenPosition, price: number, exitReason: string) {
    // A live row mirrors a real Hyperliquid position. Marking it "closed" here would
    // leave the exchange position open while the app thinks it's flat — refuse.
    if (this.isLive()) {
      this.log("error", `Refused to close ${p.coin} from the browser: live positions must be closed by the server agent via a real order.`);
      return;
    }
    const pnl = this.unrealizedPnl(p, price);
    this.positions = this.positions.filter(x => x.id !== p.id);
    this.startEquity += pnl; // realise
    await supabase.from("paper_positions").update({
      status: "closed", exit_price: price, exit_reason: exitReason, pnl, closed_at: new Date().toISOString(),
    }).eq("id", p.id);
    this.log("trade", `CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${price.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${exitReason}`);
  }

  async flattenAll(reason: string) {
    if (this.isLive()) {
      this.log("error", "Refused to flatten from the browser in live mode — engage the kill switch so the server agent closes positions with real orders.");
      return;
    }
    for (const p of [...this.positions]) {
      const m = this.mid(p.coin) ?? p.entry_price;
      await this.closePosition(p, m, reason);
    }
  }

  private persistPositionUpdate(p: OpenPosition) {
    supabase.from("paper_positions").update({
      stop_loss: p.stop_loss, trail_high: p.trail_high,
    }).eq("id", p.id).then(() => {});
  }
}
