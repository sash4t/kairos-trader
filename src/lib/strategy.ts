import { atr, ema, last, macd, rsi } from "./indicators";
import type { Candle } from "./hyperliquid";

export type StrategyMode = "conservative" | "balanced" | "aggressive";
export const MODE_MIN_CONFIDENCE: Record<StrategyMode, number> = { conservative: 80, balanced: 70, aggressive: 60 };

export interface Signal { coin: string; side: "long" | "short" | null; confidence: number; reasons: string[]; price: number; atrValue: number; indicators: Record<string, number>; actionLine?: number; safetyLine?: number; }
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export function candlesToBars(cs: Candle[]): Bar[] { return cs.map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v })); }

export const STRATEGY_PARAMS = {
  intervals: ["1w", "1d", "4h", "1h", "15m"] as const,
  pivotStrength: 3,
  pivotSearch: 80,
  minTouches: 2,
  lineToleranceAtr: 0.12,
  atrPeriod: 14,
  atrMinPct: 0.05,
  atrMaxPct: 6,
} as const;
export const TRENDLINE_STRATEGY_KEY = "trendline_price_action" as const;

export interface TrendLine { i1:number; p1:number; i2:number; p2:number; slope:number; touches:number; valueAt:(i:number)=>number }
interface Pivot { i:number; price:number }

function pivotLows(bars:Bar[], strength:number):Pivot[] { const out:Pivot[]=[]; for(let i=strength;i<bars.length-strength;i++){ let ok=true; for(let j=1;j<=strength;j++) if(bars[i].l>=bars[i-j].l||bars[i].l>=bars[i+j].l){ok=false;break;} if(ok) out.push({i,price:bars[i].l}); } return out; }
function pivotHighs(bars:Bar[], strength:number):Pivot[] { const out:Pivot[]=[]; for(let i=strength;i<bars.length-strength;i++){ let ok=true; for(let j=1;j<=strength;j++) if(bars[i].h<=bars[i-j].h||bars[i].h<=bars[i+j].h){ok=false;break;} if(ok) out.push({i,price:bars[i].h}); } return out; }
function buildLine(bars:Bar[],a:Pivot,b:Pivot,support:boolean,tolerance:number):TrendLine|null { if(b.i<=a.i)return null; const slope=(b.price-a.price)/(b.i-a.i); if(support?slope<=0:slope>=0)return null; const valueAt=(i:number)=>a.price+slope*(i-a.i); let touches=0; for(let i=a.i;i<=b.i;i++){const line=valueAt(i);const distance=support?bars[i].l-line:line-bars[i].h;if(distance< -tolerance)return null;if(Math.abs(distance)<=tolerance)touches++;} return touches>=STRATEGY_PARAMS.minTouches?{i1:a.i,p1:a.price,i2:b.i,p2:b.price,slope,touches,valueAt}:null; }
function findBestLine(bars:Bar[],pivots:Pivot[],support:boolean,currentIndex:number,tolerance:number):TrendLine|null { const usable=pivots.filter(p=>p.i<currentIndex).slice(-STRATEGY_PARAMS.pivotSearch); if(usable.length<2)return null; const latest=usable[usable.length-1]; let best:TrendLine|null=null; for(let j=usable.length-2;j>=0;j--){const candidate=buildLine(bars,usable[j],latest,support,tolerance);if(candidate&&(!best||candidate.touches>best.touches||(candidate.touches===best.touches&&candidate.i1>best.i1)))best=candidate;} return best; }
export function getTrendlineState(bars:Bar[]):{support:TrendLine|null;resistance:TrendLine|null;atrValue:number}{const atrValue=last(atr(bars,STRATEGY_PARAMS.atrPeriod))??0;const tolerance=atrValue*STRATEGY_PARAMS.lineToleranceAtr;return{support:findBestLine(bars,pivotLows(bars,STRATEGY_PARAMS.pivotStrength),true,bars.length,tolerance),resistance:findBestLine(bars,pivotHighs(bars,STRATEGY_PARAMS.pivotStrength),false,bars.length,tolerance),atrValue};}
function timeframeBias(bars:Bar[]):"long"|"short"|null { if(bars.length<50)return null; const state=getTrendlineState(bars); const price=bars.at(-1)!.c; const support=state.support?.valueAt(bars.length); const resistance=state.resistance?.valueAt(bars.length); if(support!=null&&resistance!=null&&resistance>support){const midpoint=(support+resistance)/2;if(price>midpoint)return"long";if(price<midpoint)return"short";return null;} if(support!=null&&price>support)return"long";if(resistance!=null&&price<resistance)return"short";return null; }

/** Weekly -> Daily -> 4H -> 1H provide context; 15m is the actual action-line trigger. */
export function evaluateMultiTimeframeSignal(coin:string,weekly:Bar[],daily:Bar[],fourHour:Bar[],hourly:Bar[],fifteenMin:Bar[]):Signal {
  const empty:Signal={coin,side:null,confidence:0,reasons:[],price:fifteenMin.at(-1)?.c??hourly.at(-1)?.c??0,atrValue:0,indicators:{}};
  if(weekly.length<50||daily.length<80||fourHour.length<80||hourly.length<80||fifteenMin.length<80) return {...empty,reasons:["Waiting for Weekly/Daily/4H/1H/15m trend-line history"]};
  const weeklyBias=timeframeBias(weekly), dailyBias=timeframeBias(daily), fourBias=timeframeBias(fourHour), hourlyBias=timeframeBias(hourly);
  const h=fifteenMin.slice(0,-1); const price=fifteenMin.at(-1)!.c; const previous=fifteenMin.at(-2)!.c; const state=getTrendlineState(h);
  const supportNow=state.support?.valueAt(h.length), resistanceNow=state.resistance?.valueAt(h.length), supportPrev=state.support?.valueAt(h.length-1), resistancePrev=state.resistance?.valueAt(h.length-1);
  const atrSeries=atr(fifteenMin,STRATEGY_PARAMS.atrPeriod); const atrValue=last(atrSeries)??0; const atrPct=price?atrValue/price*100:0;
  const closes=fifteenMin.map(b=>b.c), vols=fifteenMin.map(b=>b.v); const e20=last(ema(closes,20))!; const e50=last(ema(closes,50))!; const macdHist=last(macd(closes).hist)!; const rsiV=last(rsi(closes,14))!; const avgVol=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20; const volX=last(vols)!/(avgVol||1);
  const brokeLong=!!state.resistance&&resistancePrev!=null&&resistanceNow!=null&&previous<=resistancePrev&&price>resistanceNow;
  const brokeShort=!!state.support&&supportPrev!=null&&supportNow!=null&&previous>=supportPrev&&price<supportNow;
  const indicators={weeklyBias:weeklyBias==="long"?1:weeklyBias==="short"?-1:0,dailyBias:dailyBias==="long"?1:dailyBias==="short"?-1:0,fourHourBias:fourBias==="long"?1:fourBias==="short"?-1:0,hourlyBias:hourlyBias==="long"?1:hourlyBias==="short"?-1:0,triggerSupport:supportNow??NaN,triggerResistance:resistanceNow??NaN,atrPct,rsi:rsiV,macdHist,ema20:e20,ema50:e50,volX};
  if(atrPct<STRATEGY_PARAMS.atrMinPct||atrPct>STRATEGY_PARAMS.atrMaxPct)return{...empty,price,atrValue,indicators,reasons:[`15m ATR% ${atrPct.toFixed(2)} outside volatility band`]};

  let side:"long"|"short"|null=null; let actionLine:number|undefined; let safetyLine:number|undefined; const reasons:string[]=[];
  // Higher timeframes are context only. They improve confidence but do not veto a valid 15m price-action break.
  if(brokeLong&&supportNow!=null){side="long";actionLine=resistanceNow;safetyLine=supportNow;reasons.push("15m closed above resistance/action line","15m rising support is the safety line");}
  else if(brokeShort&&resistanceNow!=null){side="short";actionLine=supportNow;safetyLine=resistanceNow;reasons.push("15m closed below support/action line","15m falling resistance is the safety line");}
  else return{...empty,price,atrValue,indicators,reasons:[`No 15m trend-line break (W=${weeklyBias??"neutral"}, D=${dailyBias??"neutral"}, 4H=${fourBias??"neutral"}, 1H=${hourlyBias??"neutral"})`]};

  const contextBull=[weeklyBias,dailyBias,fourBias,hourlyBias].filter(x=>x==="long").length; const contextBear=[weeklyBias,dailyBias,fourBias,hourlyBias].filter(x=>x==="short").length;
  const momentum=side==="long"?price>e20&&e20>e50&&macdHist>0:price<e20&&e20<e50&&macdHist<0;
  if(contextBull>=2&&side==="long")reasons.push(`Higher-timeframe context bullish ${contextBull}/4`); if(contextBear>=2&&side==="short")reasons.push(`Higher-timeframe context bearish ${contextBear}/4`); if(momentum)reasons.push("15m momentum confirms"); if(volX>1.2)reasons.push(`15m volume ${volX.toFixed(2)}x average`); if(side==="long"?rsiV>50:rsiV<50)reasons.push("15m RSI confirms");
  let confidence=72; if(contextBull>=2&&side==="long")confidence+=6; if(contextBear>=2&&side==="short")confidence+=6; if(momentum)confidence+=8; if(volX>1.2)confidence+=5; if(side==="long"?rsiV>50:rsiV<50)confidence+=4; if((state.support?.touches??0)>=3||(state.resistance?.touches??0)>=3)confidence+=5;
  return{coin,side,confidence:Math.min(98,confidence),reasons,price,atrValue,indicators,actionLine,safetyLine};
}

/** Backwards-compatible wrapper for callers with Daily/4H/1H only. */
export function evaluateSignal(coin:string,bars:Bar[]):Signal{return evaluateMultiTimeframeSignal(coin,bars,bars,bars,bars,bars);}

const CORRELATION_BUCKETS:Record<string,string>={BTC:"btc",ETH:"eth",SOL:"l1",AVAX:"l1",NEAR:"l1",APT:"l1",SUI:"l1",SEI:"l1",TIA:"l1",INJ:"l1",ARB:"l2",OP:"l2",MATIC:"l2",STRK:"l2",DOGE:"meme",SHIB:"meme",PEPE:"meme",WIF:"meme",BONK:"meme",FLOKI:"meme",LINK:"defi",UNI:"defi",AAVE:"defi",MKR:"defi",CRV:"defi",COMP:"defi"};
export function bucket(coin:string):string{return CORRELATION_BUCKETS[coin]??"other";}
