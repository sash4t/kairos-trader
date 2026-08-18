import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { fetchCandles, fetchMetaAndCtxs, type AssetCtx, type AssetMeta } from "@/lib/hyperliquid";
import { candlesToBars, getTrendlineState } from "@/lib/strategy";
import { atr, ema, macd, rsi } from "@/lib/indicators";
import { useBot } from "@/lib/botContext";
import { placeScannerTrades, type ScannerTradeResult } from "@/lib/manualTrade.functions";
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/scanner")({ component: Scanner });

type SignalKind = "rsi_oversold" | "rsi_overbought" | "long_watch" | "short_watch" | "breakout_long" | "breakout_short" | "volume_surge" | "funding_extreme";
type Direction = "bullish" | "bearish" | "neutral";
type SetupStage = "WATCH" | "CONFIRMED" | "RSI";
type DirectionFilter = "all" | "long" | "short";
type StageFilter = "all" | SetupStage;
type ScoreFilter = 0 | 70 | 80 | 90;
type SortMode = "score" | "volume" | "atr";
type SignalDetail = { kind: SignalKind; direction: Direction; score: number; label: string; reason: string; breakoutPct?: number };
type Opportunity = {
  meta: AssetMeta; ctx: AssetCtx; signals: SignalDetail[]; score: number; direction: Direction; stage: SetupStage;
  price: number; rsi: number; atrPct: number; volume24h: number; openInterest: number; volumeX: number; breakoutPct: number;
};
type ScanResult = { status: "ok"; opportunity: Opportunity | null } | { status: "skipped" } | { status: "failed" };

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOLUME_SURGE_X = 1.5;
const WATCH_DISTANCE_ATR = 0.6;
const MAX_RESULTS = 30;
const SCAN_BATCH_SIZE = 15;

const formatUsdCompact = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
};

function Scanner() {
  const { mids, settings, syncPositions } = useBot();
  const placeTrades = useServerFn(placeScannerTrades);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [lastTradeResults, setLastTradeResults] = useState<ScannerTradeResult[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>(0);
  const [sortMode, setSortMode] = useState<SortMode>("score");

  const runScan = async () => {
    setLoading(true); setOpportunities([]); setSelected(new Set()); setScannedCount(0); setFailedCount(0); setSkippedCount(0); setLastTradeResults([]);
    try {
      const [m, ctxs] = await fetchMetaAndCtxs();
      const markets = m.universe.map((meta, i) => ({ meta, ctx: ctxs[i] })).filter((r): r is { meta: AssetMeta; ctx: AssetCtx } => Boolean(r.ctx));
      setTotalCount(markets.length);
      const found: Opportunity[] = [];

      for (let start = 0; start < markets.length; start += SCAN_BATCH_SIZE) {
        const batch = markets.slice(start, start + SCAN_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async ({ meta, ctx }): Promise<ScanResult> => {
          try {
            const now = Date.now();
            const cs = await fetchCandles(meta.name, "1h", now - 220 * 60 * 60_000, now);
            const bars = candlesToBars(cs);
            if (bars.length < 80) return { status: "skipped" };

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
            const funding = Number(ctx.funding) || 0;
            const signals: SignalDetail[] = [];

            if (Number.isFinite(rsiValue) && rsiValue <= RSI_OVERSOLD) {
              const extremity = Math.min(25, RSI_OVERSOLD - rsiValue);
              signals.push({ kind: "rsi_oversold", direction: "bullish", score: Math.min(100, 60 + extremity * 1.6), label: `RSI Oversold ${rsiValue.toFixed(1)}`, reason: `RSI is below ${RSI_OVERSOLD}; this is an oversold alert, not a long confirmation by itself.` });
            }
            if (Number.isFinite(rsiValue) && rsiValue >= RSI_OVERBOUGHT) {
              const extremity = Math.min(25, rsiValue - RSI_OVERBOUGHT);
              signals.push({ kind: "rsi_overbought", direction: "bearish", score: Math.min(100, 60 + extremity * 1.6), label: `RSI Overbought ${rsiValue.toFixed(1)}`, reason: `RSI is above ${RSI_OVERBOUGHT}; this is an overbought alert, not a short confirmation by itself.` });
            }
            if (Math.abs(funding) > 0.0005) {
              const direction: Direction = funding > 0 ? "bearish" : "bullish";
              signals.push({ kind: "funding_extreme", direction, score: 65, label: `Funding ${(funding * 100).toFixed(4)}%`, reason: `${funding > 0 ? "Positive" : "Negative"} funding is extreme at ${(funding * 100).toFixed(4)}%, creating a ${direction} contrarian signal.` });
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
            if (directional.length === 0) return { status: "ok", opportunity: null };

            const confirmed = directional.find((s) => s.kind === "breakout_long" || s.kind === "breakout_short");
            const watch = directional.find((s) => s.kind === "long_watch" || s.kind === "short_watch");
            const primary = confirmed ?? watch ?? directional.reduce((a, b) => a.score >= b.score ? a : b);
            const isBreakoutPrimary = primary.kind === "breakout_long" || primary.kind === "breakout_short";
            const aligned = directional.filter((s) => s.direction === primary.direction && !(isBreakoutPrimary && (s.kind === "rsi_oversold" || s.kind === "rsi_overbought"))).length;
            const score = Math.min(100, primary.score + Math.max(0, aligned - 1) * 5 + (volumeX >= VOLUME_SURGE_X ? 3 : 0));
            const opportunity: Opportunity = { meta, ctx, signals, score, direction: primary.direction, stage: confirmed ? "CONFIRMED" : watch ? "WATCH" : "RSI", price: currentPrice, rsi: rsiValue, atrPct, volume24h, openInterest, volumeX, breakoutPct: Math.max(0, ...signals.map((s) => s.breakoutPct ?? 0)) };
            return { status: "ok", opportunity };
          } catch {
            return { status: "failed" };
          }
        }));

        const failedInBatch = batchResults.filter((r) => r.status === "failed").length;
        const skippedInBatch = batchResults.filter((r) => r.status === "skipped").length;
        if (failedInBatch) setFailedCount((count) => count + failedInBatch);
        if (skippedInBatch) setSkippedCount((count) => count + skippedInBatch);
        for (const result of batchResults) if (result.status === "ok" && result.opportunity) found.push(result.opportunity);
        setScannedCount(Math.min(start + batch.length, markets.length));
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

  const visibleOpportunities = useMemo(() => opportunities
    .filter((o) => directionFilter === "all" || (directionFilter === "long" ? o.direction === "bullish" : o.direction === "bearish"))
    .filter((o) => stageFilter === "all" || o.stage === stageFilter)
    .filter((o) => o.score >= scoreFilter)
    .sort((a, b) => sortMode === "volume" ? b.volume24h - a.volume24h : sortMode === "atr" ? b.atrPct - a.atrPct : b.score - a.score),
  [opportunities, directionFilter, stageFilter, scoreFilter, sortMode]);

  const toggle = (coin: string) => setSelected((prev) => { const next = new Set(prev); next.has(coin) ? next.delete(coin) : next.add(coin); return next; });
  const selectAll = () => setSelected(new Set(visibleOpportunities.map((o) => o.meta.name)));
  const selectConfirmed = () => setSelected(new Set(visibleOpportunities.filter((o) => o.stage === "CONFIRMED").map((o) => o.meta.name)));

  const submitSelected = async () => {
    const targets = opportunities.filter((o) => selected.has(o.meta.name) && o.direction !== "neutral");
    if (!targets.length || submitting) return;
    const mode = settings?.mode === "live" ? "LIVE" : "PAPER";
    if (!window.confirm(`Place ${targets.length} ${mode} scanner trade${targets.length === 1 ? "" : "s"}? Existing position-count and exposure limits will still apply.`)) return;
    setSubmitting(true);
    try {
      const result = await placeTrades({ data: { trades: targets.map((o) => ({
        coin: o.meta.name,
        side: o.direction === "bullish" ? "long" as const : "short" as const,
        score: o.score,
        stage: o.stage,
        reasons: o.signals.filter((s) => s.direction === o.direction || s.direction === "neutral").map((s) => s.reason),
        rsi: o.rsi,
        atrPct: o.atrPct,
      })) } });
      setLastTradeResults(result.results);
      if (result.opened) toast.success(`Opened ${result.opened} scanner position${result.opened === 1 ? "" : "s"}.`);
      if (result.skipped) {
        const skipped = result.results.filter((r) => r.status === "skipped");
        const maxPositions = skipped.filter((r) => r.message.startsWith("Max positions limit reached")).length;
        const exposure = skipped.filter((r) => r.message === "Exposure limit reached.").length;
        const alreadyHeld = skipped.filter((r) => r.message === "An open position already exists for this coin.").length;
        const other = skipped.length - maxPositions - exposure - alreadyHeld;
        const parts = [maxPositions ? `${maxPositions} max positions` : "", exposure ? `${exposure} exposure cap` : "", alreadyHeld ? `${alreadyHeld} already held` : "", other ? `${other} other` : ""].filter(Boolean);
        toast.warning(`${result.skipped} candidate${result.skipped === 1 ? "" : "s"} blocked · ${parts.join(" · ")}`);
      }
      if (result.errors) toast.error(`${result.errors} scanner trade${result.errors === 1 ? "" : "s"} failed. See trade results below.`);
      const openedCoins = new Set(result.results.filter((r) => r.status === "opened").map((r) => r.coin));
      setSelected((prev) => new Set([...prev].filter((coin) => !openedCoins.has(coin))));
      await syncPositions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally { setSubmitting(false); }
  };

  const tradeResultSummary = useMemo(() => {
    const skipped = lastTradeResults.filter((r) => r.status === "skipped");
    return {
      opened: lastTradeResults.filter((r) => r.status === "opened").length,
      skipped: skipped.length,
      errors: lastTradeResults.filter((r) => r.status === "error").length,
      maxPositions: skipped.filter((r) => r.message.startsWith("Max positions limit reached")).length,
      exposure: skipped.filter((r) => r.message === "Exposure limit reached.").length,
      alreadyHeld: skipped.filter((r) => r.message === "An open position already exists for this coin.").length,
    };
  }, [lastTradeResults]);
  const toneFor = (d: Direction) => d === "bullish" ? "text-bull" : d === "bearish" ? "text-bear" : "text-foreground";
  const callFor = (o: Opportunity) => {
    if (o.stage === "CONFIRMED") return `${o.direction === "bullish" ? "LONG" : "SHORT"} CONFIRMED`;
    if (o.stage === "WATCH") return `${o.direction === "bullish" ? "LONG" : "SHORT"} WATCH`;
    const hasDirectionalRsi = o.signals.some((s) => (s.kind === "rsi_oversold" || s.kind === "rsi_overbought") && s.direction === o.direction);
    return hasDirectionalRsi ? "RSI EXTREME" : "FUNDING EXTREME";
  };

  return <div className="p-4 sm:p-6 lg:p-8 space-y-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-xl sm:text-2xl font-semibold">Signal scanner</h1><p className="text-sm text-muted-foreground">Early LONG/SHORT watch setups, confirmed 1H breakouts, RSI extremes, and extreme funding across Hyperliquid perps.</p></div><button onClick={runScan} disabled={loading || submitting} className="w-full shrink-0 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto">{loading ? <><Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />Scanning {scannedCount}/{totalCount || "…"}{failedCount > 0 ? ` · ${failedCount} failed` : ""}{skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}</> : <><RefreshCw className="mr-2 inline h-3.5 w-3.5" />Scan Hyperliquid</>}</button></div>

    <div className="grid gap-3 grid-cols-2 xl:grid-cols-4"><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp className="h-4 w-4" />Long setups</div><div className="mt-2 text-2xl font-semibold mono">{stats.long}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingDown className="h-4 w-4" />Short setups</div><div className="mt-2 text-2xl font-semibold mono">{stats.short}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Watch</div><div className="mt-2 text-2xl font-semibold mono">{stats.watch}</div></div><div className="panel p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" />Confirmed</div><div className="mt-2 text-2xl font-semibold mono">{stats.confirmed}</div></div></div>

    {opportunities.length > 0 ? <div className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4"><div><div className="text-sm font-medium">Manual scanner trades · {settings?.mode === "live" ? "LIVE" : "PAPER"}</div><div className="text-xs text-muted-foreground">{selected.size} selected · uses current position size, leverage, max-position and exposure settings · duplicate coins are skipped</div></div><div className="flex flex-wrap gap-2"><button onClick={selectAll} disabled={submitting || !visibleOpportunities.length} className="rounded-md border border-panel-border px-3 py-2 text-xs font-medium disabled:opacity-50">Select shown {visibleOpportunities.length}</button><button onClick={selectConfirmed} disabled={submitting || !visibleOpportunities.some((o) => o.stage === "CONFIRMED")} className="rounded-md border border-panel-border px-3 py-2 text-xs font-medium disabled:opacity-50">Select confirmed</button><button onClick={() => setSelected(new Set())} disabled={submitting || !selected.size} className="rounded-md border border-panel-border px-3 py-2 text-xs font-medium disabled:opacity-50">Clear</button><button onClick={submitSelected} disabled={submitting || !selected.size || settings?.kill_switch_engaged} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{submitting ? <><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Placing…</> : `Place ${selected.size} selected trade${selected.size === 1 ? "" : "s"}`}</button></div></div> : null}

    {lastTradeResults.length > 0 ? <div className="panel p-4 sm:p-5"><div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-semibold">Last scanner trade results</div><div className="mt-1 text-xs text-muted-foreground">{tradeResultSummary.opened} opened · {tradeResultSummary.skipped} blocked · {tradeResultSummary.errors} failed</div></div>{tradeResultSummary.skipped > 0 ? <div className="text-xs text-muted-foreground">{tradeResultSummary.maxPositions} max positions · {tradeResultSummary.exposure} exposure cap · {tradeResultSummary.alreadyHeld} already held</div> : null}</div><div className="mt-3 space-y-2">{lastTradeResults.map((r, i) => <div key={`${r.coin}-${r.side}-${i}`} className="flex items-start justify-between gap-3 rounded-md border border-panel-border p-2.5 text-xs"><div className="min-w-0"><span className="mono font-semibold">{r.coin}</span><span className="ml-2 uppercase text-muted-foreground">{r.side}</span><div className="mt-0.5 text-muted-foreground">{r.message}</div></div><span className={`shrink-0 font-semibold uppercase ${r.status === "opened" ? "text-bull" : r.status === "error" ? "text-bear" : "text-warning"}`}>{r.status === "skipped" ? "blocked" : r.status}</span></div>)}</div></div> : null}

    {settings?.kill_switch_engaged ? <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">Kill switch is engaged. Scanner trade buttons are disabled.</div> : null}
    {lastScannedAt && !loading ? <div className="text-xs text-muted-foreground">Last scan: {new Date(lastScannedAt).toLocaleTimeString()} · {skippedCount} skipped for insufficient bars · {failedCount} failed · WATCH = setup developing · CONFIRMED = 1H support/resistance break</div> : null}
    {!loading && opportunities.length === 0 ? <div className="panel p-8 text-center"><div className="font-medium">No signal list yet</div><div className="mt-1 text-sm text-muted-foreground">Run a scan to check all Hyperliquid perp pairs.</div></div> : null}

    {opportunities.length > 0 ? <div className="panel p-3 sm:p-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-xs text-muted-foreground">Direction<select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value as DirectionFilter)} className="mt-1 w-full rounded-md border border-panel-border bg-background px-2.5 py-2 text-sm text-foreground"><option value="all">All</option><option value="long">Long</option><option value="short">Short</option></select></label><label className="text-xs text-muted-foreground">Stage<select value={stageFilter} onChange={(e) => setStageFilter(e.target.value as StageFilter)} className="mt-1 w-full rounded-md border border-panel-border bg-background px-2.5 py-2 text-sm text-foreground"><option value="all">All</option><option value="CONFIRMED">CONFIRMED</option><option value="WATCH">WATCH</option><option value="RSI">RSI</option></select></label><label className="text-xs text-muted-foreground">Min score<select value={scoreFilter} onChange={(e) => setScoreFilter(Number(e.target.value) as ScoreFilter)} className="mt-1 w-full rounded-md border border-panel-border bg-background px-2.5 py-2 text-sm text-foreground"><option value={0}>Any</option><option value={70}>70+</option><option value={80}>80+</option><option value={90}>90+</option></select></label><label className="text-xs text-muted-foreground">Sort<select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} className="mt-1 w-full rounded-md border border-panel-border bg-background px-2.5 py-2 text-sm text-foreground"><option value="score">Score</option><option value="volume">Volume</option><option value="atr">ATR</option></select></label></div><div className="mt-2 text-xs text-muted-foreground">Showing {visibleOpportunities.length} of {opportunities.length} results</div></div> : null}

    {opportunities.length > 0 && visibleOpportunities.length === 0 ? <div className="panel p-8 text-center"><div className="font-medium">No results match these filters</div><div className="mt-1 text-sm text-muted-foreground">Adjust direction, stage, minimum score, or sort options.</div></div> : null}

    {visibleOpportunities.length > 0 ? <div className="grid gap-3 xl:grid-cols-2">{visibleOpportunities.map((o) => { const livePrice = Number(mids[o.meta.name] ?? o.price); const checked = selected.has(o.meta.name); return <div key={o.meta.name} className={`panel p-4 sm:p-5 ${checked ? "ring-1 ring-primary/60" : ""}`}><div className="flex items-start gap-3"><input aria-label={`Select ${o.meta.name} for trade`} type="checkbox" checked={checked} onChange={() => toggle(o.meta.name)} disabled={submitting} className="mt-1 h-4 w-4 shrink-0 accent-primary" /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><div className="mono text-lg font-semibold">{o.meta.name}</div><span className={`rounded-md border border-panel-border px-2.5 py-1 text-xs font-bold ${toneFor(o.direction)}`}>{callFor(o)}</span>{o.signals.filter(s => !["long_watch","short_watch","breakout_long","breakout_short"].includes(s.kind)).map(s => <span key={s.kind} className={`rounded-full border border-panel-border px-2 py-0.5 text-[11px] font-semibold ${toneFor(s.direction)}`}>{s.label}</span>)}</div><div className="mt-2 space-y-1 text-sm text-muted-foreground">{o.signals.map(s => <div key={`${s.kind}-reason`}>• {s.reason}</div>)}</div></div><div className="shrink-0 text-right"><div className="text-[11px] uppercase tracking-widest text-muted-foreground">Score</div><div className={`mono text-xl font-semibold ${toneFor(o.direction)}`}>{o.score.toFixed(0)}</div></div></div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Price</div><div className="mono mt-1">{livePrice.toPrecision(7)}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">RSI 14</div><div className="mono mt-1">{Number.isFinite(o.rsi) ? o.rsi.toFixed(1) : "—"}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">1H vol</div><div className="mono mt-1">{o.volumeX.toFixed(2)}x</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">ATR</div><div className="mono mt-1">{o.atrPct.toFixed(2)}%</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">24h volume</div><div className="mono mt-1">{formatUsdCompact(o.volume24h)}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Open interest</div><div className="mono mt-1">{formatUsdCompact(o.openInterest)}</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Funding</div><div className="mono mt-1">{(Number(o.ctx.funding) * 100).toFixed(4)}%</div></div><div className="rounded-md border border-panel-border p-2"><div className="text-muted-foreground">Break distance</div><div className="mono mt-1">{o.breakoutPct ? `${o.breakoutPct.toFixed(2)}%` : "—"}</div></div></div></div></div></div>})}</div> : null}
  </div>;
}
