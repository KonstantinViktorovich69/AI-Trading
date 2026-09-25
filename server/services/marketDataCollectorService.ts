import ccxt from 'ccxt';
import { RSI, MACD, BollingerBands, ATR, VWAP, PSAR, ADX } from 'technicalindicators';
import { ensureExchangeMarket } from './marketDataHubService.ts';

export interface MarketDataCollectorContext {
  getGlobalTrueOHLCV: () => Record<string, any>;
  getGlobalRawOHLCV: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getGlobalATR: () => Record<string, number>;
  getGlobalADX: () => Record<string, number>;
  getGlobalDerivatives: () => { fundingRates: any };
  getFundingRates: () => Record<string, number>;
  getOpenInterests: () => Record<string, number>;
  getOrderBookImbalance: () => Record<string, any>;
  getGlobalOrderBookHistory: () => Record<string, any[]>;
  getCacheSignals: () => any;
  getVirtualTrades: () => any[];
  getCcxtExchange: (name: string) => any;
  isBinanceGeoblocked: () => boolean;
  setBinanceGeoblocked: (val: boolean) => void;
  isMainThread: () => boolean;
  onIndicatorsUpdated?: (cleanSym: string) => void;
}

export function calculateEMA(data: number[], period: number): number {
  if (!data || data.length === 0) return 0;
  if (data.length === 1) return data[0];
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

export async function updateTrueOHLCV(ctx: MarketDataCollectorContext): Promise<void> {
  if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
    return;
  }
  try {
    const GLOBAL_TRUE_OHLCV = ctx.getGlobalTrueOHLCV();
    const GLOBAL_RAW_OHLCV = ctx.getGlobalRawOHLCV();
    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    const GLOBAL_ATR = ctx.getGlobalATR();
    const GLOBAL_ADX = ctx.getGlobalADX();
    const virtualTrades = ctx.getVirtualTrades();

    const symbolsSet = new Set<string>();
    const symbolToEx: Record<string, string> = {};
      
    for (const exName in GLOBAL_CCXT_TICKERS) {
      if (exName !== 'weex') continue; // Only WEEX
      const tickers = GLOBAL_CCXT_TICKERS[exName];
      if (!tickers) continue;
      
      // Dynamic scanning candidates targeting only hot volatile gems, indices, or active positions
      const limit = 45; 
      const volThreshold = 10000; 
      
      const activePositionSymbols = new Set(virtualTrades.filter((t: any) => t.status === 'OPEN').map((t: any) => t.symbol.replace(/[\/:]/g, '').toUpperCase()));

      Object.entries(tickers)
        .filter(([sym, t]: [string, any]) => {
           if (!sym.includes('/USDT')) return false;
           const qVol = t.quoteVolume ?? t.volume ?? 0;
           if (qVol < volThreshold) return false;
           
           const cleanSym = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
           
           // Always include BTC and ETH
           if (cleanSym === 'BTCUSDT' || cleanSym === 'ETHUSDT') return true;
           
           // Always include open positions
           if (activePositionSymbols.has(cleanSym)) return true;
           
           // Include candidate gems: change/volatility > 3.0%
           const percent = Math.abs(t.percentage || 0);
           const high = t.high || t.last || 0;
           const low = t.low || t.last || 0;
           const estVolat = low > 0 ? ((high - low) / low * 100) : 0;
           return percent > 3.0 || estVolat > 3.0;
        })
        .sort((a: any, b: any) => ((b[1].quoteVolume ?? b[1].volume ?? 0) - (a[1].quoteVolume ?? a[1].volume ?? 0)))
        .slice(0, limit)
        .forEach(([symbol]) => {
           symbolsSet.add(symbol);
           if (!symbolToEx[symbol]) symbolToEx[symbol] = exName;
        });
    }

    const symbolsToUpdate = Array.from(symbolsSet);
    const cleanSymbolsSet = new Set(symbolsToUpdate.map(s => s.split(':')[0].replace('/', '')));
    
    // Cleanup old records to prevent memory leak
    for (const key of Object.keys(GLOBAL_TRUE_OHLCV)) {
      if (!cleanSymbolsSet.has(key)) delete GLOBAL_TRUE_OHLCV[key];
    }

    // Safe throttled fetch wrapper with exponential backoff on errors/rate limits
    const fetchOHLCVSafe = async (exchange: any, fSymbol: string, timeframe: string, limit: number, maxRetries = 3): Promise<any[]> => {
      // Ensure market is known to avoid CCXT ever calling loadMarkets() over the network
      ensureExchangeMarket(exchange, fSymbol);
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          // Subtle sub-second delay per call inside individual coin routines to restrict raw frequency peaks
          const delay = exchange.id === 'weex' ? 350 : 150;
          await new Promise(resolve => setTimeout(resolve, delay));
          return await exchange.fetchOHLCV(fSymbol, timeframe, undefined, limit);
        } catch (e: any) {
          attempt++;
          const errorMsg = e.message || '';
          const isInvalidSymbol = errorMsg.includes('-1142') || errorMsg.includes("Parameter 'symbol' is invalid") || errorMsg.includes('does not have market symbol');
          if (isInvalidSymbol) {
            return [];
          }
          const isRateLimit = errorMsg.includes('510') || errorMsg.includes('frequent') || errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('-1000') || errorMsg.includes('unknown error');
          
          if (attempt < maxRetries) {
            ensureExchangeMarket(exchange, fSymbol);
            const sleepMs = isRateLimit 
              ? (1500 * attempt + Math.floor(Math.random() * 1000))
              : (400 + Math.floor(Math.random() * 300));
            
            console.log(`[OHLCV RETRY] Soft retry ${attempt}/${maxRetries} for ${fSymbol} (${timeframe}). Sleeping for ${sleepMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, sleepMs));
          } else {
            console.log(`[OHLCV-ADAPTIVE] ${fSymbol} (${timeframe}) is temporarily unavailable after ${maxRetries} attempts on ${exchange.id || 'exchange'} (${errorMsg.slice(0, 150)}). System fell back to real-time ticker data.`);
            return [];
          }
        }
      }
      return [];
    };

    // Safe throttled concurrent batch routing designed for public rate endpoints limits
    const batchSize = 2; 
    for (let i = 0; i < symbolsToUpdate.length; i += batchSize) {
      const batch = symbolsToUpdate.slice(i, i + batchSize);
      await Promise.all(batch.map(async (symbol) => {
        const ex = symbolToEx[symbol];
        try {
          const currentEx = ctx.getCcxtExchange(ex);
          if (!currentEx) return;

          let realFetchSymbol = symbol;
          if (ex === 'weex') {
            ensureExchangeMarket(currentEx, symbol);
            const nativeId = symbol.split(':')[0].replace(/[\/_]/g, '');
            const unified = symbol.includes(':') ? symbol : `${symbol.split(':')[0]}:USDT`;
            const market = (Object.values(currentEx.markets || {}) as any[]).find((m: any) => (m.id === nativeId || m.symbol === unified || m.symbol === symbol) && (m.swap || m.future || m.linear || m.contract));
            if (market) {
              realFetchSymbol = market.symbol;
            } else {
              realFetchSymbol = unified;
              ensureExchangeMarket(currentEx, realFetchSymbol);
            }
          } else if (ex === 'mexc') {
            if (!currentEx.markets || Object.keys(currentEx.markets).length === 0) {
              await currentEx.loadMarkets().catch(() => {});
            }
            const nativeId = symbol.split(':')[0].replace('/', '_');
            const market = (Object.values(currentEx.markets || {}) as any[]).find((m: any) => (m.id === nativeId || m.symbol === symbol) && (m.swap || m.future || m.linear || m.contract));
            if (market) {
              realFetchSymbol = market.symbol;
            } else {
              const spotMarket = (Object.values(currentEx.markets || {}) as any[]).find((m: any) => m.id === nativeId || m.symbol === symbol);
              if (spotMarket) {
                realFetchSymbol = spotMarket.symbol;
              }
            }
          }

          // Fetch 15m first, it's more important for signals
          const ohlcv15m = await fetchOHLCVSafe(currentEx, realFetchSymbol, '15m', 100);
          if (ohlcv15m.length < 26) return;
          
          // Fetch 1m only if 15m is healthy
          const ohlcv1m = await fetchOHLCVSafe(currentEx, realFetchSymbol, '1m', 60);

          // Fetch 1h and 4h for HTF Global Trend Filter and FVG
          const ohlcv1h = await fetchOHLCVSafe(currentEx, realFetchSymbol, '1h', 100);
          const ohlcv4h = await fetchOHLCVSafe(currentEx, realFetchSymbol, '4h', 20);
          
          // Fetch 1d and 5m for 1D Trend context and 5m active execution
          const ohlcv1d = await fetchOHLCVSafe(currentEx, realFetchSymbol, '1d', 30);
          const ohlcv5m = await fetchOHLCVSafe(currentEx, realFetchSymbol, '5m', 100);
      
          if (ohlcv15m.length >= 26) {
            const cleanSym = symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
            GLOBAL_RAW_OHLCV[cleanSym] = {
              "15m": ohlcv15m,
              "1m": ohlcv1m || [],
              "5m": ohlcv5m || [],
              "1h": ohlcv1h || [],
              "4h": ohlcv4h || [],
              "1d": ohlcv1d || []
            };

            const closes15 = ohlcv15m.map(h => h[4] as number);
            const highs15 = ohlcv15m.map(h => h[2] as number);
            const lows15 = ohlcv15m.map(h => h[3] as number);

            const price = closes15[closes15.length - 1];

            // RSI 15m
            let trueRsi15 = 50;
            const rsiValues = RSI.calculate({ values: closes15, period: 14 });
            if (rsiValues.length > 0) trueRsi15 = rsiValues[rsiValues.length - 1];
            
            // MACD 15m
            let macdSignal = 'NEUTRAL';
            let macdHistogram = 0;
            const macd = MACD.calculate({ values: closes15, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
            if (macd.length > 0) {
               const latest = macd[macd.length - 1];
               macdHistogram = latest.histogram || 0;
               if (latest.histogram && latest.histogram > 0) macdSignal = 'BULLISH';
               else if (latest.histogram && latest.histogram < 0) macdSignal = 'BEARISH';
            }

            const ema50Result = (ohlcv15m.length >= 50) ? calculateEMA(closes15, 50) : price;
            const ema200Result = (ohlcv15m.length >= 200) ? calculateEMA(closes15, 200) : price;

            // HTF global trend EMA 200 on 1h (1h timescale)
            const closes1h = ohlcv1h.length > 0 ? ohlcv1h.map(h => h[4] as number) : [];
            const ema200_1hResult = closes1h.length >= 50 ? calculateEMA(closes1h, Math.min(closes1h.length, 200)) : price;

            // 4h Fair Value Gap (FVG) detection (HTF imbalances)
            let hasFvgAbove = false;
            let hasBullishFvgBelow = false;
            let hasBearishFvgAbove = false;
            if (ohlcv4h.length >= 3) {
              for (let j = 1; j < ohlcv4h.length - 1; j++) {
                const c1 = ohlcv4h[j - 1]; // Older
                const c3 = ohlcv4h[j + 1]; // Newer
                if (c1 && c3) {
                  const c1High = c1[2] as number;
                  const c1Low = c1[3] as number;
                  const c3High = c3[2] as number;
                  const c3Low = c3[3] as number;
                  
                  // 4h Bullish FVG above the price (upward magnet)
                  if (c3Low > c1High && price < c3Low) {
                    hasFvgAbove = true;
                  }
                  // 4h Bullish FVG below the price (dynamic support threat for shorts)
                  if (c3Low > c1High && price > c3Low) {
                    hasBullishFvgBelow = true;
                  }
                  // 4h Bearish FVG above the price (dynamic resistance aiding short)
                  if (c1Low > c3High && price < c1Low) {
                    hasBearishFvgAbove = true;
                  }
                }
              }
            }

            // 15m Liquidity Sweep Pattern (Swing High & Swing Low)
            const lastIdx = highs15.length - 1;
            const prevHighs = highs15.slice(Math.max(0, lastIdx - 20), lastIdx);
            const swingHigh = prevHighs.length > 0 ? Math.max(...prevHighs) : price;
            const currentHigh = highs15[lastIdx];
            const currentClose = closes15[lastIdx];
            const isLiquiditySweep = currentHigh > swingHigh && currentClose < swingHigh;

            const prevLows = lows15.slice(Math.max(0, lastIdx - 20), lastIdx);
            const swingLow = prevLows.length > 0 ? Math.min(...prevLows) : price;
            const currentLow = lows15[lastIdx];
            const isLiquiditySweepLow = currentLow < swingLow && currentClose > swingLow;

            // BB 15m
            let bbStatus = 'INSIDE';
            const bb = BollingerBands.calculate({ period: 20, values: closes15, stdDev: 2 });
            if (bb.length > 0) {
               const latest = bb[bb.length - 1];
               if (price > latest.upper) bbStatus = 'OVERBOUGHT';
               else if (price < latest.lower) bbStatus = 'OVERSOLD';
            }
            
            // PSAR 15m & 1m
            let psarStatus15: 'BULLISH' | 'BEARISH' = 'BULLISH';
            const psar15 = PSAR.calculate({ high: highs15, low: lows15, step: 0.02, max: 0.2 });
            if (psar15.length > 0) {
              psarStatus15 = closes15[closes15.length - 1] > psar15[psar15.length - 1] ? 'BULLISH' : 'BEARISH';
            }

            let psarStatus1m: 'BULLISH' | 'BEARISH' = 'BULLISH';
            let isSarFlipped1m = false;
            let isSarBearishFlipped1m = false;
            let isSarBullishFlipped1m = false;
            if (ohlcv1m.length >= 30) {
               const highs1 = ohlcv1m.map(h => h[2] as number);
               const lows1 = ohlcv1m.map(h => h[3] as number);
               const psar1 = PSAR.calculate({ high: highs1, low: lows1, step: 0.02, max: 0.2 });
               if (psar1.length > 5) {
                 const lastClose = ohlcv1m[ohlcv1m.length - 1][4] as number;
                 psarStatus1m = lastClose > psar1[psar1.length - 1] ? 'BULLISH' : 'BEARISH';
                 
                 for (let k = 1; k <= 5; k++) {
                     const idx = psar1.length - k;
                     const cClose = ohlcv1m[ohlcv1m.length - k][4] as number;
                     const cPsar = psar1[idx];
                     const pClose = ohlcv1m[ohlcv1m.length - k - 1][4] as number;
                     const pPsar = psar1[idx - 1];
                     
                     const cStat = cClose > cPsar ? 'BULLISH' : 'BEARISH';
                     const pStat = pClose > pPsar ? 'BULLISH' : 'BEARISH';
                     
                     if (cStat !== pStat) isSarFlipped1m = true;
                     if (cStat === 'BEARISH' && pStat === 'BULLISH') {
                         isSarBearishFlipped1m = true;
                     }
                     if (cStat === 'BULLISH' && pStat === 'BEARISH') {
                         isSarBullishFlipped1m = true;
                     }
                 }
               }
            }

            // ATR, ADX & VWAP
            const atrResult = ATR.calculate({ high: highs15, low: lows15, close: closes15, period: 14 });
            if (atrResult.length > 0) GLOBAL_ATR[symbol.replace('/', '')] = atrResult[atrResult.length - 1] || 0;
            try {
              if (highs15.length >= 28) {
                const adxResult = ADX.calculate({ high: highs15, low: lows15, close: closes15, period: 14 });
                if (adxResult.length > 0) GLOBAL_ADX[symbol.replace('/', '')] = adxResult[adxResult.length - 1].adx || 0;
              }
            } catch (e) {}

            let lastVwap = price;
            try {
               const vwapResult = VWAP.calculate({ high: highs15, low: lows15, close: closes15, volume: ohlcv15m.map(h => h[5] as number) });
               if (vwapResult.length > 0) lastVwap = vwapResult[vwapResult.length - 1];
            } catch (e) {}

            const latestHigh = highs15[highs15.length - 1];
            const latestLow = lows15[lows15.length - 1];
            const latestOpen = (ohlcv15m[ohlcv15m.length - 1][1]) as number;
            
            const bodyMax = Math.max(latestOpen, price);
            const bodyMin = Math.min(latestOpen, price);
            const topWick = latestHigh - bodyMax;
            const bottomWick = bodyMin - latestLow;
            const totalSize = (latestHigh - latestLow) || 1;

            let trend1d: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
            if (ohlcv1d && ohlcv1d.length >= 10) {
              const closes1d = ohlcv1d.map(h => h[4] as number);
              const ema1dVal = calculateEMA(closes1d, 10);
              trend1d = price > ema1dVal ? 'BULLISH' : 'BEARISH';
            }

            let isLiquiditySweep1h = false;
            let isLiquiditySweepLow1h = false;
            let swingHigh1h = price;
            let swingLow1h = price;
            if (ohlcv1h && ohlcv1h.length >= 15) {
              const highs1h = ohlcv1h.map(h => h[2] as number);
              const lows1h = ohlcv1h.map(h => h[3] as number);
              const closes1h = ohlcv1h.map(h => h[4] as number);
              const lastIdx1h = highs1h.length - 1;
              const prevHighs1h = highs1h.slice(Math.max(0, lastIdx1h - 15), lastIdx1h);
              const prevLows1h = lows1h.slice(Math.max(0, lastIdx1h - 15), lastIdx1h);
              swingHigh1h = prevHighs1h.length > 0 ? Math.max(...prevHighs1h) : price;
              swingLow1h = prevLows1h.length > 0 ? Math.min(...prevLows1h) : price;
              const currentHigh1h = highs1h[lastIdx1h];
              const currentLow1h = lows1h[lastIdx1h];
              const currentClose1h = closes1h[lastIdx1h];
              isLiquiditySweep1h = currentHigh1h > swingHigh1h && currentClose1h < swingHigh1h;
              isLiquiditySweepLow1h = currentLow1h < swingLow1h && currentClose1h > swingLow1h;
            }

            let localHigh5m = price;
            let localLow5m = price;
            let isLiquiditySweep5m = false;
            let isLiquiditySweepLow5m = false;
            let hasFvg5mAbove = false;
            let hasFvg5mBelow = false;
            const pointA5m = price;
            const pointB5m = price;

            if (ohlcv5m && ohlcv5m.length >= 20) {
              const closes5 = ohlcv5m.map(h => h[4] as number);
              const highs5 = ohlcv5m.map(h => h[2] as number);
              const lows5 = ohlcv5m.map(h => h[3] as number);
              
              localHigh5m = Math.max(...highs5.slice(-15));
              localLow5m = Math.min(...lows5.slice(-15));

              const lastIdx5 = highs5.length - 1;
              const prevHighs5 = highs5.slice(Math.max(0, lastIdx5 - 15), lastIdx5);
              const prevLows5 = lows5.slice(Math.max(0, lastIdx5 - 15), lastIdx5);
              const swingHigh5 = prevHighs5.length > 0 ? Math.max(...prevHighs5) : price;
              const swingLow5 = prevLows5.length > 0 ? Math.min(...prevLows5) : price;
              const currentHigh5 = highs5[lastIdx5];
              const currentLow5 = lows5[lastIdx5];
              const currentClose5 = closes5[lastIdx5];
              isLiquiditySweep5m = currentHigh5 > swingHigh5 && currentClose5 < swingHigh5;
              isLiquiditySweepLow5m = currentLow5 < swingLow5 && currentClose5 > swingLow5;

              for (let j = 1; j < ohlcv5m.length - 1; j++) {
                const c1 = ohlcv5m[j - 1];
                const c3 = ohlcv5m[j + 1];
                if (c1 && c3) {
                  const c1High = c1[2] as number;
                  const c1Low = c1[3] as number;
                  const c3High = c3[2] as number;
                  const c3Low = c3[3] as number;
                  
                  if (c1Low > c3High && price < c1Low) {
                    hasFvg5mAbove = true;
                  }
                  if (c3Low > c1High && price > c3Low) {
                    hasFvg5mBelow = true;
                  }
                }
              }
            }

            GLOBAL_TRUE_OHLCV[symbol.split(':')[0].replace('/', '')] = { 
                rsi1h: trueRsi15, 
                macd1h: macdSignal, 
                bb1h: bbStatus,
                vwap: lastVwap, 
                psarStatus: psarStatus15,
                psarStatus1m,
                isSarFlipped1m,
                isSarBearishFlipped1m,
                isSarBullishFlipped1m,
                wicks: { 
                  topPct: (((latestHigh - latestLow) / (latestLow || 1) * 100) >= 0.15) ? (topWick / totalSize) : 0, 
                  bottomPct: (((latestHigh - latestLow) / (latestLow || 1) * 100) >= 0.15) ? (bottomWick / totalSize) : 0, 
                  bodySize: bodyMax - bodyMin 
                },
                macdHistogram,
                ema50: ema50Result,
                ema200: ema200Result,
                is48hBreakout: (price < Math.min(...lows15)) ? 1 : 0,
                ema200_1h: ema200_1hResult,
                hasFvgAbove,
                hasBullishFvgBelow,
                hasBearishFvgAbove,
                isLiquiditySweep,
                isLiquiditySweepLow,
                trend1d,
                isLiquiditySweep1h,
                isLiquiditySweepLow1h,
                swingHigh1h,
                swingLow1h,
                localHigh5m,
                localLow5m,
                isLiquiditySweep5m,
                isLiquiditySweepLow5m,
                hasFvg5mAbove,
                hasFvg5mBelow,
                pointA5m,
                pointB5m,
                adx15m: GLOBAL_ADX[symbol.split(':')[0].replace('/', '')] || 25
            };
          }
        } catch (e: any) {
          console.error(`[OHLCV] Error for ${symbol}:`, e.message);
        }
      }));
      await new Promise(resolve => setTimeout(resolve, 800)); // Delay between fetches
    }
  } catch (e: any) {
    console.error('[OHLCV] Global Error:', e.message);
  }
}

export async function updateDerivativesData(ctx: MarketDataCollectorContext): Promise<void> {
  try {
    let funding: any = {};
    let oi: any = {};
    const isBinanceGeoblocked = ctx.isBinanceGeoblocked();
    const fundingRates = ctx.getFundingRates();
    const openInterests = ctx.getOpenInterests();
    const GLOBAL_DERIVATIVES = ctx.getGlobalDerivatives();

    if (!isBinanceGeoblocked) {
      try {
        const binance = new ccxt.binance({ enableRateLimit: true });
        binance.options['defaultType'] = 'swap';
        [funding, oi] = await Promise.all([
          binance.fetchFundingRates().catch(() => ({})),
          binance.fetchOpenInterests().catch(() => ({}))
        ]);
      } catch (bErr: any) {
        const msg = bErr?.message || bErr?.toString() || '';
        if (msg.includes('451') || msg.includes('restricted location') || msg.includes('Eligibility')) {
          ctx.setBinanceGeoblocked(true);
          console.warn('[DERIVATIVES] Binance API is geoblocked (451). Falling back to Bybit.');
        }
      }
    }
    if (ctx.isBinanceGeoblocked() || !funding || Object.keys(funding).length === 0) {
      try {
        const bybit = new ccxt.bybit({ enableRateLimit: true });
        bybit.options['defaultType'] = 'swap';
        const [bFunding, bOi] = await Promise.all([
          bybit.fetchFundingRates().catch(() => ({})),
          bybit.fetchOpenInterests().catch(() => ({}))
        ]);
        funding = bFunding || {};
        oi = bOi || {};
      } catch (bybitErr: any) {
        console.warn('[DERIVATIVES] Bybit fetch error:', bybitErr?.message || bybitErr);
      }
    }
    GLOBAL_DERIVATIVES.fundingRates = funding;
    for (const [symbol, data] of Object.entries<any>(funding)) {
      if (data && data.fundingRate !== undefined) {
        const cleanKey = symbol.split(':')[0].replace(/[\/:]/g, '');
        fundingRates[cleanKey] = data.fundingRate;
        fundingRates[symbol.replace(/[\/:]/g, '')] = data.fundingRate;
      }
    }
    for (const [symbol, data] of Object.entries<any>(oi)) {
      if (data) {
        const cleanKey = symbol.split(':')[0].replace(/[\/:]/g, '');
        const val = data.openInterestValue || data.baseVolume;
        openInterests[cleanKey] = val;
        openInterests[symbol.replace(/[\/:]/g, '')] = val; 
      }
    }
  } catch (e: any) { 
    console.error('Derivatives fetch error', e?.message || e); 
  }
}

export async function checkOrderBooks(ctx: MarketDataCollectorContext): Promise<void> {
  const CACHE = ctx.getCacheSignals();
  if (!CACHE || !CACHE.data) return;
  const topSignals = CACHE.data.slice(0, 20);
  const weex = ctx.getCcxtExchange('weex') || new ccxt.weex({ enableRateLimit: true });
  const orderBookImbalance = ctx.getOrderBookImbalance();
  const GLOBAL_ORDER_BOOK_HISTORY = ctx.getGlobalOrderBookHistory();

  for (const signal of topSignals) {
    try {
      const symbol = signal.symbol.includes('/') ? signal.symbol : signal.symbol.replace('USDT', '/USDT');
      ensureExchangeMarket(weex, symbol);
      const ob = await weex.fetchOrderBook(symbol, 100).catch(() => null);
      if (!ob) continue;
      let bidVolume = 0; let askVolume = 0;
      const currentPrice = signal.price;
      
      let bidsTotalSize = 0, asksTotalSize = 0;
      const validBids = (ob.bids || []).filter(([p, _]: [number, number]) => p >= currentPrice * 0.85);
      const validAsks = (ob.asks || []).filter(([p, _]: [number, number]) => p <= currentPrice * 1.15);
      
      validBids.forEach(([_, amt]: [number, number]) => bidsTotalSize += amt);
      validAsks.forEach(([_, amt]: [number, number]) => asksTotalSize += amt);
      
      const avgBid = validBids.length ? bidsTotalSize / validBids.length : 0;
      const avgAsk = validAsks.length ? asksTotalSize / validAsks.length : 0;
      
      const walls: { type: 'bid'|'ask', price: number, size: number, distancePct: number }[] = [];
      
      validBids.forEach(([p, amt]: [number, number]) => {
        if (p >= currentPrice * 0.985) bidVolume += p * amt;
        if (amt > avgBid * 5 && amt * p > 5000) { // >5x avg size and >$5000 volume
          walls.push({ type: 'bid', price: p, size: amt * p, distancePct: ((currentPrice - p) / currentPrice) * 100 });
        }
      });
      
      validAsks.forEach(([p, amt]: [number, number]) => {
        if (p <= currentPrice * 1.015) askVolume += p * amt;
        if (amt > avgAsk * 5 && amt * p > 5000) { 
          walls.push({ type: 'ask', price: p, size: amt * p, distancePct: ((p - currentPrice) / currentPrice) * 100 });
        }
      });
      
      const topBidWalls = walls.filter(w => w.type === 'bid').sort((a,b) => b.size - a.size).slice(0, 3);
      const topAskWalls = walls.filter(w => w.type === 'ask').sort((a,b) => b.size - a.size).slice(0, 3);

      let askWallForce = 0;
      let bidWallForce = 0;
      topAskWalls.forEach(w => {
        if (w.distancePct <= 2.0) {
          askWallForce += (w.size / 5000) * (2.0 - w.distancePct);
        }
      });
      topBidWalls.forEach(w => {
        if (w.distancePct <= 1.5) {
          bidWallForce += (w.size / 5000) * (1.5 - w.distancePct);
        }
      });
      const wallDensityScore = Number((askWallForce - bidWallForce).toFixed(2));

      // L2 Iceberg Density Wall Detection & Smart Limit Placement
      const largestAskWall = topAskWalls.length > 0 ? topAskWalls[0] : null;
      const largestBidWall = topBidWalls.length > 0 ? topBidWalls[0] : null;

      const hasAskIceberg = largestAskWall && (largestAskWall.size >= 10000 || largestAskWall.size > (askVolume / Math.max(1, topAskWalls.length)) * 2.5);
      const hasBidIceberg = largestBidWall && (largestBidWall.size >= 10000 || largestBidWall.size > (bidVolume / Math.max(1, topBidWalls.length)) * 2.5);

      const icebergs = {
        askIceberg: hasAskIceberg ? {
          price: largestAskWall.price,
          size: largestAskWall.size,
          distancePct: largestAskWall.distancePct,
          smartSellLimit: Number((largestAskWall.price * 0.9997).toFixed(5)) // Front-run 0.03% below Ask Iceberg Wall
        } : null,
        bidIceberg: hasBidIceberg ? {
          price: largestBidWall.price,
          size: largestBidWall.size,
          distancePct: largestBidWall.distancePct,
          smartBuyLimit: Number((largestBidWall.price * 1.0003).toFixed(5)) // Front-run 0.03% above Bid Iceberg Wall
        } : null
      };

      const total = bidVolume + askVolume;
      const imbalance = total > 0 ? ((askVolume - bidVolume) / total) * 100 : 0;
      const cleanSym = signal.symbol.replace('/', '');
      orderBookImbalance[cleanSym] = { 
        bidVolume, 
        askVolume, 
        imbalance, 
        walls: [...topBidWalls, ...topAskWalls],
        wallDensityScore,
        bidWallForce: Number(bidWallForce.toFixed(2)),
        askWallForce: Number(askWallForce.toFixed(2)),
        icebergs
      };

      if (!GLOBAL_ORDER_BOOK_HISTORY[cleanSym]) {
        GLOBAL_ORDER_BOOK_HISTORY[cleanSym] = [];
      }
      GLOBAL_ORDER_BOOK_HISTORY[cleanSym].push({
        timestamp: Date.now(),
        bidVolume,
        askVolume,
        imbalance,
        wallDensityScore,
        walls: [...topBidWalls, ...topAskWalls]
      });
      if (GLOBAL_ORDER_BOOK_HISTORY[cleanSym].length > 120) {
        GLOBAL_ORDER_BOOK_HISTORY[cleanSym].shift();
      }
    } catch (e) {}
  }
}

export function recalculateIndicatorsForSymbol(cleanSym: string, ctx: MarketDataCollectorContext): void {
  try {
    const GLOBAL_RAW_OHLCV = ctx.getGlobalRawOHLCV();
    const GLOBAL_TRUE_OHLCV = ctx.getGlobalTrueOHLCV();
    const GLOBAL_ATR = ctx.getGlobalATR();
    const GLOBAL_ADX = ctx.getGlobalADX();

    const raw = GLOBAL_RAW_OHLCV[cleanSym];
    if (!raw || !raw['15m'] || raw['15m'].length < 26) return;
    
    const ohlcv15m = raw['15m'];
    const ohlcv1m = raw['1m'] || [];
    
    const closes15 = ohlcv15m.map((h: any) => h[4] as number);
    const highs15 = ohlcv15m.map((h: any) => h[2] as number);
    const lows15 = ohlcv15m.map((h: any) => h[3] as number);
    const price = closes15[closes15.length - 1];
    
    // RSI 15m
    let trueRsi15 = 50;
    const rsiValues = RSI.calculate({ values: closes15, period: 14 });
    if (rsiValues.length > 0) trueRsi15 = rsiValues[rsiValues.length - 1];
    
    // MACD 15m
    let macdSignal = 'NEUTRAL';
    let macdHistogram = 0;
    const macd = MACD.calculate({ values: closes15, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    if (macd.length > 0) {
       const latest = macd[macd.length - 1];
       macdHistogram = latest.histogram || 0;
       if (latest.histogram && latest.histogram > 0) macdSignal = 'BULLISH';
       else if (latest.histogram && latest.histogram < 0) macdSignal = 'BEARISH';
    }
    
    const ema50Result = (ohlcv15m.length >= 50) ? calculateEMA(closes15, 50) : price;
    const ema200Result = (ohlcv15m.length >= 200) ? calculateEMA(closes15, 200) : price;
    
    // 15m Liquidity Sweep
    const lastIdx = highs15.length - 1;
    const prevHighs = highs15.slice(Math.max(0, lastIdx - 20), lastIdx);
    const swingHigh = prevHighs.length > 0 ? Math.max(...prevHighs) : price;
    const currentHigh = highs15[lastIdx];
    const currentClose = closes15[lastIdx];
    const isLiquiditySweep = currentHigh > swingHigh && currentClose < swingHigh;

    const prevLows = lows15.slice(Math.max(0, lastIdx - 20), lastIdx);
    const swingLow = prevLows.length > 0 ? Math.min(...prevLows) : price;
    const currentLow = lows15[lastIdx];
    const isLiquiditySweepLow = currentLow < swingLow && currentClose > swingLow;
    
    // BB 15m
    let bbStatus = 'INSIDE';
    const bb = BollingerBands.calculate({ period: 20, values: closes15, stdDev: 2 });
    if (bb.length > 0) {
       const latest = bb[bb.length - 1];
       if (price > latest.upper) bbStatus = 'OVERBOUGHT';
       else if (price < latest.lower) bbStatus = 'OVERSOLD';
    }
    
    // PSAR 15m & 1m
    let psarStatus15: 'BULLISH' | 'BEARISH' = 'BULLISH';
    const psar15 = PSAR.calculate({ high: highs15, low: lows15, step: 0.02, max: 0.2 });
    if (psar15.length > 0) {
      psarStatus15 = closes15[closes15.length - 1] > psar15[psar15.length - 1] ? 'BULLISH' : 'BEARISH';
    }
    
    let psarStatus1m: 'BULLISH' | 'BEARISH' = 'BULLISH';
    let isSarFlipped1m = false;
    let isSarBearishFlipped1m = false;
    let isSarBullishFlipped1m = false;
    if (ohlcv1m.length >= 30) {
       const highs1 = ohlcv1m.map((h: any) => h[2] as number);
       const lows1 = ohlcv1m.map((h: any) => h[3] as number);
       const psar1 = PSAR.calculate({ high: highs1, low: lows1, step: 0.02, max: 0.2 });
       if (psar1.length > 5) {
         const lastClose = ohlcv1m[ohlcv1m.length - 1][4] as number;
         psarStatus1m = lastClose > psar1[psar1.length - 1] ? 'BULLISH' : 'BEARISH';
         
         for (let i = 1; i <= 5; i++) {
             const idx = psar1.length - i;
             const cClose = ohlcv1m[ohlcv1m.length - i][4] as number;
             const cPsar = psar1[idx];
             const pClose = ohlcv1m[ohlcv1m.length - i - 1][4] as number;
             const pPsar = psar1[idx - 1];
             
             const cStat = cClose > cPsar ? 'BULLISH' : 'BEARISH';
             const pStat = pClose > pPsar ? 'BULLISH' : 'BEARISH';
             
             if (cStat !== pStat) isSarFlipped1m = true;
             if (cStat === 'BEARISH' && pStat === 'BULLISH') {
                 isSarBearishFlipped1m = true;
             }
             if (cStat === 'BULLISH' && pStat === 'BEARISH') {
                 isSarBullishFlipped1m = true;
             }
         }
       }
    }
    
    // ATR, ADX & VWAP
    const atrResult = ATR.calculate({ high: highs15, low: lows15, close: closes15, period: 14 });
    if (atrResult.length > 0) GLOBAL_ATR[cleanSym] = atrResult[atrResult.length - 1] || 0;
    try {
      if (highs15.length >= 28) {
        const adxResult = ADX.calculate({ high: highs15, low: lows15, close: closes15, period: 14 });
        if (adxResult.length > 0) GLOBAL_ADX[cleanSym] = adxResult[adxResult.length - 1].adx || 0;
      }
    } catch (e) {}
    
    let lastVwap = price;
    try {
       const vwapResult = VWAP.calculate({ high: highs15, low: lows15, close: closes15, volume: ohlcv15m.map((h: any) => h[5] as number) });
       if (vwapResult.length > 0) lastVwap = vwapResult[vwapResult.length - 1];
    } catch (e) {}
    
    const latestHigh = highs15[highs15.length - 1];
    const latestLow = lows15[lows15.length - 1];
    const latestOpen = ohlcv15m[ohlcv15m.length - 1][1] as number;
    
    const bodyMax = Math.max(latestOpen, price);
    const bodyMin = Math.min(latestOpen, price);
    const topWick = latestHigh - bodyMax;
    const bottomWick = bodyMin - latestLow;
    const totalSize = (latestHigh - latestLow) || 1;
    
    GLOBAL_TRUE_OHLCV[cleanSym] = {
        ...(GLOBAL_TRUE_OHLCV[cleanSym] || {}), // Preserve other values like FVG
        rsi1h: trueRsi15, 
        macd1h: macdSignal, 
        bb1h: bbStatus,
        vwap: lastVwap, 
        psarStatus: psarStatus15,
        psarStatus1m,
        isSarFlipped1m,
        isSarBearishFlipped1m,
        isSarBullishFlipped1m,
        wicks: { 
          topPct: (((latestHigh - latestLow) / (latestLow || 1) * 100) >= 0.15) ? (topWick / totalSize) : 0, 
          bottomPct: (((latestHigh - latestLow) / (latestLow || 1) * 100) >= 0.15) ? (bottomWick / totalSize) : 0, 
          bodySize: bodyMax - bodyMin 
        },
        macdHistogram,
        ema50: ema50Result,
        ema200: ema200Result,
        is48hBreakout: (price < Math.min(...lows15)) ? 1 : 0,
        isLiquiditySweep,
        isLiquiditySweepLow
    };

    if (ctx.onIndicatorsUpdated) {
      ctx.onIndicatorsUpdated(cleanSym);
    }
  } catch (e: any) {
    console.error(`[OHLCV-LOCAL] Error recalculating indicators for ${cleanSym}:`, e.message);
  }
}

export function updateLocalCandlesForSymbol(cleanSym: string, finalPrice: number, volumeDelta: number, ctx: MarketDataCollectorContext): void {
  try {
    const GLOBAL_RAW_OHLCV = ctx.getGlobalRawOHLCV();
    const raw = GLOBAL_RAW_OHLCV[cleanSym];
    if (!raw) return;
    
    const now = Date.now();
    let updated = false;
    
    for (const tf of ['1m', '15m'] as const) {
      const duration = tf === '1m' ? 60000 : 15 * 60000;
      const candles = raw[tf];
      if (!candles || candles.length === 0) continue;
      
      const lastCandle = candles[candles.length - 1];
      const bucketStart = Math.floor(now / duration) * duration;
      
      if (lastCandle[0] === bucketStart) {
        lastCandle[4] = finalPrice; // Close
        lastCandle[2] = Math.max(lastCandle[2], finalPrice); // High
        lastCandle[3] = Math.min(lastCandle[3], finalPrice); // Low
        lastCandle[5] += volumeDelta * 0.1; // Scale volume slightly for tickers
        updated = true;
      } else if (now >= lastCandle[0] + duration) {
        const newCandle = [bucketStart, finalPrice, finalPrice, finalPrice, finalPrice, volumeDelta * 0.1];
        candles.push(newCandle);
        if (candles.length > 150) {
          candles.shift();
        }
        updated = true;
      }
    }
    
    if (updated) {
      recalculateIndicatorsForSymbol(cleanSym, ctx);
    }
  } catch (e: any) {
    console.error(`[OHLCV-LOCAL] Error updating candles for ${cleanSym}:`, e.message);
  }
}

export function getWallAdjustedTp(symbol: string, isSell: boolean, currentPrice: number, targetTpPrice: number, ctx: MarketDataCollectorContext): number {
  if (!isSell) return targetTpPrice; // Only apply to shorts as specified
  const cleanSym = symbol.replace(/[\/:]/g, '').toUpperCase();
  const orderBookImbalance = ctx.getOrderBookImbalance();
  const obData = orderBookImbalance[cleanSym];
  if (!obData || !obData.walls) return targetTpPrice;
  
  // Find bid walls that are below current price but above or very close to our target tpPrice, within 1.5% from current price
  const bidWalls = obData.walls.filter((w: any) => w.type === 'bid' && w.price < currentPrice && w.price >= currentPrice * 0.985);
  if (bidWalls.length === 0) return targetTpPrice;
  
  // Sort bid walls by highest price (closest to current price, i.e., the first barrier on the short's path)
  bidWalls.sort((a: any, b: any) => b.price - a.price);
  
  for (const wall of bidWalls) {
    if (wall.price > targetTpPrice) {
      // Front-run the bid wall by placing TP slightly above it (e.g. 0.05% higher)
      const adjustedTp = Number((wall.price * 1.0005).toFixed(5));
      if (adjustedTp < currentPrice) {
        console.log(`[ORDER BOOK FILTER] Adjusting TP for ${symbol} SHORT from ${targetTpPrice} to ${adjustedTp} to front-run bid wall at ${wall.price} (size: $${wall.size.toFixed(0)})`);
        return adjustedTp;
      }
    }
  }
  return targetTpPrice;
}

export class MarketDataCollectorService {
  private ctx: MarketDataCollectorContext;
  private trueOhlcvInterval: NodeJS.Timeout | null = null;
  private derivativesInterval: NodeJS.Timeout | null = null;
  private orderBooksInterval: NodeJS.Timeout | null = null;

  constructor(ctx: MarketDataCollectorContext) {
    this.ctx = ctx;
  }

  public async updateTrueOHLCV(): Promise<void> {
    return updateTrueOHLCV(this.ctx);
  }

  public async updateDerivativesData(): Promise<void> {
    return updateDerivativesData(this.ctx);
  }

  public async checkOrderBooks(): Promise<void> {
    return checkOrderBooks(this.ctx);
  }

  public recalculateIndicatorsForSymbol(cleanSym: string): void {
    return recalculateIndicatorsForSymbol(cleanSym, this.ctx);
  }

  public updateLocalCandlesForSymbol(cleanSym: string, finalPrice: number, volumeDelta: number): void {
    return updateLocalCandlesForSymbol(cleanSym, finalPrice, volumeDelta, this.ctx);
  }

  public getWallAdjustedTp(symbol: string, isSell: boolean, currentPrice: number, targetTpPrice: number): number {
    return getWallAdjustedTp(symbol, isSell, currentPrice, targetTpPrice, this.ctx);
  }

  public startBackgroundSchedules(): void {
    const isMain = this.ctx.isMainThread();
    if (!isMain) {
      this.trueOhlcvInterval = setInterval(() => this.updateTrueOHLCV(), 2 * 60 * 1000);
      setTimeout(() => this.updateTrueOHLCV(), 15000);
      this.orderBooksInterval = setInterval(() => this.checkOrderBooks(), 15000);
    } else {
      this.derivativesInterval = setInterval(() => this.updateDerivativesData(), 5 * 60 * 1000);
      this.updateDerivativesData();
    }
  }

  public stopBackgroundSchedules(): void {
    if (this.trueOhlcvInterval) clearInterval(this.trueOhlcvInterval);
    if (this.derivativesInterval) clearInterval(this.derivativesInterval);
    if (this.orderBooksInterval) clearInterval(this.orderBooksInterval);
  }
}
