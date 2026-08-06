import { NoObjectGeneratedError, generateObject } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { candlesToBars, bucket, type Bar } from "./strategy";
import { evaluateScalp, exitReasonFor, updateTrail, type ExitParams, type ScalpSignal } from "./scalp";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const INTERVAL = "1h";
const INTERVAL_MS = 60 * 60 * 1000;
const BARS = 230;
/** Coins examined per cycle. Rotated so every USDC perp is covered every few minutes. */
const SCAN_PER_CYCLE = 35;
/** Skip only truly dead books where a market order could not fill. */
const MIN_24H_VOLUME = 100_000;

type Level = "info" | "warn" | "error" | "trade" | "ai";

async function hl<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
  return (await res.json()) as T;
}

interface AssetMeta { name: string; szDecimals: number; maxLeverage: number }
interface AssetCtx { funding: string; openInterest: string; markPx: string; dayNtlVlm: string }

export interface CycleReport {
  users: number;
  closed: number;
  opened: number;
  vetoed: number;
  scanned: number;
  errors: string[];
}

interface Settings {
  user_id: string;
  bot_enabled: boolean;
  kill_switch_engaged: boolean;
  server_agent_enabled: boolean;
  ai_review_enabled: boolean;
  scalp_enabled: boolean;
  scalp_tp_pct: number;
  scalp_sl_pct: number;
  trail_activate_pct: number;
  trail_dist_pct: number;
  max_positions: number;
  max_leverage: number;
  position_size_pct: number;
  max_exposure_pct: number;
  daily_loss_pct: number;
  min_confidence: number;
  paper_equity: number;
  mode: string;
  live_max_alloc_usd: number;
}

interface PositionRow {
  id: string; coin: string; side: "long" | "short"; size: number; notional: number;
  leverage: number; entry_price: number; stop_loss: number; take_profit: number;
  trail_high: number | null; confidence: number;
}

/** Runs one full monitor → manage → scan → review → enter cycle for every enabled user. */
export async function runTradingCycle(): Promise<CycleReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: CycleReport = { users: 0, closed: 0, opened: 0, vetoed: 0, scanned: 0, errors: [] };

  const { data: users, error: settingsErr } = await supabaseAdmin
    .from("bot_settings")
    .select("*")
    .eq("server_agent_enabled", true)
    .eq("bot_enabled", true)
    .eq("kill_switch_engaged", false);

  if (settingsErr) throw new Error(settingsErr.message);
  if (!users || users.length === 0) return report;
  report.users = users.length;

  const log = async (userId: string, level: Level, message: string, meta?: unknown) => {
    const { error } = await supabaseAdmin.from("bot_events").insert({
      user_id: userId, level, message,
      meta: meta === undefined ? null : (JSON.parse(JSON.stringify(meta)) as never),
    });
    if (error) report.errors.push(`log: ${error.message}`);
  };

  // Shared market data — one fetch per cycle, not per user.
  const mids = await hl<Record<string, string>>({ type: "allMids" });
  const [meta, ctxs] = await hl<[{ universe: AssetMeta[] }, AssetCtx[]]>({ type: "metaAndAssetCtxs" });

  const EXCLUDED_COINS = new Set(["BTC", "ETH"]);
  const liquid = meta.universe
    .map((m, i) => ({ meta: m, ctx: ctxs[i] }))
    .filter((x) => x.ctx && +x.ctx.dayNtlVlm > MIN_24H_VOLUME && !EXCLUDED_COINS.has(x.meta.name))
    .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);

  // Rotate the scan window by wall-clock minute so every coin gets looked at.
  const minute = Math.floor(Date.now() / 60_000);
  const offset = (minute * SCAN_PER_CYCLE) % Math.max(1, liquid.length);
  const scanTargets = Array.from({ length: Math.min(SCAN_PER_CYCLE, liquid.length) }, (_, i) =>
    liquid[(offset + i) % liquid.length]);

  // Live execution wiring (only used for users whose mode is "live").
  const { readHlCreds, loadAssetIndex, marketOrder, setLeverage, fetchLiveAccount } =
    await import("./hyperliquidExchange.server");
  const creds = readHlCreds();
  let assetIndex: Awaited<ReturnType<typeof loadAssetIndex>> | null = null;
  const assets = async () => (assetIndex ??= await loadAssetIndex());

  const barCache = new Map<string, Bar[]>();
  const loadBars = async (coin: string): Promise<Bar[] | null> => {
    if (barCache.has(coin)) return barCache.get(coin)!;
    try {
      const end = Date.now();
      const candles = await hl<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({
        type: "candleSnapshot",
        req: { coin, interval: INTERVAL, startTime: end - BARS * INTERVAL_MS, endTime: end },
      });
      // Drop the still-forming candle: the strategy is validated on bar closes,
      // and a partial bar rarely sits outside the band when the cycle runs.
      const bars = candlesToBars(candles as never).slice(0, -1);
      barCache.set(coin, bars);
      return bars;
    } catch {
      return null;
    }
  };

  for (const raw of users) {
    const s = raw as unknown as Settings;
    const notes: string[] = [];
    try {
      const isLive = s.mode === "live";
      if (isLive && !creds) {
        notes.push("live mode on but API wallet not configured — no orders sent");
        await log(s.user_id, "error", "Live mode is on but Hyperliquid API credentials are missing.");
      }
      const canTrade = !isLive || !!creds;

      const exits: ExitParams = {
        tpPct: +s.scalp_tp_pct,
        slPct: +s.scalp_sl_pct,
        trailActivatePct: +s.trail_activate_pct,
        trailDistPct: +s.trail_dist_pct,
      };

      const { data: openRaw } = await supabaseAdmin
        .from("paper_positions").select("*").eq("user_id", s.user_id).eq("status", "open");
      let positions = (openRaw ?? []).map((p) => ({
        id: p.id, coin: p.coin, side: p.side as "long" | "short", size: +p.size, notional: +p.notional,
        leverage: +p.leverage, entry_price: +p.entry_price, stop_loss: +p.stop_loss,
        take_profit: +p.take_profit, trail_high: p.trail_high == null ? null : +p.trail_high,
        confidence: +p.confidence,
      })) as PositionRow[];

      // ---- 1. Manage open positions: trail, then exit ----
      let realised = 0;
      for (const p of [...positions]) {
        const markStr = mids[p.coin];
        if (!markStr) continue;
        const mark = +markStr;

        const t = updateTrail(p.side, p.entry_price, mark, p.stop_loss, p.trail_high, exits);
        if (t.changed) {
          p.stop_loss = t.stopLoss;
          p.trail_high = t.trailHigh;
          await supabaseAdmin.from("paper_positions")
            .update({ stop_loss: t.stopLoss, trail_high: t.trailHigh }).eq("id", p.id);
        }

        const reason = exitReasonFor(p.side, mark, p.stop_loss, p.take_profit);
        if (!reason) continue;

        if (isLive && creds) {
          const asset = (await assets()).get(p.coin);
          if (!asset) { report.errors.push(`${p.coin}: unknown asset`); continue; }
          try {
            await marketOrder(creds, asset, {
              isBuy: p.side === "short", size: p.size, markPrice: mark, reduceOnly: true, slippagePct: 0.6,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            report.errors.push(`close ${p.coin}: ${msg}`);
            await log(s.user_id, "error", `Live close failed for ${p.coin}: ${msg}`);
            continue;
          }
        }

        const pnl = p.side === "long" ? (mark - p.entry_price) * p.size : (p.entry_price - mark) * p.size;
        realised += pnl;
        await supabaseAdmin.from("paper_positions").update({
          status: "closed", exit_price: mark, exit_reason: reason, pnl, closed_at: new Date().toISOString(),
        }).eq("id", p.id);
        positions = positions.filter((x) => x.id !== p.id);
        report.closed++;
        await log(s.user_id, "trade",
          `${isLive ? "LIVE " : ""}CLOSE ${p.side.toUpperCase()} ${p.coin} @ ${mark.toFixed(6)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC · ${reason}`,
          { agent: "server", reason, live: isLive });
      }

      if (realised !== 0) {
        await supabaseAdmin.from("bot_settings")
          .update({ paper_equity: +s.paper_equity + realised }).eq("user_id", s.user_id);
        s.paper_equity = +s.paper_equity + realised;
      }

      // ---- 2. Equity snapshot ----
      let unrealised = 0;
      for (const p of positions) {
        const m = mids[p.coin];
        if (!m) continue;
        unrealised += p.side === "long" ? (+m - p.entry_price) * p.size : (p.entry_price - +m) * p.size;
      }

      // Live accounts report real equity; paper tracks a simulated balance.
      let equityNow = +s.paper_equity + unrealised;
      if (isLive && creds) {
        try {
          const acct = await fetchLiveAccount(creds.accountAddress);
          equityNow = acct.accountValue;
          unrealised = acct.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
        } catch (err) {
          notes.push(`live account read failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await supabaseAdmin.from("equity_snapshots").insert({
        user_id: s.user_id, equity: equityNow,
        realized_pnl: realised, unrealized_pnl: unrealised,
      });

      // ---- 3. Look for new entries ----
      if (!canTrade) { /* live mode without keys — never scan into orders */ }
      else if (!s.scalp_enabled) { notes.push("scanning paused"); }
      else if (positions.length >= s.max_positions) { notes.push(`at max positions (${positions.length})`); }
      else {
        const held = new Set(positions.map((p) => p.coin));
        // A closed-bar signal stays true for the whole hour, so only take a coin
        // once per bar — otherwise a stop-out would instantly re-enter.
        const barOpen = new Date(Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS).toISOString();
        const { data: recent } = await supabaseAdmin
          .from("paper_positions").select("coin")
          .eq("user_id", s.user_id).gte("opened_at", barOpen);
        for (const r of recent ?? []) held.add(r.coin);
        for (const target of scanTargets) {
          if (positions.length >= s.max_positions) break;
          if (held.has(target.meta.name)) continue;
          const bars = await loadBars(target.meta.name);
          report.scanned++;
          if (!bars || bars.length < 210) continue;

          const sig = evaluateScalp(target.meta.name, bars);
          if (!sig.side || sig.confidence < +s.min_confidence) continue;

          // Correlation guard
          const b = bucket(sig.coin);
          if (positions.filter((p) => bucket(p.coin) === b).length >= 2) continue;

          // Exposure guard — shrink the trade into the remaining headroom
          // instead of skipping it, so a small cap still allows one position.
          // Live mode can be capped to a fixed dollar allocation so the bot
          // never sizes off the full account balance.
          const liveCap = +(s.live_max_alloc_usd ?? 0);
          const equity = isLive && liveCap > 0 ? Math.min(equityNow, liveCap) : equityNow;
          const leverage = Math.min(+s.max_leverage, target.meta.maxLeverage);
          const capNotional = equity * (+s.max_exposure_pct / 100) * +s.max_leverage;
          const exposure = positions.reduce((sum, p) => sum + p.notional, 0);
          const headroom = capNotional - exposure;
          if (headroom <= capNotional * 0.05) {
            notes.push("exposure cap reached");
            break;
          }
          const notional = Math.min(equity * (+s.position_size_pct / 100) * leverage, headroom);

          // ---- AI review ----
          let verdict = { approve: true, reason: "AI review disabled", risk: "unknown" as string };
          if (s.ai_review_enabled) {
            verdict = await reviewSignal(sig, target.ctx, positions.map((p) => `${p.side} ${p.coin}`), exits);
            await log(s.user_id, "ai",
              `${verdict.approve ? "APPROVED" : "VETOED"} ${sig.side.toUpperCase()} ${sig.coin} — ${verdict.reason}`,
              { signal: sig, verdict });
            if (!verdict.approve) { report.vetoed++; continue; }
          }

          const entry = mids[sig.coin] ? +mids[sig.coin] : sig.price;
          let size = notional / entry;
          const sl = sig.side === "long" ? entry * (1 - exits.slPct / 100) : entry * (1 + exits.slPct / 100);
          const tp = sig.side === "long" ? entry * (1 + exits.tpPct / 100) : entry * (1 - exits.tpPct / 100);
          const reason = `${sig.side.toUpperCase()} ${sig.coin} [${sig.family}] — ${sig.reasons.join(" + ")} · AI: ${verdict.reason}`;

          // ---- Live order ----
          if (isLive && creds) {
            const asset = (await assets()).get(sig.coin);
            if (!asset) { report.errors.push(`${sig.coin}: unknown asset`); continue; }
            // Hyperliquid enforces a $10 minimum order value.
            if (size * entry < 10) { notes.push(`${sig.coin}: below $10 minimum order`); continue; }
            try {
              await setLeverage(creds, asset, leverage);
              await marketOrder(creds, asset, {
                isBuy: sig.side === "long", size, markPrice: entry, slippagePct: 0.6,
              });
              size = Number(size.toFixed(asset.szDecimals));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              report.errors.push(`open ${sig.coin}: ${msg}`);
              await log(s.user_id, "error", `Live order failed for ${sig.coin}: ${msg}`);
              continue;
            }
          }

          const { data: inserted, error } = await supabaseAdmin.from("paper_positions").insert({
            user_id: s.user_id, coin: sig.coin, side: sig.side, size, notional: size * entry,
            leverage, entry_price: entry, stop_loss: sl, take_profit: tp,
            confidence: sig.confidence, reason, indicators: sig.indicators,
          }).select().single();

          if (error || !inserted) { report.errors.push(error?.message ?? "insert failed"); continue; }
          positions.push({
            id: inserted.id, coin: sig.coin, side: sig.side, size, notional: size * entry, leverage,
            entry_price: entry, stop_loss: sl, take_profit: tp, trail_high: null, confidence: sig.confidence,
          });
          held.add(sig.coin);
          report.opened++;
          await log(s.user_id, "trade",
            `${isLive ? "LIVE " : ""}OPEN ${reason} @ ${entry.toFixed(6)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}`,
            { agent: "server", live: isLive });
        }
      }

      // ---- 4. Daily loss circuit breaker ----
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: firstSnap } = await supabaseAdmin
        .from("equity_snapshots").select("equity").eq("user_id", s.user_id)
        .gte("ts", dayStart.toISOString()).order("ts", { ascending: true }).limit(1);
      const startEq = firstSnap?.[0] ? +firstSnap[0].equity : equityNow;
      const nowEq = equityNow;
      const dayPct = ((nowEq - startEq) / (startEq || 1)) * 100;
      if (dayPct <= -Math.abs(+s.daily_loss_pct)) {
        await supabaseAdmin.from("bot_settings")
          .update({ bot_enabled: false, kill_switch_engaged: true }).eq("user_id", s.user_id);
        await log(s.user_id, "warn", `Daily loss limit hit (${dayPct.toFixed(2)}%). Agent stopped.`);
        notes.push("daily loss limit — agent stopped");
      }

      await supabaseAdmin.from("bot_settings").update({
        last_cycle_at: new Date().toISOString(),
        last_cycle_note: notes.length ? notes.join("; ") : `ok · ${positions.length} open`,
      }).eq("user_id", s.user_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(msg);
      await log(s.user_id, "error", `Agent cycle failed: ${msg}`);
      await supabaseAdmin.from("bot_settings")
        .update({ last_cycle_at: new Date().toISOString(), last_cycle_note: `error: ${msg}` })
        .eq("user_id", s.user_id);
    }
  }

  return report;
}

const ReviewSchema = z.object({
  approve: z.boolean(),
  risk: z.string(),
  reason: z.string(),
});

/** Second opinion on a mechanical signal. Fails open to a veto — never guesses "yes" on error. */
async function reviewSignal(
  sig: ScalpSignal, ctx: AssetCtx, openPositions: string[], exits: ExitParams,
): Promise<{ approve: boolean; risk: string; reason: string }> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return { approve: false, risk: "unknown", reason: "AI reviewer unavailable (no key)" };

  const gateway = createLovableAiGatewayProvider(key, undefined, { structuredOutputs: true });
  const prompt = [
    `Candidate quick trade on Hyperliquid perpetuals (paper account).`,
    `Coin: ${sig.coin}`,
    `Direction: ${sig.side}`,
    `Setup family: ${sig.family}`,
    `Mechanical confidence: ${sig.confidence}/100`,
    `Rationale: ${sig.reasons.join("; ")}`,
    `Indicators: ${JSON.stringify(sig.indicators)}`,
    `Funding rate: ${ctx.funding} · 24h volume: ${(+ctx.dayNtlVlm / 1e6).toFixed(1)}M · open interest: ${ctx.openInterest}`,
    `Currently open: ${openPositions.length ? openPositions.join(", ") : "none"}`,
    ``,
    `Target is +${exits.tpPct}% with a ${exits.trailDistPct}% trailing stop armed at +${exits.trailActivatePct}%; the hard stop is ${exits.slPct}% away. Round-trip cost is about 0.13%.`,
    `Approve only if the setup plausibly reaches target before stop. Veto on: funding strongly against the direction,`,
    `thin volume, over-concentration versus open positions, or a signal that looks like chop.`,
    `Keep "reason" under 25 words.`,
  ].join("\n");

  try {
    const { object: out } = await generateObject({
      model: gateway("google/gemini-3.6-flash"),
      schema: ReviewSchema,
      system: "You are a disciplined risk officer reviewing automated trade entries. Be skeptical; vetoing a marginal trade is cheaper than taking it.",
      prompt,
    });
    return { approve: !!out.approve, risk: String(out.risk ?? "unknown"), reason: String(out.reason ?? "").slice(0, 200) };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return { approve: false, risk: "unknown", reason: "AI reviewer returned unparseable output" };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { approve: false, risk: "unknown", reason: `AI reviewer error: ${msg.slice(0, 120)}` };
  }
}
