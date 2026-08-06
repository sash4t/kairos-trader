import { fetchCandles, fetchMetaAndCtxs, subscribeAllMids, type AssetCtx, type AssetMeta } from "./hyperliquid";
import { candlesToBars, evaluateSignal, bucket, type Signal, type Bar, MODE_MIN_CONFIDENCE, type StrategyMode } from "./strategy";
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
  take_profit: number;
  trail_high: number | null;
  confidence: number;
}

type Log = (level: "info" | "warn" | "error" | "trade", msg: string, meta?: any) => void;

// Backtested (3mo, BTC/SOL/ARB/LINK/DOGE): 1h bars materially outperform 15m —
// 15m churns (1217 trades, PF 0.66) while 1h fresh-cross entries yield PF 1.78.
const CANDLE_INTERVAL = "1h";
const CANDLE_MS = 60 * 60 * 1000;
const BARS_NEEDED = 220;

interface CoinCache { bars: Bar[]; lastFetch: number; nextEval: number }

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

  constructor(userId: string, settings: Settings, log: Log) {
    this.userId = userId;
    this.settings = settings;
    this.log = log;
    this.startEquity = settings.paper_equity;
    this.dayStartEquity = settings.paper_equity;
  }

  async start() {
    if (this.running) return;
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
      take_profit: +p.take_profit, trail_high: p.trail_high != null ? +p.trail_high : null,
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

  updateSettings(s: Settings) { this.settings = s; }

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
      // trailing
      if (this.settings.trailing_enabled) {
        if (p.side === "long") {
          const th = p.trail_high == null ? p.entry_price : Math.max(p.trail_high, m);
          if (th !== p.trail_high) {
            p.trail_high = th;
            const r = p.entry_price - p.stop_loss;
            if (m > p.entry_price + r) {
              const newSl = Math.max(p.stop_loss, th - r);
              if (newSl > p.stop_loss) { p.stop_loss = newSl; this.persistPositionUpdate(p); }
            }
          }
        } else {
          const th = p.trail_high == null ? p.entry_price : Math.min(p.trail_high, m);
          if (th !== p.trail_high) {
            p.trail_high = th;
            const r = p.stop_loss - p.entry_price;
            if (m < p.entry_price - r) {
              const newSl = Math.min(p.stop_loss, th + r);
              if (newSl < p.stop_loss) { p.stop_loss = newSl; this.persistPositionUpdate(p); }
            }
          }
        }
      }
      // SL / TP
      if (p.side === "long") {
        if (m <= p.stop_loss) this.closePosition(p, m, "stop_loss").catch(() => {});
        else if (m >= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {});
      } else {
        if (m >= p.stop_loss) this.closePosition(p, m, "stop_loss").catch(() => {});
        else if (m <= p.take_profit) this.closePosition(p, m, "take_profit").catch(() => {});
      }
    }

    // Equity snapshot every 60s
    const now = Date.now();
    if (now - this.snapshotTs > 60_000) {
      this.snapshotTs = now;
      const unreal = eq - this.startEquity;
      supabase.from("equity_snapshots").insert({
        user_id: this.userId, equity: eq, realized_pnl: 0, unrealized_pnl: unreal,
      }).then(() => {});
    }
  }

  private async evalCycle() {
    if (!this.settings.bot_enabled || this.settings.kill_switch_engaged) return;
    if (this.settings.mode !== "paper") return; // safety
    // scan up to 8 coins per cycle prioritising liquid ones without positions
    const held = new Set(this.positions.map(p => p.coin));
    const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
    const scored = this.meta
      .map((m, i) => ({ meta: m, ctx: this.ctxs[i] }))
      .filter(x => x.ctx && +x.ctx.dayNtlVlm > 100_000 && !EXCLUDED_COINS.has(x.meta.name))
      .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);

    for (const { meta } of scored) {
      if (this.positions.length >= this.settings.max_positions) break;
      if (held.has(meta.name)) continue;
      const now = Date.now();
      const cached = this.cache.get(meta.name);
      if (cached && now < cached.nextEval) continue;
      // fetch/refresh candles (throttled)
      let bars: Bar[] | undefined = cached?.bars;
      if (!bars || now - (cached?.lastFetch ?? 0) > 5 * 60 * 1000) {
        try {
          const end = now;
          const start = end - BARS_NEEDED * CANDLE_MS;
          const cs = await fetchCandles(meta.name, CANDLE_INTERVAL, start, end);
          bars = candlesToBars(cs);
          this.cache.set(meta.name, { bars, lastFetch: now, nextEval: now + 30_000 });
        } catch { continue; }
      }
      if (!bars || bars.length < BARS_NEEDED) continue;
      const sig = evaluateSignal(meta.name, bars);
      this.cache.get(meta.name)!.nextEval = now + 60_000;
      if (!sig.side) continue;
      const threshold = Math.max(this.settings.min_confidence, MODE_MIN_CONFIDENCE[this.settings.strategy_mode]);
      if (sig.confidence < threshold) continue;
      await this.tryOpen(sig, meta);
    }
  }

  private async tryOpen(sig: Signal, meta: AssetMeta) {
    const side = sig.side!; // caller ensured non-null
    // correlation guard
    const b = bucket(sig.coin);
    const bucketCount = this.positions.filter(p => bucket(p.coin) === b).length;
    if (bucketCount >= 2) { this.log("info", `Skip ${sig.coin}: correlation bucket ${b} full`); return; }

    const equity = this.currentEquity();
    const notionalCap = equity * (this.settings.position_size_pct / 100) * Math.min(this.settings.max_leverage, meta.maxLeverage);
    // check exposure
    const currentExposure = this.positions.reduce((s, p) => s + p.notional, 0);
    if (currentExposure + notionalCap > equity * (this.settings.max_exposure_pct / 100) * this.settings.max_leverage) {
      this.log("info", `Skip ${sig.coin}: portfolio exposure would exceed limit`); return;
    }

    const leverage = Math.min(this.settings.max_leverage, meta.maxLeverage);
    const size = notionalCap / sig.price;
    const stopDist = this.settings.sl_type === "atr"
      ? sig.atrValue * this.settings.sl_atr_mult
      : sig.price * (this.settings.sl_fixed_pct / 100);
    const sl = side === "long" ? sig.price - stopDist : sig.price + stopDist;
    const tp = side === "long" ? sig.price + stopDist * this.settings.tp_rr : sig.price - stopDist * this.settings.tp_rr;

    const reason = `${side.toUpperCase()} ${sig.coin} — ${sig.reasons.join(" + ")}`;
    const { data, error } = await supabase.from("paper_positions").insert({
      user_id: this.userId, coin: sig.coin, side, size, notional: size * sig.price,
      leverage, entry_price: sig.price, stop_loss: sl, take_profit: tp,
      confidence: sig.confidence, reason, indicators: sig.indicators,
    }).select().single();
    if (error || !data) { this.log("error", `Failed to open ${sig.coin}: ${error?.message}`); return; }
    this.positions.push({
      id: data.id, coin: sig.coin, side, size, notional: size * sig.price,
      leverage, entry_price: sig.price, stop_loss: sl, take_profit: tp,
      trail_high: null, confidence: sig.confidence,
    });
    this.log("trade", `OPEN ${reason} @ ${sig.price.toFixed(6)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)} · conf ${sig.confidence}`);
  }

  private async closePosition(p: OpenPosition, price: number, exitReason: string) {
    const pnl = this.unrealizedPnl(p, price);
    this.positions = this.positions.filter(x => x.id !== p.id);
    this.startEquity += pnl; // realise
    await supabase.from("paper_positions").update({
      status: "closed", exit_price: price, exit_reason: exitReason, pnl, closed_at: new Date().toISOString(),
    }).eq("id", p.id);
    this.log("trade", `CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${price.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${exitReason}`);
  }

  async flattenAll(reason: string) {
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
