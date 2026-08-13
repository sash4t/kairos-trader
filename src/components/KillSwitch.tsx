import { useState } from "react";
import { useBot } from "@/lib/botContext";
import { OctagonAlert } from "lucide-react";

export function KillSwitch() {
  const { killSwitch, settings, saveSettings } = useBot();
  const [confirming, setConfirming] = useState(false);

  if (settings?.kill_switch_engaged) {
    return <button onClick={() => saveSettings({ kill_switch_engaged: false })} className="flex w-full items-center justify-center border border-[#D6A84B]/60 bg-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#D6A84B] transition-colors hover:bg-[#D6A84B]/10">Reset kill switch</button>;
  }

  if (!confirming) {
    return <button onClick={() => setConfirming(true)} className="flex w-full items-center justify-center gap-2 border border-[#F04040]/55 bg-transparent px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#F04040] transition-colors hover:bg-[#F04040]/10"><OctagonAlert className="h-3.5 w-3.5" />Kill switch</button>;
  }

  return <div className="border border-[#F04040]/60 bg-[#22100F] p-2">
    <div className="mb-2 text-[10px] font-semibold text-[#F04040]">Flatten ALL positions & stop bot?</div>
    <div className="flex gap-1.5">
      <button onClick={() => setConfirming(false)} className="flex-1 border border-[#1C2030] bg-transparent px-2 py-1.5 text-[10px] text-[#A7ADBA] hover:bg-[#0F1118]">Cancel</button>
      <button onClick={async () => { await killSwitch(); setConfirming(false); }} className="flex-1 border border-[#F04040] bg-transparent px-2 py-1.5 text-[10px] font-semibold text-[#F04040] hover:bg-[#F04040]/10">Confirm</button>
    </div>
  </div>;
}
