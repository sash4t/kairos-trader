import { useState } from "react";
import { useBot } from "@/lib/botContext";
import { OctagonAlert } from "lucide-react";

export function KillSwitch() {
  const { killSwitch, settings, saveSettings } = useBot();
  const [confirming, setConfirming] = useState(false);

  if (settings?.kill_switch_engaged) {
    return (
      <button
        onClick={() => saveSettings({ kill_switch_engaged: false })}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning hover:bg-warning/20"
      >Reset kill switch</button>
    );
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-bear/50 bg-bear/10 px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-bear hover:bg-bear/20"
      ><OctagonAlert className="h-4 w-4" />Kill switch</button>
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-bear/60 bg-bear/10 p-2">
      <div className="text-[11px] font-semibold text-bear">Flatten ALL positions & stop bot?</div>
      <div className="flex gap-1.5">
        <button onClick={() => setConfirming(false)} className="flex-1 rounded bg-muted px-2 py-1.5 text-xs">Cancel</button>
        <button onClick={async () => { await killSwitch(); setConfirming(false); }}
          className="flex-1 rounded bg-bear px-2 py-1.5 text-xs font-bold text-white">Confirm</button>
      </div>
    </div>
  );
}
