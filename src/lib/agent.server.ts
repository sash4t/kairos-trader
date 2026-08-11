import { NoObjectGeneratedError, generateObject } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { candlesToBars, bucket, type Bar } from "./strategy";
import { evaluateScalp, exitReasonFor, updateTrail, type ExitParams, type ScalpSignal } from "./scalp";
import { normalizeStrategyKey, PURE_PRICE_STRATEGY_KEY, type StrategyKey } from "./strategies";
import { detectBtcShock, sideToFlatten, DEFAULT_BTC_SHOCK, type ShockDirection } from "./btcShock";
import {
  DEFAULT_TRENDLINE_CONFIG, TIMEFRAME_MS, ladderFor, evaluateTrendline,
  currentSafetyLine, ratchetSafetyStop, safetyExitReason, sizeAtMaxLeverage, resolveMaxLeverage,
  type Timeframe, type TrendlineConfig, type TrendlineSignal,
} from "./trendline";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const INTERVAL = "1h";
const INTERVAL_MS = 60 * 60 * 1000;
const BARS = 230;
const SCAN_PER_CYCLE = 35;
/** Multi-timeframe scans cost 5 requests per coin, so the trendline strategy scans fewer per cycle. */
const TRENDLINE_SCAN_PER_CYCLE = 8;
const MIN_24H_VOLUME = 100_000;
/** Bars requested per timeframe when building the top-down ladder. */
const LADDER_BARS = 300;

type Level = "info" | "warn" | "error" | "trade" | "ai";
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
  ai_review_enabled: boolean; scalp_enabled: boolean; scalp_tp_pct: number; scalp_sl_pct: number;
  trail_activate_pct: number; trail_dist_pct: number; max_positions: number; max_leverage: number;
  position_size_pct: number; max_exposure_pct: number; daily_loss_pct: number; min_confidence: number;
  paper_equity: number; mode: string; live_max_alloc_usd: number; tp_rr: number; strategy_key?: string;
  trendline_risk_pct?: number; execution_timeframe?: string; safety_buffer_pct?: number;
  btc_shock_enabled?: boolean; btc_shock_pct?: number; btc_shock_window_min?: number;
}
interface PositionRow { id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number; entry_price: number; stop_loss: number; take_profit: number | null; trail_high: number | null; confidence: number }

function trendlineCfg(s: Settings): TrendlineConfig {
  return { ...DEFAULT_TRENDLINE_CONFIG, safetyBufferPct: +(s.safety_buffer_pct ?? DEFAULT_TRENDLINE_CONFIG.safetyBufferPct) };
}
function executionTimeframe(s: Settings): Timeframe {
  const tf = (s.execution_timeframe ?? "1h") as Timeframe;
  return TIMEFRAME_MS[tf] ? tf : "1h";
}

/** Runs one full monitor → manage → scan → review → enter cycle for every enabled user. */
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
  /** Fetch confirmed bars for one coin/interval. The in-progress candle is always dropped (no look-ahead). */
  const loadInterval = async (coin: string, interval: Timeframe, count: number): Promise<Bar[] | null> => {
    const key = `${coin}:${interval}`;
    if (barCache.has(key)) return barCache.get(key)!;
    try {
      const end = Date.now();
      const candles = await hl<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - count * TIMEFRAME_MS[interval], endTime: end } });
      const bars = candlesToBars(candles as never).slice(0, -1);
      barCache.set(key, bars);
      return bars;
    } catch { return null; }
  };
  const loadBars = async (coin: string): Promise<Bar[] | null> => loadInterval(coin, INTERVAL as Timeframe, BARS);
  /** Full Monthly → … → execution ladder for one coin. */
  const loadLadder = async (coin: string, execution: Timeframe): Promise<Partial<Record<Timeframe, Bar[]>>> => {
    const out: Partial<Record<Timeframe, Bar[]>> = {};
    for (const tf of ladderFor(execution)) {
      const bars = await loadInterval(coin, tf, LADDER_BARS);
      if (bars && bars.length) out[tf] = bars;
    }
    return out;
  };

  for (const raw of users) {
    const s = raw as unknown as Settings;
    const notes: string[] = [];
    try {
      const isLive = s.mode === "live";
      const strategyKey: StrategyKey = normalizeStrategyKey(s.strategy_key);
      const isTrendline = strategyKey === PURE_PRICE_STRATEGY_KEY;
      const cfg = trendlineCfg(s);
      const execTf = executionTimeframe(s);
      if (isLive && !creds) { notes.push("live mode on but API wallet not configured — no orders sent"); await log(s.user_id, "error", "Live mode is on but Hyperliquid API credentials are missing."); }
      let canTrade = !isLive || !!creds;
      const exits: ExitParams = { tpPct: +s.scalp_tp_pct, slPct: +s.scalp_sl_pct, trailActivatePct: +s.trail_activate_pct, trailDistPct: +s.trail_dist_pct };
      const { data: openRaw } = await supabaseAdmin.from("paper_positions").select("*").eq("user_id", s.user_id).eq("status", "open");
      let positions = (openRaw ?? []).map((p) => ({ id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional, leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss, take_profit: p.take_profit == null ? null : +p.take_profit, trail_high: p.trail_high == null ? null : +p.trail_high, confidence: +p.confidence })) as PositionRow[];
      let liveAcct: Awaited<ReturnType<typeof fetchLiveAccount>> | null = null;
      if (isLive && creds) {
        try { liveAcct = await fetchLiveAccount(creds.accountAddress); }
        catch (err) { canTrade = false; const msg = err instanceof Error ? err.message : String(err); notes.push(`live account read failed: ${msg}`); await log(s.user_id, "error", `Could not read Hyperliquid account — trading paused this cycle: ${msg}`); }
        if (liveAcct) {
          const onChain = new Map(liveAcct.positions.map((p) => [p.coin, p]));
          for (const p of [...positions]) {
            const real = onChain.get(p.coin);
            if (!real || real.side !== p.side) { const mark = mids[p.coin] ? +mids[p.coin] : p.entry_price; const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size; await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: mark, exit_reason: "reconciled", pnl, closed_at: new Date().toISOString() }).eq("id", p.id); positions = positions.filter((x) => x.id !== p.id); await log(s.user_id, "warn", `Reconciled ${p.coin}: no matching live position on Hyperliquid, marked closed.`, { live: true }); continue; }
            if (Math.abs(real.size - p.size) > p.size * 0.01 || Math.abs(real.entryPrice - p.entry_price) > p.entry_price * 0.001) { p.size = real.size; p.entry_price = real.entryPrice; p.notional = real.size * real.entryPrice; await supabaseAdmin.from("paper_positions").update({ size: p.size, entry_price: p.entry_price, notional: p.notional }).eq("id", p.id); }
          }
          const untracked = liveAcct.positions.filter((p) => !positions.some((x) => x.coin === p.coin));
          if (untracked.length) notes.push(`untracked live positions: ${untracked.map((p) => p.coin).join(", ")}`);
        }
      }
      let realised = 0;
      // BTC shock protection runs BEFORE ordinary Safety Line processing.
      let shockDir: ShockDirection | null = null;
      if (positions.length) {
        const btcBars = await loadInterval("BTC", "5m", 60);
        if (btcBars && btcBars.length > 2) {
          const shock = detectBtcShock(btcBars, { enabled: s.btc_shock_enabled !== false, thresholdPct: +(s.btc_shock_pct ?? DEFAULT_BTC_SHOCK.thresholdPct), windowMin: +(s.btc_shock_window_min ?? DEFAULT_BTC_SHOCK.windowMin) });
          shockDir = shock.direction;
          if (shockDir) {
            notes.push(`BTC shock ${shockDir} ${shock.movePct.toFixed(2)}%`);
            await log(s.user_id, "warn", `BTC shock ${shockDir} (${shock.movePct.toFixed(2)}% over ${s.btc_shock_window_min ?? DEFAULT_BTC_SHOCK.windowMin}m) — flattening all ${sideToFlatten(shockDir).toUpperCase()} positions.`, { agent: "server", btcShock: shock, live: isLive });
          }
        }
      }
      for (const p of [...positions]) {
        const markStr = mids[p.coin]; if (!markStr) continue; const mark = +markStr;
        const forced = shockDir && p.side === sideToFlatten(shockDir) ? `btc_shock_${shockDir}` : null;
        let reason: string | null = forced;
        if (forced) { /* emergency directional flattening skips trailing work */ }
        else if (isTrendline) {
          // The Safety Line is the stop: re-derive it from live structure and
          // ratchet the stop toward it. It can only ever tighten.
          const ladder = await loadLadder(p.coin, execTf);
          const { state } = evaluateTrendline({ coin: p.coin, barsByTimeframe: ladder, execution: execTf, cfg });
          const safety = currentSafetyLine(state, p.side, Date.now(), mark);
          const r = ratchetSafetyStop({ side: p.side, entry: p.entry_price, currentStop: p.stop_loss, safetyLineValue: safety, bufferPct: cfg.safetyBufferPct });
          if (r.changed) {
            p.stop_loss = r.stop;
            await supabaseAdmin.from("paper_positions").update({ stop_loss: r.stop, safety_line: safety }).eq("id", p.id);
            await log(s.user_id, "info", `Safety Line trail ${p.coin}: stop → ${r.stop.toPrecision(6)}`, { agent: "server", coin: p.coin, safetyLine: safety, stop: r.stop });
          }
          reason = safetyExitReason(p.side, p.entry_price, mark, p.stop_loss);
        } else {
          const t = updateTrail(p.side, p.entry_price, mark, p.stop_loss, p.trail_high, exits);
          if (t.changed) { p.stop_loss = t.stopLoss; p.trail_high = t.trailHigh; await supabaseAdmin.from("paper_positions").update({ stop_loss: t.stopLoss, trail_high: t.trailHigh }).eq("id", p.id); }
          reason = exitReasonFor(p.side, mark, p.stop_loss, p.take_profit ?? (p.side === "long" ? Infinity : 0), p.entry_price);
        }
        if (!reason) continue;

        let exitPrice = mark; let exitSize = p.size;
        if (isLive && creds) { const asset = (await assets()).get(p.coin); if (!asset) { report.errors.push(`${p.coin}: unknown asset`); continue; } try { const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1 }); if (fill.size <= 0) { await log(s.user_id, "warn", `Live close for ${p.coin} did not fill — retrying next cycle.`); continue; } exitPrice = fill.avgPrice || mark; exitSize = fill.size; if (exitSize < p.size * 0.99) { const remaining = p.size - exitSize; const partialPnl = p.side === "long" ? (exitPrice - p.entry_price) * exitSize : (p.entry_price - exitPrice) * exitSize; p.size = remaining; p.notional = remaining * p.entry_price; await supabaseAdmin.from("paper_positions").update({ size: remaining, notional: p.notional }).eq("id", p.id); await log(s.user_id, "trade", `LIVE PARTIAL CLOSE ${p.coin} ${exitSize} @ ${exitPrice.toFixed(6)} · PnL ${partialPnl >= 0 ? "+" : ""}${partialPnl.toFixed(2)} USDC`, { agent: "server", live: true }); continue; } } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`close ${p.coin}: ${msg}`); await log(s.user_id, "error", `Live close failed for ${p.coin}: ${msg}`); continue; } }
        const pnl = p.side === "long" ? (exitPrice - p.entry_price) * exitSize : (p.entry_price - exitPrice) * exitSize;
        realised += pnl; await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: exitPrice, exit_reason: reason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id); positions = positions.filter((x) => x.id !== p.id); report.closed++;
        await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${exitPrice.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${reason}`, { agent: "server", reason, live: isLive, stop: p.stop_loss });
      }
      if (realised !== 0 && !isLive) { await supabaseAdmin.from("bot_settings").update({ paper_equity: +s.paper_equity + realised }).eq("user_id", s.user_id); s.paper_equity = +s.paper_equity + realised; }
      let unrealised = 0; for (const p of positions) { const m = mids[p.coin]; if (!m) continue; unrealised += p.side === "long" ? (+m - p.entry_price) * p.size : (p.entry_price - +m) * p.size; }
      let equityNow = +s.paper_equity + unrealised; let equityIsReal = !isLive;
      if (isLive && creds) { try { const acct = await fetchLiveAccount(creds.accountAddress); equityNow = acct.accountValue; unrealised = acct.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0); equityIsReal = true; } catch (err) { notes.push(`live account read failed: ${err instanceof Error ? err.message : String(err)}`); } }
      if (equityIsReal) await supabaseAdmin.from("equity_snapshots").insert({ user_id: s.user_id, equity: equityNow, realized_pnl: realised, unrealized_pnl: unrealised, mode: isLive ? "live" : "paper" });

      const perCycle = isTrendline ? TRENDLINE_SCAN_PER_CYCLE : SCAN_PER_CYCLE;
      const minute = Math.floor(Date.now() / 60_000);
      const offset = (minute * perCycle) % Math.max(1, liquid.length);
      const scanTargets = Array.from({ length: Math.min(perCycle, liquid.length) }, (_, i) => liquid[(offset + i) % liquid.length]);

      if (!canTrade) { }
      else if (!s.scalp_enabled) notes.push("scanning paused");
      else if (positions.length >= s.max_positions) notes.push(`at max positions (${positions.length})`);
      else {
        const held = new Set(positions.map((p) => p.coin));
        const barMs = isTrendline ? TIMEFRAME_MS[execTf] : INTERVAL_MS;
        const barOpen = new Date(Math.floor(Date.now() / barMs) * barMs).toISOString();
        const { data: recent } = await supabaseAdmin.from("paper_positions").select("coin").eq("user_id", s.user_id).gte("opened_at", barOpen);
        for (const r of recent ?? []) held.add(r.coin);
        for (const target of scanTargets) {
          if (positions.length >= s.max_positions) break;
          if (held.has(target.meta.name)) continue;
          report.scanned++;

          let side: "long" | "short" | null = null;
          let signalPrice = 0;
          let confidence = 0;
          let reasons: string[] = [];
          let family = strategyKey as string;
          let detail: Record<string, unknown> = {};
          let safetyLine: number | null = null;
          let actionLine: number | null = null;
          let trendSig: TrendlineSignal | null = null;
          let scalpSig: ScalpSignal | null = null;

          if (isTrendline) {
            const ladder = await loadLadder(target.meta.name, execTf);
            const { signal } = evaluateTrendline({ coin: target.meta.name, barsByTimeframe: ladder, execution: execTf, cfg });
            trendSig = signal;
            if (!signal.side || signal.initialStop == null) continue;
            side = signal.side; signalPrice = signal.price; confidence = signal.confidence; reasons = signal.reasons;
            detail = signal.detail; safetyLine = signal.safetyLine?.value ?? null; actionLine = signal.actionLine?.value ?? null;
          } else {
            const bars = await loadBars(target.meta.name); if (!bars || bars.length < 210) continue;
            const sig = evaluateScalp(target.meta.name, bars, strategyKey);
            scalpSig = sig;
            if (!sig.side || sig.confidence < +s.min_confidence) continue;
            side = sig.side; signalPrice = sig.price; confidence = sig.confidence; reasons = sig.reasons;
            family = sig.family; detail = sig.indicators; safetyLine = sig.safetyLine ?? null; actionLine = sig.actionLine ?? null;
          }
          if (!side) continue;

          const b = bucket(target.meta.name); if (positions.filter((p) => bucket(p.coin) === b).length >= 3) continue;
          const liveCap = +(s.live_max_alloc_usd ?? 0); const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          const leverageCap = Math.min(+s.max_leverage, target.meta.maxLeverage);
          const capNotional = equity * (+s.max_exposure_pct / 100) * +s.max_leverage; const exposure = positions.reduce((sum, p) => sum + p.notional, 0); const headroom = capNotional - exposure;
          if (headroom <= capNotional * 0.05) { notes.push("exposure cap reached"); break; }

          let verdict = { approve: true, reason: "AI review disabled", risk: "unknown" as string };
          if (s.ai_review_enabled) {
            const forReview = trendSig ?? scalpSig;
            verdict = await reviewSignal(forReview as never, target.ctx, positions.map((p) => `${p.side} ${p.coin}`), exits);
            await log(s.user_id, "ai", `${verdict.approve ? "APPROVED" : "VETOED"} ${side.toUpperCase()} ${target.meta.name} — ${verdict.reason}`, { signal: forReview, verdict });
            if (!verdict.approve) { report.vetoed++; continue; }
          }

          const quote = mids[target.meta.name] ? +mids[target.meta.name] : signalPrice;
          let entry = quote;
          let size: number;
          let leverage = leverageCap;
          let initialStop: number;
          let sl: number;
          let tp: number | null;

          if (isTrendline && trendSig) {
            // Pure Price: exchange MAXIMUM leverage for this market — never 1x,
            // never a fixed % of equity risked. Portfolio exposure headroom,
            // max positions, daily-loss and kill switch still bound the size.
            const stopFromSafety = trendSig.initialStop!;
            const sized = sizeAtMaxLeverage({ equity, entry: quote, stop: stopFromSafety, marketMaxLeverage: target.meta.maxLeverage, szDecimals: target.meta.szDecimals, maxNotional: headroom });
            if (!sized.ok) { notes.push(`${target.meta.name}: ${sized.reason}`); continue; }
            size = sized.size; leverage = sized.leverage; initialStop = stopFromSafety; sl = stopFromSafety; tp = null;
          } else {
            const notional = Math.min(equity * (+s.position_size_pct / 100) * leverageCap, headroom);
            size = notional / quote;
            const stopDist = safetyLine ? Math.abs(quote - safetyLine) : quote * (+s.scalp_sl_pct / 100);
            sl = side === "long" ? quote - stopDist : quote + stopDist;
            initialStop = sl;
            tp = side === "long" ? quote + stopDist * Math.max(1, +s.tp_rr || 2) : quote - stopDist * Math.max(1, +s.tp_rr || 2);
          }

          const reason = `${side.toUpperCase()} ${target.meta.name} [${family}] — ${reasons.join(" + ")} · AI: ${verdict.reason}`;
          if (isLive && creds) {
            const asset = (await assets()).get(target.meta.name); if (!asset) { report.errors.push(`${target.meta.name}: unknown asset`); continue; }
            size = Number(size.toFixed(asset.szDecimals)); if (size <= 0) continue;
            try {
              await setLeverage(creds, asset, leverage);
              const fill = await marketOrder(creds, asset, { isBuy: side === "long", size, markPrice: quote, reduceOnly: false, slippagePct: 1 });
              if (fill.size <= 0) { await log(s.user_id, "warn", `Live entry for ${target.meta.name} did not fill.`); continue; }
              entry = fill.avgPrice || quote; size = fill.size;
            } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`open ${target.meta.name}: ${msg}`); await log(s.user_id, "error", `Live entry failed for ${target.meta.name}: ${msg}`); continue; }
          }

          const { error: insErr } = await supabaseAdmin.from("paper_positions").insert({
            user_id: s.user_id, coin: target.meta.name, side, size, notional: size * entry, leverage,
            entry_price: entry, stop_loss: sl, take_profit: tp, confidence, reason,
            indicators: detail as never,
            safety_line: safetyLine, action_line: actionLine,
            timeframe: isTrendline ? execTf : INTERVAL,
            initial_stop: initialStop, risk_pct: isTrendline ? riskPct : null,
          });
          if (insErr) { report.errors.push(`record ${target.meta.name}: ${insErr.message}`); continue; }
          positions.push({ id: crypto.randomUUID(), coin: target.meta.name, side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, trail_high: entry, confidence }); held.add(target.meta.name); report.opened++;
          await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}OPEN ${side.toUpperCase()} ${target.meta.name} @ ${entry.toFixed(6)} · size ${size} · stop ${sl.toPrecision(6)} · risk ${isTrendline ? riskPct : +s.position_size_pct}% · ${reason}`, {
            agent: "server", live: isLive, strategy: strategyKey, timeframe: isTrendline ? execTf : INTERVAL,
            direction: side, entry, initialStop, currentStop: sl, riskPct: isTrendline ? riskPct : null, size,
            actionLine, safetyLine, detail,
          });
        }
      }
      const note = notes.length ? notes.join(" · ") : `cycle complete · strategy ${strategyKey}`;
      await supabaseAdmin.from("bot_settings").update({ last_cycle_at: new Date().toISOString(), last_cycle_note: note }).eq("user_id", s.user_id);
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`${s.user_id}: ${msg}`); await log(s.user_id, "error", `Trading cycle failed: ${msg}`); }
  }
  return report;
}

async function reviewSignal(sig: ScalpSignal | TrendlineSignal, ctx: AssetCtx, positions: string[], exits: ExitParams) {
  const schema = z.object({ approve: z.boolean(), reason: z.string().max(240), risk: z.enum(["low", "medium", "high"]) });
  try {
    const provider = createLovableAiGatewayProvider(process.env["LOVABLE_API_KEY"] ?? "");
    const model = provider("google/gemini-2.5-flash");
    const result = await generateObject({ model, schema, prompt: `You are a strict risk reviewer for a Hyperliquid perpetual futures bot. Review this deterministic price-action signal. Do not invent data. Signal: ${JSON.stringify(sig)}. Market context: ${JSON.stringify(ctx)}. Open positions: ${JSON.stringify(positions)}. Exit parameters: ${JSON.stringify(exits)}. Approve only if the setup is coherent and risk is acceptable. Never override the strategy direction.` });
    return result.object;
  } catch (err) {
    if (err instanceof NoObjectGeneratedError) return { approve: false, reason: "AI review unavailable; fail closed", risk: "high" as const };
    return { approve: false, reason: `AI review error: ${err instanceof Error ? err.message : String(err)}`, risk: "high" as const };
  }
}
