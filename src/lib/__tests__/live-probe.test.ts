import { expect, it } from "vitest";
import { evaluateScalpMulti } from "@/lib/scalp";
import { buildEntryIntent } from "@/lib/orderIntent";
import { candlesToBars, getTrendlineState } from "@/lib/strategy";
import { fetchCandles } from "@/lib/hyperliquid";
it("forced action-line break opens a real order intent", async () => {
  const now = Date.now(); const H=3600000;
  for (const coin of ["SOL","DOGE","LINK"]) {
    const [h,d,f] = await Promise.all([
      fetchCandles(coin,"1h",now-230*H,now),
      fetchCandles(coin,"1d",now-240*24*H,now),
      fetchCandles(coin,"4h",now-240*4*H,now),
    ]);
    const hourly = candlesToBars(h);
    const st = getTrendlineState(hourly.slice(0,-1));
    const res = st.resistance?.valueAt(hourly.length-1);
    if (!res) { console.log(coin,"no 1H resistance line"); continue; }
    const prev = hourly.at(-2)!;
    hourly[hourly.length-2] = { ...prev, c: res*0.995 };
    const lastBar = hourly.at(-1)!;
    hourly[hourly.length-1] = { ...lastBar, c: res*1.01, h: res*1.012 };
    const s = evaluateScalpMulti(coin,{daily:candlesToBars(d),fourHour:candlesToBars(f),hourly});
    console.log(coin,"side",s.side,"conf",s.confidence,"action",s.actionLine,"safety",s.safetyLine,s.reasons.join(" | "));
    if (s.side) {
      const i = buildEntryIntent({side:s.side,price:s.price,equity:10000,positionSizePct:8,maxExposurePct:80,userMaxLeverage:20,assetMaxLeverage:10,currentExposure:0,slPct:1.5,tpPct:12});
      console.log(coin,"INTENT",JSON.stringify(i));
      expect(i.ok).toBe(true); expect(i.size).toBeGreaterThan(0);
    }
  }
}, 120000);
