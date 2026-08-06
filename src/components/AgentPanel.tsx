import { useBot } from "@/lib/botContext";
import { Bot, BrainCircuit, Clock, Zap } from "lucide-react";

function Toggle({ on, onChange, label, desc }: { on: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="flex w-full items-start gap-3 rounded-md border border-panel-border bg-background p-3 text-left hover:border-primary/50"
    >
      <span className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${on ? "bg-primary" : "bg-muted"}`}>
        <span className={`block h-4 w-4 rounded-full bg-panel transition-transform ${on ? "translate-x-4" : ""}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}

function NumField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix: string }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-center gap-1 rounded-md border border-panel-border bg-background px-2">
        <input
          type="number" step="0.1" min="0.1" value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="mono w-full bg-transparent py-2 text-sm outline-none"
        />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

export function AgentPanel() {
  const { settings, saveSettings } = useBot();
  if (!settings) return null;

  const last = settings.last_cycle_at ? new Date(settings.last_cycle_at) : null;
  const ageSec = last ? Math.round((Date.now() - last.getTime()) / 1000) : null;
  const healthy = ageSec != null && ageSec < 180;

  return (
    <div className="panel space-y-4 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4" />Autonomous agent (24/7)</div>
          <p className="text-xs text-muted-foreground">
            Runs on the backend every minute — monitors entries, trails winners and closes trades even with this tab shut. Paper account only.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-widest ${
          !settings.server_agent_enabled ? "bg-muted text-muted-foreground"
            : healthy ? "bg-bull/15 text-bull" : "bg-warning/15 text-warning"
        }`}>
          {!settings.server_agent_enabled ? "Off" : healthy ? "Live" : "Waiting"}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          on={settings.server_agent_enabled}
          onChange={(v) => saveSettings({ server_agent_enabled: v })}
          label="Run agent in the background"
          desc="Requires the bot to be enabled and the kill switch reset."
        />
        <Toggle
          on={settings.ai_review_enabled}
          onChange={(v) => saveSettings({ ai_review_enabled: v })}
          label="AI signal reviewer"
          desc="Every candidate entry is approved or vetoed by AI, with the reason logged."
        />
        <Toggle
          on={settings.scalp_enabled}
          onChange={(v) => saveSettings({ scalp_enabled: v })}
          label="Quick-trade scanning"
          desc="Off = manage open trades only, take no new entries."
        />
        <div className="flex items-center gap-2 rounded-md border border-panel-border bg-background p-3 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {last ? <>Last cycle {ageSec}s ago · <span className="mono">{settings.last_cycle_note ?? ""}</span></> : "No cycle recorded yet"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NumField label="Take profit" suffix="%" value={+settings.scalp_tp_pct} onChange={(v) => saveSettings({ scalp_tp_pct: v })} />
        <NumField label="Stop loss" suffix="%" value={+settings.scalp_sl_pct} onChange={(v) => saveSettings({ scalp_sl_pct: v })} />
        <NumField label="Trail arms at" suffix="%" value={+settings.trail_activate_pct} onChange={(v) => saveSettings({ trail_activate_pct: v })} />
        <NumField label="Trail distance" suffix="%" value={+settings.trail_dist_pct} onChange={(v) => saveSettings({ trail_dist_pct: v })} />
      </div>

      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Walk-forward tested on 19 perps over 52 days of 15m bars: none of 192 quick-trade configurations were profitable in
          all four folds after 0.13% round-trip costs. Keep this on paper until your own forward results say otherwise.
        </span>
      </div>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <BrainCircuit className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>AI verdicts appear in the event log tagged <span className="mono">ai</span>. If the reviewer errors, the trade is skipped rather than taken.</span>
      </div>
    </div>
  );
}
