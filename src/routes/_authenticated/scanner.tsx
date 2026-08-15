import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { fetchCandles, fetchMetaAndCtxs, type AssetCtx, type AssetMeta } from "@/lib/hyperliquid";
import { candlesToBars, getTrendlineState } from "@/lib/strategy";
import { atr, ema, macd, rsi } from "@/lib/indicators";
import { useBot } from "@/lib/botContext";
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/scanner")({ component: Scanner });

type SignalKind = "rsi_oversold" | "rsi_overbought" | "long_watch" | "short_watch" | "breakout_long" | "breakout_short" | "volume_surge";
type Direction = "bullish" | "bearish" | "neutral";
type SetupStage = "WATCH" | "CONFIRMED" | "RSI";

type SignalDetail = { kind: SignalKind; direction: Direction; score: number; label: string; reason: string; breakoutPct?: number };
type Opportunity = {
  meta: AssetMeta; ctx: AssetCtx; signals: SignalDetail[]; score: number; direction: Direction; stage: SetupStage;
  price: number; rsi: number; atrPct: number; volume24h: number; openInterest: number; volumeX: number; breakoutPct: number;
};

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOLUME_SURGE_X = 1.5;
const WATCH_DISTANCE_ATR = 0.6;
const MAX_RESULTS = 30;

function Scanner() {
  const { mids } = useBot();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);

  const runScan = async () => {
    setLoading(true); setOpportunities([]); setScannedCount(0);
    try {
      const [m, ctxs] = await fetchMetaAndCtxs();
      const markets = m.universe.map((meta, i) => ({ meta, ctx: ctxs[i] })).filter((r): r is { meta: AssetMeta; ctx: AssetCtx } => Boolean(r.ctx));
      setTotalCount(markets.length);
      const found: Opportunity[] = [];

      for (let i = 0; i < markets.length; i++) {
        const { meta, ctx } = markets[i];
        const now = Date.now();
        try {
          const cs = await fetchCandles(meta.name, "1h", now - 220 * 60 * 60_000, now);
          const bars = candlesToBars(cs);
          if (bars.length < 80) { setScannedCount(i + 1); continue; }

          const closes = bars.map((b) => b.c); const volumes = bars.map((b) => b.v);
          const currentPrice = bars.at(-1)!.c; const previousClose = bars.at(-2)!.c;
          const rsiSeries = rsi(closes, 14); const rsiValue = rsiSeries.at(-1) ?? NaN; const previousRsi = rsiSeries.at(-2) ?? NaN;
          const atrValue = atr(bars, 14).at(-1) ?? 0; const atrPct = currentPrice ? (atrValue / currentPrice) * 100 : 0;
          const e20 = ema(closes, 20); const ema20 = e20.at(-1) ?? currentPrice; const ema20Prev = e20.at(-4) ?? ema20;
          const macdHist = macd(closes).hist.at(-1) ?? 0;
          const recentVolumes = volumes.slice(-21, -1); const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / Math.max(1, recentVolumes.length);
          const volumeX = volumes.at(-1)! / (avgVolume || 1);
          const trendState = getTrendlineState(bars.slice(0, -1));
          const resistancePrev = trendState.resistance?.valueAt(bars.length - 2); const resistanceNow = trendState.resistance?.valueAt(bars.length - 1);
          const supportPrev = trendState.support?.valueAt(bars.length - 2); const supportNow = trendState.support?.valueAt(bars.length - 1);
          const volume24h = Number(ctx.dayNtlVlm) || 0; const openInterest = Number(ctx.openInterest) || 0;
          const signals: SignalDetail[] = [];

          if (Number.isFinite(rsiValue) && rsiValue <= RSI_OVERSOLD) {
            const extremity = Math.min(25, RSI_OVERSOLD - rsiValue);
            signals.push({ kind: "rsi_oversold", direction: "bullish", score: Math.min(100, 60 + extremity * 1.6), label: `RSI Oversold ${rsiValue.toFixed(1)}`, reason: `RSI is below ${RSI_OVERSOLD}; this is an oversold alert, not a long confirmation by itself.` });
          }
          if (Number.isFinite(rsiValue) && rsiValue >= RSI_OVERBOUGHT) {
            const extremity = Math.min(25, rsiValue - RSI_OVERBOUGHT);
            signals.push({ kind: "rsi_overbought", direction: "bearish", score: Math.min(100, 60 + extremity * 1.6), label: `RSI Overbought ${rsiValue.toFixed(1)}`, reason: `RSI is above ${RSI_OVERBOUGHT}; this is an overbought alert, not a short confirmation by itself.` });
          }

          const brokeLong = resistancePrev != null && resistanceNow != null && previousClose <= resistancePrev && currentPrice > resistanceNow;
          const brokeShort = supportPrev != null && supportNow != null && previousClose >= supportPrev && currentPrice < supportNow;
          const supportDistanceAtr = supportNow != null && atrValue > 0 ? (currentPrice - supportNow) / atrValue : Infinity;
          const resistanceDistanceAtr = resistanceNow != null && atrValue > 0 ? (resistanceNow - currentPrice) / atrValue : Infinity;
          const bearishMomentum = currentPrice < ema20 && ema20 < ema20Prev && macdHist < 0 && rsiValue < 50 && rsiValue <= previousRsi;
          const bullishMomentum = currentPrice > ema20 && ema20 > ema20Prev && macdHist > 0 && rsiValue > 50 && rsiValue >= previousRsi;

          if (!brokeShort && supportNow != null && supportDistanceAtr >= 0 && supportDistanceAtr <= WATCH_DISTANCE_ATR && bearishMomentum) {
            const score = Math.min(79, 62 + (WATCH_DISTANCE_ATR - supportDistanceAtr) * 15 + Math.min(8, Math.max(0, volumeX - 1) * 6));
            signals.push({ kind: "short_watch", direction: "bearish", score, label: "SHORT WATCH", reason: `Bearish momentum is pressing support (${supportDistanceAtr.toFixed(2)} ATR away). Watch for a 1H close below support.` });
          }
          if (!brokeLong && resistanceNow != null && resistanceDistanceAtr >= 0 && resistanceDistanceAtr <= WATCH_DISTANCE_ATR && bullishMomentum) {
            const score = Math.min(79, 62 + (WATCH_DISTANCE_ATR - resistanceDistanceAtr) * 15 + Math.min(8, Math.max(0, volumeX - 1) * 6));
            signals.push({ kind: "long_watch", direction: "bullish", score, label: "LONG WATCH", reason: `Bullish momentum is pressing resistance (${resistanceDistanceAtr.toFixed(2)} ATR away). Watch for a 1H close above resistance.` });
          }
          if (brokeLong && resistanceNow != null) {
            const breakoutPct = ((currentPrice - resistanceNow) / resistanceNow) * 100;
            signals.push({ kind: "breakout_long", direction: "bullish", score: Math.min(100, 78 + Math.min(10, breakoutPct * 10) + Math.min(8, Math.max(0, volumeX - 1) * 6)), label: "LONG CONFIRMED", breakoutPct, reason: `1H close broke above trendline resistance by ${breakoutPct.toFixed(2)}%.` });
          }
          if (brokeShort && supportNow != null) {
            const breakoutPct = ((supportNow - currentPrice) / supportNow) * 100;
            signals.push({ kind: "breakout_short", direction: "bearish", score: Math.min(100, 78 + Math.min(10, breakoutPct * 10) + Math.min(8, Math.max(0, volumeX - 1) * 6)), label: "SHORT CONFIRMED", breakoutPct, reason: `1H close broke below trendline support by ${breakoutPct.toFixed(2)}%.` });
          }
          if (signals.length > 0 && volumeX >= VOLUME_SURGE_X) signals.push({ kind: "volume_surge", direction: "neutral", score: 60, label: `${volumeX.toFixed(2)}x Volume`, reason: `Current 1H volume is ${volumeX.toFixed(2)}x its recent 20-hour average.` });

          const directional = signals.filter((s) => s.direction !== "neutral");
          if (directional.length > 0) {
            const confirmed = directional.find((s) => s.kind === "breakout_long" || s.kind === "breakout_short");
            const watch = directional.find((s) => s.kind === "long_watch" || s.kind === "short_watch");
            const primary = confirmed ?? watch ?? directional.reduce((a, b) => a.score >= b.score ? a : b);
            const aligned = directional.filter((s) => s.direction === primary.direction).length;
            const score = Math.min(100, primary.score + Math.max(0, aligned - 1) * 5 + (volumeX >= VOLUME_SURGE_X ? 3 : 0));
            found.push({ meta, ctx, signals, score, direction: primary.direction, stage: confirmed ? "CONFIRMED" : watch ? "WATCH" : "RSI", price: currentPrice, rsi: rsiValue, atrPct, volume24h, openInterest, volumeX, breakoutPct: Math.max(0, ...signals.map((s) => s.breakoutPct ?? 0)) });
          }
        } catch {}
        setScannedCount(i + 1);
      }
      setOpportunities(found.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS)); setLastScannedAt(Date.now());
    } finally { setLoading(false); }
  };

  const stats = useMemo(() => ({
    long: opportunities.filter((o) => o.direction === "bullish").length,
    short: opportunities.filter((o) => o.direction === "bearish").length,
    watch: opportunities.filter((o) => o.stage === "WATCH").length,
    confirmed: opportunities.filter((o) => o.stage === "CONFIRMED").length,
  }), [opportunities]);
  const toneFor = (d: Direction) => d === "bullish" ? "text-bull" : d === "bearish" ? "text-bear" : "text-foreground";
  const callFor = (o: Opportunity) => o.stage === "CONFIRMED" ? `${o.direction === "bullish" ? "LONG" : "SHORT"} CONFIRMED` : o.stage === "WATCH" ? `${o.direction === "bullish" ? "LONG" : "SHORT"} WATCH` : "RSI EXTREME";

  return <div className="p-4 sm:p-6 lg:p-8 space-y-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-xl sm:text-2xl font-semibold">Signal scanner</h1><p className="text-sm text-muted-foreground">Early LONG/SHORT watch setups, confirmed 1H breakouts, and RSI extremes below 30 or above 70 across Hyperliquid perps.</p></div><button onClick={runScan} disabled={loading} className="w-full shrink-0 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">{loading ? <><Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />Scanning {scannedCount}/{totalCount || "…"}</> : <><RefreshCw className="mr-2 inline h-3.5 w-3.5" />Scan Hyperliquid</>}</button></div>
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-4"><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp className="h-4 w-4" />Long setups</div><div className="mt-2 text-2xl font-semibold mono">{stats.long}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingDown className="h-4 w-4" />Short setups</div><div className="mt-2 text-2xl font-semibold mono">{stats.short}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Watch</div><div className="mt-2 text-2xl font-semibold mono">{stats.watch}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Confirmed</div><div className="mt-2 text-2xl font-semibold mono">{stats.confirmed}</div></div></div>
    {lastScannedAt && !loading ? <div className="text-xs text-muted-foreground">Last scan: {new Date(lastScannedAt).toLocaleTimeString()} · WATCH = setup developing · CONFIRMED = 1H support/resistance break</div> : null}
    {!loading && opportunities.length === 0 ? <div className="panel p-8 text-center"><div className="font-medium">No signal list yet</div><div className="mt-1 text-sm text-muted-foreground">Run a scan to check all Hyperliquid perp pairs.</div></div> : null}
    {opportunities.length > 0 ? <div className="grid gap-3 xl:grid-cols-2">{opportunities.map((o) => { const livePrice = Number(mids[o.meta.name] ?? o.price); return <div key={o.meta.name} className="panel p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><div className="mono text-lg font-semibold">{o.meta.name}</div><span className={`rounded-md border border-panel-border px-2.5 py-1 text-xs font-bold ${toneFor(o.direction)}`}>{callFor(o)}</span>{o.signals.filter(s => !["long_watch","short_watch","breakout_long","breakout_short"].includes(s.kind)).map(s => <span key={s.kind} className={`rounded-full border border-panel-border px-2 py-0.5 text-[11px] font-semibold ${toneFor(s.direction)}`}>{s.label}</span>)}</div><div className="mt-2 space-y-1 text-sm text-muted-foreground">{o.signals.map(s => <div key={`${s.kind}-reason`}>• {s.reason}</div>)}</div></div><div className="shrink-0 text-right"><div className="text-[11px] uppercase tracking-widest text-muted-foreground">Score</div><div className={`mono text-xl font-semibold ${toneFor(o.direction)}`}>{o.score.toFixed(0)}</div></div></div>
    <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Price</div><div className="mono mt-1">{livePrice.toPrecision(7)}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">RSI 14</div><div className="mono mt-1">{Number.isFinite(o.rsi) ? o.rsi.toFixed(1) : "—"}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">1H vol</div><div className="mono mt-1">{o.volumeX.toFixed(2)}x</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">ATR</div><div className="mono mt-1">{o.atrPct.toFixed(2)}%</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">24h volume</div><div className="mono mt-1">${(o.volume24h / 1e6).toFixed(1)}M</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Open interest</div><div className="mono mt-1">{o.openInterest.toFixed(0)}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Funding</div><div className="mono mt-1">{(Number(o.ctx.funding) * 100).toFixed(4)}%</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Break distance</div><div className="mono mt-1">{o.breakoutPct ? `${o.breakoutPct.toFixed(2)}%` : "—"}</div></div></div></div>})}</div> : null}
  </div>;
}
