import { fetchCandles, fetchMetaAndCtxs, subscribeAllMids, type AssetCtx, type AssetMeta } from "./hyperliquid";
import { candlesToBars, bucket, type Bar, type StrategyMode } from "./strategy";
import {
  DEFAULT_TRENDLINE_CONFIG, TIMEFRAME_MS, ladderFor, evaluateTrendline, currentSafetyLine,
  ratchetSafetyStop, safetyExitReason, sizeFromRisk,
  type Timeframe, type TrendlineConfig, type TrendlineSignal,
} from "./trendline";
import { supabase } from "@/integrations/supabase/client";

export interface Settings {
  user_id: string; mode: "paper" | "live"; strategy_mode: StrategyMode; paper_equity: number;
  max_leverage: number; position_size_pct: number; max_exposure_pct: number; daily_loss_pct: number;
  max_positions: number; min_confidence: number; sl_type: "atr" | "fixed"; sl_atr_mult: number; sl_fixed_pct: number;
  tp_rr: number; trailing_enabled: boolean; bot_enabled: boolean; kill_switch_engaged: boolean;
  server_agent_enabled: boolean; ai_review_enabled: boolean; scalp_enabled: boolean; scalp_tp_pct: number; scalp_sl_pct: number;
  trail_activate_pct: number; trail_dist_pct: number; last_cycle_at: string | null; last_cycle_note: string | null;
  strategy_key?: string; trendline_risk_pct?: number; execution_timeframe?: string; safety_buffer_pct?: number;
  /** Percent BTC can move between paper ticks before opposing positions are flattened. */
  btc_shock_pct?: number;
  live_max_alloc_usd: number;
}

export interface OpenPosition {
  id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number;
  entry_price: number; stop_loss: number; take_profit: number | null; trail_high: number | null; confidence: number;
}

type Log = (level: "info" | "warn" | "error" | "trade", msg: string, meta?: any) => void;
const LADDER_BARS = 300;
interface CoinCache { ladder: Partial<Record<Timeframe, Bar[]>>; lastFetch: number; nextEval: number }

export class PaperEngine {
  private userId: string; private settings: Settings; private mids: Record<string, string> = {};
  private meta: AssetMeta[] = []; private ctxs: AssetCtx[] = []; private cache = new Map<string, CoinCache>();
  private positions: OpenPosition[] = []; private unsubMids: (() => void) | null = null; private tickTimer: any = null; private evalTimer: any = null;
  private log: Log; private startEquity: number; private dayStartEquity: number;
  private dayStartTs: number = new Date().setUTCHours(0, 0, 0, 0); private snapshotTs = 0; private running = false; private evaluating = false;
  private lastBtcMid: number | null = null;

  constructor(userId: string, settings: Settings, log: Log) { this.userId = userId; this.settings = settings; this.log = log; this.startEquity = settings.paper_equity; this.dayStartEquity = settings.paper_equity; }
  private isLive() { return this.settings.mode === "live"; }

  async start() {
    if (this.running) return;
    if (this.isLive()) { this.log("info", "Live mode — browser engine stays idle; the server agent handles live trading."); return; }
    this.running = true; this.log("info", "Engine starting (paper mode)"); await this.syncPositions();
    const [m, c] = await fetchMetaAndCtxs(); this.meta = m.universe; this.ctxs = c;
    this.unsubMids = subscribeAllMids(mids => { this.mids = { ...this.mids, ...mids }; });
    this.tickTimer = setInterval(() => this.tick(), 2000);
    this.evalTimer = setInterval(() => this.evalCycle().catch(err => this.log("error", err.message)), 15000);
  }

  async syncPositions() {
    const { data: openPos } = await supabase.from("paper_positions").select("*").eq("user_id", this.userId).eq("status", "open");
    this.positions = (openPos ?? []).map(p => ({ id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional, leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss, take_profit: p.take_profit == null ? null : +p.take_profit, trail_high: p.trail_high != null ? +p.trail_high : null, confidence: +p.confidence }));
    this.log("info", `Synced ${this.positions.length} open paper position(s)`);
  }

  stop() { this.running = false; this.unsubMids?.(); this.unsubMids = null; if (this.tickTimer) clearInterval(this.tickTimer); if (this.evalTimer) clearInterval(this.evalTimer); this.log("info", "Engine stopped"); }

  updateSettings(s: Settings) {
    const wasLive = this.settings.mode === "live"; const prevEq = this.settings.paper_equity; const delta = s.paper_equity - prevEq;
    if (prevEq > 0 && Math.abs(delta) > prevEq * 0.2) { this.startEquity += delta; this.dayStartEquity += delta; }
    this.settings = s;
    if (s.mode === "live" && this.running) { this.log("warn", "Switched to live mode — browser engine stopped; the server agent owns live trading."); this.stop(); }
    else if (wasLive && s.mode === "paper" && !this.running) this.start().catch(err => this.log("error", err.message));
  }
  getPositions() { return this.positions; } getMids() { return this.mids; } getMeta() { return this.meta; }
  private mid(coin: string): number | null { const v = this.mids[coin]; return v ? +v : null; }
  private unrealizedPnl(p: OpenPosition, mark: number): number { return p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size; }
  private currentEquity(): number { let u = 0; for (const p of this.positions) { const m = this.mid(p.coin); if (m == null) continue; u += this.unrealizedPnl(p, m); } return this.startEquity + u; }

  private tick() {
    if (this.isLive()) return;
    const dayStart = new Date().setUTCHours(0, 0, 0, 0); if (dayStart !== this.dayStartTs) { this.dayStartTs = dayStart; this.dayStartEquity = this.currentEquity(); }

    // Emergency BTC shock guard: a sudden BTC move closes positions in the
    // opposite direction before ordinary Safety Line processing. This uses
    // the live websocket mid, so paper positions react within the 2s tick.
    const btc = this.mid("BTC");
    if (btc != null) {
      if (this.lastBtcMid != null && this.lastBtcMid > 0) {
        const movePct = ((btc - this.lastBtcMid) / this.lastBtcMid) * 100;
        const threshold = Math.max(0.1, +(this.settings.btc_shock_pct ?? 1));
        if (Math.abs(movePct) >= threshold) {
          const shockSide: "long" | "short" = movePct < 0 ? "long" : "short";
          for (const p of [...this.positions]) {
            if (p.side === shockSide) this.closePosition(p, this.mid(p.coin) ?? p.entry_price, `btc_shock_${movePct < 0 ? "down" : "up"}`).catch(() => {});
          }
          this.log("warn", `BTC shock ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% — flattened opposing ${shockSide}s`);
        }
      }
      this.lastBtcMid = btc;
    }

    const eq = this.currentEquity(); const dayPnl = eq - this.dayStartEquity; const dayPnlPct = (dayPnl / this.dayStartEquity) * 100;
    if (dayPnlPct <= -this.settings.daily_loss_pct && this.settings.bot_enabled) {
      this.log("warn", `Daily loss limit hit (${dayPnlPct.toFixed(2)}%). Flattening & disabling bot.`);
      this.flattenAll("daily_loss_limit").catch(() => {}); supabase.from("bot_settings").update({ bot_enabled: false }).eq("user_id", this.userId).then(() => {});
    }

    for (const p of [...this.positions]) {
      const m = this.mid(p.coin); if (m == null) continue;
      if (p.side === "long") { const label = safetyExitReason("long", p.entry_price, m, p.stop_loss); if (label) this.closePosition(p, m, label).catch(() => {}); else if (p.take_profit != null && m >= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {}); }
      else { const label = safetyExitReason("short", p.entry_price, m, p.stop_loss); if (label) this.closePosition(p, m, label).catch(() => {}); else if (p.take_profit != null && m <= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {}); }
    }

    const now = Date.now(); if (now - this.snapshotTs > 60_000) { this.snapshotTs = now; const unreal = eq - this.startEquity; supabase.from("equity_snapshots").insert({ user_id: this.userId, equity: eq, realized_pnl: 0, unrealized_pnl: unreal, mode: "paper" }).then(() => {}); }
  }

  private async evalCycle() {
    if (!this.settings.bot_enabled || this.settings.kill_switch_engaged || this.settings.mode !== "paper" || this.settings.server_agent_enabled || this.evaluating) return;
    this.evaluating = true; try { await this.runEvalCycle(); } finally { this.evaluating = false; }
  }
  private cfg(): TrendlineConfig { return { ...DEFAULT_TRENDLINE_CONFIG, safetyBufferPct: +(this.settings.safety_buffer_pct ?? DEFAULT_TRENDLINE_CONFIG.safetyBufferPct) }; }
  private execTf(): Timeframe { const tf = (this.settings.execution_timeframe ?? "1h") as Timeframe; return TIMEFRAME_MS[tf] ? tf : "1h"; }

  private async loadLadder(coin: string): Promise<Partial<Record<Timeframe, Bar[]>>> {
    const out: Partial<Record<Timeframe, Bar[]>> = {};
    for (const tf of ladderFor(this.execTf())) { try { const end = Date.now(); const cs = await fetchCandles(coin, tf, end - LADDER_BARS * TIMEFRAME_MS[tf], end); const bars = candlesToBars(cs).slice(0, -1); if (bars.length) out[tf] = bars; } catch {} }
    return out;
  }

  private async runEvalCycle() {
    const cfg = this.cfg(); const execTf = this.execTf();
    for (const p of [...this.positions]) { const mark = this.mid(p.coin); if (mark == null) continue; const ladder = await this.loadLadder(p.coin); const { state } = evaluateTrendline({ coin: p.coin, barsByTimeframe: ladder, execution: execTf, cfg }); const safety = currentSafetyLine(state, p.side, Date.now(), mark); const r = ratchetSafetyStop({ side: p.side, entry: p.entry_price, currentStop: p.stop_loss, safetyLineValue: safety, bufferPct: cfg.safetyBufferPct }); if (r.changed) { p.stop_loss = r.stop; this.persistPositionUpdate(p); this.log("info", `Safety Line trail ${p.coin} → stop ${r.stop.toPrecision(6)}`); } }

    const held = new Set(this.positions.map(p => p.coin)); const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
    const scored = this.meta.map((m, i) => ({ meta: m, ctx: this.ctxs[i] })).filter(x => x.ctx && +x.ctx.dayNtlVlm > 100_000 && !EXCLUDED_COINS.has(x.meta.name)).sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm).slice(0, 40);
    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions || held.has(meta.name)) break;
      const now = Date.now(); const cached = this.cache.get(meta.name); if (cached && now < cached.nextEval) continue;
      let ladder = cached?.ladder;
      if (!ladder || now - (cached?.lastFetch ?? 0) > 5 * 60 * 1000) { ladder = await this.loadLadder(meta.name); this.cache.set(meta.name, { ladder, lastFetch: now, nextEval: now + 60_000 }); }
      const { signal } = evaluateTrendline({ coin: meta.name, barsByTimeframe: ladder, execution: execTf, cfg }); this.cache.get(meta.name)!.nextEval = Date.now() + 60_000;
      if (!signal.side || signal.initialStop == null || this.positions.some(p => p.coin === meta.name)) continue;
      held.add(meta.name); await this.tryOpen(signal, meta);
    }
  }

  private async tryOpen(sig: TrendlineSignal, meta: AssetMeta) {
    const side = sig.side!; const b = bucket(sig.coin);
    if (this.positions.filter(p => bucket(p.coin) === b).length >= 3) { this.log("info", `Skip ${sig.coin}: correlation bucket ${b} full`); return; }
    const equity = this.currentEquity(); const currentExposure = this.positions.reduce((s, p) => s + p.notional, 0);
    const headroom = equity * (this.settings.max_exposure_pct / 100) - currentExposure;
    if (headroom <= 0) { this.log("info", `Skip ${sig.coin}: portfolio exposure would exceed limit`); return; }
    const stop = sig.initialStop!;
    const sized = sizeFromRisk({ equity, entry: sig.price, stop, szDecimals: meta.szDecimals, maxLeverage: 1, maxNotional: headroom });
    if (!sized.ok) { this.log("info", `Skip ${sig.coin}: ${sized.reason}`); return; }
    const reason = `${side.toUpperCase()} ${sig.coin} — ${sig.reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({ user_id: this.userId, coin: sig.coin, side, size: sized.size, notional: sized.notional, leverage: 1, entry_price: sig.price, stop_loss: stop, take_profit: null, confidence: sig.confidence, reason, indicators: sig.detail as never, safety_line: sig.safetyLine?.value ?? null, action_line: sig.actionLine?.value ?? null, timeframe: sig.timeframe, initial_stop: stop, risk_pct: null }).select().single();
    if (error || !data) { this.log("error", `Failed to open ${sig.coin}: ${error?.message}`); return; }
    this.positions.push({ id: data.id, coin: sig.coin, side, size: sized.size, notional: sized.notional, leverage: 1, entry_price: sig.price, stop_loss: stop, take_profit: null, trail_high: null, confidence: sig.confidence });
    this.log("trade", `OPEN ${reason} @ ${sig.price.toPrecision(6)} · stop ${stop.toPrecision(6)} · leverage 1x · size ${sized.size}`);
  }

  private async closePosition(p: OpenPosition, price: number, exitReason: string) {
    if (this.isLive()) { this.log("error", `Refused to close ${p.coin} from the browser: live positions must be closed by the server agent via a real order.`); return; }
    const pnl = this.unrealizedPnl(p, price); this.positions = this.positions.filter(x => x.id !== p.id); this.startEquity += pnl;
    await supabase.from("paper_positions").update({ status: "closed", exit_price: price, exit_reason: exitReason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id);
    this.log("trade", `CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${price.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${exitReason}`);
  }
  async flattenAll(reason: string) { if (this.isLive()) { this.log("error", "Refused to flatten from the browser in live mode — engage the kill switch so the server agent closes positions with real orders."); return; } for (const p of [...this.positions]) { const m = this.mid(p.coin) ?? p.entry_price; await this.closePosition(p, m, reason); } }
  private persistPositionUpdate(p: OpenPosition) { supabase.from("paper_positions").update({ stop_loss: p.stop_loss, trail_high: p.trail_high }).eq("id", p.id).then(() => {}); }
}
