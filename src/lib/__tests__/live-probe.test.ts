import { it } from "vitest";
import { evaluateScalpMulti } from "@/lib/scalp";
it("dump", async () => {
  const { fetchCandles } = await import("@/lib/hyperliquid");
  const now = Date.now(); const H=3600000;
  for (const coin of ["BTC","ETH","SOL","DOGE","AVAX","LINK","SUI","WIF"]) {
    const [h,d,f] = await Promise.all([
      fetchCandles(coin,"1h",now-230*H,now),
      fetchCandles(coin,"1d",now-240*24*H,now),
      fetchCandles(coin,"4h",now-240*4*H,now),
    ]);
    const { candlesToBars } = await import("@/lib/strategy");
    const s = evaluateScalpMulti(coin,{daily:candlesToBars(d),fourHour:candlesToBars(f),hourly:candlesToBars(h)});
    console.log(coin, "bars d/f/h", d.length, f.length, h.length, "side", s.side, "conf", s.confidence, s.reasons[0]);
  }
}, 120000);
