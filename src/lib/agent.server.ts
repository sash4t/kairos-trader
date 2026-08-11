import { NoObjectGeneratedError, generateObject } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { candlesToBars, bucket, type Bar } from "./strategy";
import { evaluateScalp, exitReasonFor, updateTrail, type ExitParams, type ScalpSignal, type StrategyKey } from "./scalp";
import { fetchBtcMovePct, shockDirection, shockHitsSide, type ShockDir } from "./btcShock";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const INTERVAL = "1h";
const INTERVAL_MS = 60 * 60 * 1000;
const BARS = 230;
const SCAN_PER_CYCLE = 35;
const MIN_24H_VOLUME = 100_000;

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
  paper_equity: number; mode: string; live_max_alloc_usd: number; strategy_key?: StrategyKey; tp_rr?: number;
  btc_shock_enabled?: boolean; btc_shock_pct?: number; btc_shock_window_min?: number;
}
interface PositionRow { id: string; coin: string; side: "long" | "short"; size: number; notional: number; leverage: number; entry_price: number; stop_loss: number; take_profit: number; trail_high: number | null; confidence: number }

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
  const minute = Math.floor(Date.now() / 60_000);
  const offset = (minute * SCAN_PER_CYCLE) % Math.max(1, liquid.length);
  const scanTargets = Array.from({ length: Math.min(SCAN_PER_CYCLE, liquid.length) }, (_, i) => liquid[(offset + i) % liquid.length]);
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
      const strategyKey: StrategyKey = s.strategy_key === "trendbot_momentum" ? "trendbot_momentum" : "trendline_price_action";
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
      for (const p of [...positions]) {
        const markStr = mids[p.coin]; if (!markStr) continue; const mark = +markStr;
        const t = updateTrail(p.side, p.entry_price, mark, p.stop_loss, p.trail_high, exits);
        if (t.changed) { p.stop_loss = t.stopLoss; p.trail_high = t.trailHigh; await supabaseAdmin.from("paper_positions").update({ stop_loss: t.stopLoss, trail_high: t.trailHigh }).eq("id", p.id); }
        const reason = shockHitsSide(shockDir, p.side) ? "btc_shock" : exitReasonFor(p.side, mark, p.stop_loss, p.take_profit, p.entry_price);
        if (!reason) continue;
        let exitPrice = mark; let exitSize = p.size;
        if (isLive && creds) { const asset = (await assets()).get(p.coin); if (!asset) { report.errors.push(`${p.coin}: unknown asset`); continue; } try { const fill = await marketOrder(creds, asset, { isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 1 }); if (fill.size <= 0) { await log(s.user_id, "warn", `Live close for ${p.coin} did not fill — retrying next cycle.`); continue; } exitPrice = fill.avgPrice || mark; exitSize = fill.size; if (exitSize < p.size * 0.99) { const remaining = p.size - exitSize; const partialPnl = p.side === "long" ? (exitPrice - p.entry_price) * exitSize : (p.entry_price - exitPrice) * exitSize; p.size = remaining; p.notional = remaining * p.entry_price; await supabaseAdmin.from("paper_positions").update({ size: remaining, notional: p.notional }).eq("id", p.id); await log(s.user_id, "trade", `LIVE PARTIAL CLOSE ${p.coin} ${exitSize} @ ${exitPrice.toFixed(6)} · PnL ${partialPnl >= 0 ? "+" : ""}${partialPnl.toFixed(2)} USDC`, { agent: "server", live: true }); continue; } } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`close ${p.coin}: ${msg}`); await log(s.user_id, "error", `Live close failed for ${p.coin}: ${msg}`); continue; } }
        const pnl = p.side === "long" ? (exitPrice - p.entry_price) * exitSize : (p.entry_price - exitPrice) * exitSize;
        realised += pnl; await supabaseAdmin.from("paper_positions").update({ status: "closed", exit_price: exitPrice, exit_reason: reason, pnl, closed_at: new Date().toISOString() }).eq("id", p.id); positions = positions.filter((x) => x.id !== p.id); report.closed++;
        await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${exitPrice.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${reason}`, { agent: "server", reason, live: isLive });
      }
      if (realised !== 0 && !isLive) { await supabaseAdmin.from("bot_settings").update({ paper_equity: +s.paper_equity + realised }).eq("user_id", s.user_id); s.paper_equity = +s.paper_equity + realised; }
      let unrealised = 0; for (const p of positions) { const m = mids[p.coin]; if (!m) continue; unrealised += p.side === "long" ? (+m - p.entry_price) * p.size : (p.entry_price - +m) * p.size; }
      let equityNow = +s.paper_equity + unrealised; let equityIsReal = !isLive;
      if (isLive && creds) { try { const acct = await fetchLiveAccount(creds.accountAddress); equityNow = acct.accountValue; unrealised = acct.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0); equityIsReal = true; } catch (err) { notes.push(`live account read failed: ${err instanceof Error ? err.message : String(err)}`); } }
      if (equityIsReal) await supabaseAdmin.from("equity_snapshots").insert({ user_id: s.user_id, equity: equityNow, realized_pnl: realised, unrealized_pnl: unrealised, mode: isLive ? "live" : "paper" });
      if (!canTrade) { }
      else if (!s.scalp_enabled) notes.push("scanning paused");
      else if (positions.length >= s.max_positions) notes.push(`at max positions (${positions.length})`);
      else {
        const held = new Set(positions.map((p) => p.coin));
        const barOpen = new Date(Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS).toISOString();
        const { data: recent } = await supabaseAdmin.from("paper_positions").select("coin").eq("user_id", s.user_id).gte("opened_at", barOpen);
        for (const r of recent ?? []) held.add(r.coin);
        for (const target of scanTargets) {
          if (positions.length >= s.max_positions) break;
          if (held.has(target.meta.name)) continue;
          const hourly = await loadBars(target.meta.name, "1h", BARS); report.scanned++; if (!hourly || hourly.length < 80) continue;
          const sig: ScalpSignal = evaluateScalp(target.meta.name, hourly, strategyKey);
          if (!sig.side || sig.confidence < +s.min_confidence) continue;
          if (shockHitsSide(shockDir, sig.side)) continue;
          const b = bucket(sig.coin); if (positions.filter((p) => bucket(p.coin) === b).length >= 3) continue;
          const liveCap = +(s.live_max_alloc_usd ?? 0); const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          // Leverage never exceeds the user's configured cap or the exchange maximum.
          const leverage = Math.min(+s.max_leverage, target.meta.maxLeverage);
          const capNotional = equity * (+s.max_exposure_pct / 100) * +s.max_leverage; const exposure = positions.reduce((sum, p) => sum + p.notional, 0); const headroom = capNotional - exposure;
          if (headroom <= capNotional * 0.05) { notes.push("exposure cap reached"); break; }
          const notional = Math.min(equity * (+s.position_size_pct / 100) * leverage, headroom);
          let verdict = { approve: true, reason: "AI review disabled", risk: "unknown" as string };
          if (s.ai_review_enabled) { verdict = await reviewSignal(sig, target.ctx, positions.map((p) => `${p.side} ${p.coin}`), exits); await log(s.user_id, "ai", `${verdict.approve ? "APPROVED" : "VETOED"} ${sig.side.toUpperCase()} ${sig.coin} — ${verdict.reason}`, { signal: sig, verdict }); if (!verdict.approve) { report.vetoed++; continue; } }
          const quote = mids[sig.coin] ? +mids[sig.coin] : sig.price; let entry = quote; let size = notional / quote;
          const reason = `${sig.side.toUpperCase()} ${sig.coin} [${sig.family}] — ${sig.reasons.join(" + ")} · AI: ${verdict.reason}`;
          if (isLive && creds) { const asset = (await assets()).get(sig.coin); if (!asset) { report.errors.push(`${sig.coin}: unknown asset`); continue; } size = Number(size.toFixed(asset.szDecimals)); if (size <= 0) continue; try { await setLeverage(creds, asset, leverage); const fill = await marketOrder(creds, asset, { isBuy: sig.side === "long", size, markPrice: quote, reduceOnly: false, slippagePct: 1 }); if (fill.size <= 0) { await log(s.user_id, "warn", `Live entry for ${sig.coin} did not fill.`); continue; } entry = fill.avgPrice || quote; size = fill.size; } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`open ${sig.coin}: ${msg}`); await log(s.user_id, "error", `Live entry failed for ${sig.coin}: ${msg}`); continue; } }
          // Fixed percentage stop / target from the Bollinger baseline exits.
          const sl = sig.side === "long" ? entry * (1 - exits.slPct / 100) : entry * (1 + exits.slPct / 100);
          const tp = sig.side === "long" ? entry * (1 + exits.tpPct / 100) : entry * (1 - exits.tpPct / 100);
          const { error: insErr } = await supabaseAdmin.from("paper_positions").insert({ user_id: s.user_id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, confidence: sig.confidence, reason, indicators: sig.indicators });
          if (insErr) { report.errors.push(`record ${sig.coin}: ${insErr.message}`); continue; }
          positions.push({ id: crypto.randomUUID(), coin: sig.coin, side: sig.side, size, notional: size * entry, leverage, entry_price: entry, stop_loss: sl, take_profit: tp, trail_high: entry, confidence: sig.confidence }); held.add(sig.coin); report.opened++;
          await log(s.user_id, "trade", `${isLive ? "LIVE " : ""}OPEN ${sig.side.toUpperCase()} ${sig.coin} @ ${entry.toFixed(6)} · size ${size} · ${reason}`, { agent: "server", live: isLive, signal: sig });

        }
      }
      const note = notes.length ? notes.join(" · ") : `cycle complete · strategy ${strategyKey}`;
      await supabaseAdmin.from("bot_settings").update({ last_cycle_at: new Date().toISOString(), last_cycle_note: note }).eq("user_id", s.user_id);
    } catch (err) { const msg = err instanceof Error ? err.message : String(err); report.errors.push(`${s.user_id}: ${msg}`); await log(s.user_id, "error", `Trading cycle failed: ${msg}`); }
  }
  return report;
}

async function reviewSignal(sig: ScalpSignal, ctx: AssetCtx, positions: string[], exits: ExitParams) {
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
