import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBot } from "@/lib/botContext";
import { TB_TIMEFRAMES, TB_DEFAULTS, parseTimeframes } from "@/lib/strategies/trendlineBreak";

/** Settings panel for the independent "Trendline Break" strategy. */
export function TrendlineBreakPanel() {
  const { settings } = useBot();
  const s = settings as any;
  const [timeframes, setTimeframes] = useState<string[]>(TB_DEFAULTS.timeframes);
  const [pivot, setPivot] = useState(String(TB_DEFAULTS.pivotStrength));
  const [risk, setRisk] = useState(String(TB_DEFAULTS.riskPct));
  const [refresh, setRefresh] = useState(String(TB_DEFAULTS.refreshMin));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!s) return;
    setTimeframes(parseTimeframes(s.tb_timeframes));
    setPivot(String(s.tb_pivot_strength ?? TB_DEFAULTS.pivotStrength));
    setRisk(String(s.tb_risk_pct ?? TB_DEFAULTS.riskPct));
    setRefresh(String(s.tb_refresh_min ?? TB_DEFAULTS.refreshMin));
  }, [s?.tb_timeframes, s?.tb_pivot_strength, s?.tb_risk_pct, s?.tb_refresh_min]);

  if (!s) return null;

  const toggle = (tf: string) =>
    setTimeframes(prev => (prev.includes(tf) ? prev.filter(x => x !== tf) : [...prev, tf]));

  const save = async () => {
    if (timeframes.length < 2) { toast.error("Pick at least two timeframes."); return; }
    setSaving(true);
    const { error } = await supabase.from("bot_settings").update({
      tb_timeframes: parseTimeframes(timeframes.join(",")).join(","),
      tb_pivot_strength: Math.min(10, Math.max(2, Math.round(Number(pivot) || 3))),
      tb_risk_pct: Math.min(5, Math.max(0.25, Number(risk) || 1)),
      tb_refresh_min: Math.min(1440, Math.max(1, Math.round(Number(refresh) || 60))),
    } as any).eq("user_id", s.user_id);
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Trendline Break settings saved.");
  };

  return (
    <div className="panel p-4 sm:p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold">Trendline Break settings</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Chained trendlines are drawn from the highest selected timeframe down to the lowest, which is the
          execution timeframe. A close through the opposing line is the action line; the line on the other
          side of price becomes the trailing safety-line stop.
        </p>
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Timeframe cascade</div>
        <div className="flex flex-wrap gap-2">
          {TB_TIMEFRAMES.map(tf => (
            <button key={tf} type="button" onClick={() => toggle(tf)}
              className={`rounded-md border px-3 py-1.5 mono text-xs ${timeframes.includes(tf) ? "border-primary bg-primary/10" : "border-panel-border hover:bg-muted/40"}`}>
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block">
          <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">Pivot strength</div>
          <input type="number" inputMode="decimal" value={pivot} onChange={e => setPivot(e.target.value)}
            className="w-full rounded-md border border-panel-border bg-background px-3 py-2 mono text-sm" />
        </label>
        <label className="block">
          <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">Risk per trade %</div>
          <input type="number" inputMode="decimal" step="0.25" value={risk} onChange={e => setRisk(e.target.value)}
            className="w-full rounded-md border border-panel-border bg-background px-3 py-2 mono text-sm" />
        </label>
        <label className="block">
          <div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground">Line refresh (min)</div>
          <input type="number" inputMode="decimal" value={refresh} onChange={e => setRefresh(e.target.value)}
            className="w-full rounded-md border border-panel-border bg-background px-3 py-2 mono text-sm" />
        </label>
      </div>

      <button onClick={save} disabled={saving}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {saving ? "Saving…" : "Save Trendline Break settings"}
      </button>
    </div>
  );
}
