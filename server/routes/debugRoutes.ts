import express from 'express';
import type { Request, Response, Router } from 'express';

export interface DebugRouterContext {
  getGlobalTrueOhlcv: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, any>;
  getGlobalSettings: () => any;
  getAiKnowledgeBase: () => any[];
  getVirtualTrades: () => any[];
  getSignalsCache: () => any;
  updateTrueOHLCV: () => Promise<void>;
  updateSignalsCache: () => Promise<void>;
  isWeexApiSupported: (symbol: string) => boolean;
  runAiGeneration: (params: any) => Promise<any>;
  safeJsonParse: (str: string, fallback: any) => any;
  generateProgrammaticCommitteeFallback?: (item: any) => any;
}

export function createDebugRouter(ctx: DebugRouterContext): Router {
  const router = express.Router();

  // GET /api/debug-ohlcv
  router.get('/debug-ohlcv', (req: Request, res: Response) => {
    const globalTrueOhlcv = ctx.getGlobalTrueOhlcv();
    const keys = Object.keys(globalTrueOhlcv);
    res.json({ total: keys.length, sample: keys.slice(0, 10), sampleData: globalTrueOhlcv[keys[0]] });
  });

  // GET /api/debug/run-ohlcv
  router.get('/debug/run-ohlcv', async (req: Request, res: Response) => {
    try {
      console.log('[DEBUG-TRIGGER] Manually invoking updateTrueOHLCV...');
      
      const tickers = ctx.getGlobalCcxtTickers();
      const weexTickers = tickers['weex'] || {};
      const weexKeys = Object.keys(weexTickers);
      
      // Run update in background and respond immediately
      ctx.updateTrueOHLCV().catch((err: any) => {
        console.error('[DEBUG-TRIGGER] Error in background updateTrueOHLCV:', err);
      });
      
      const globalTrueOhlcv = ctx.getGlobalTrueOhlcv();
      
      res.json({
        success: true,
        message: 'updateTrueOHLCV triggered in background',
        weexTickersCount: weexKeys.length,
        currentOhlcvCount: Object.keys(globalTrueOhlcv).length,
        currentOhlcvSymbols: Object.keys(globalTrueOhlcv)
      });
    } catch (err: any) {
      console.error('[DEBUG-TRIGGER] Error in updateTrueOHLCV:', err);
      res.status(500).json({
        success: false,
        error: err.message,
        stack: err.stack
      });
    }
  });

  // GET /api/debug/run-signals
  router.get('/debug/run-signals', async (req: Request, res: Response) => {
    try {
      console.log('[DEBUG-TRIGGER] Manually invoking updateSignalsCache...');
      await ctx.updateSignalsCache();
      const cache = ctx.getSignalsCache();
      res.json({
        success: true,
        message: 'updateSignalsCache finished running',
        signalsCount: cache?.data?.length || 0,
        nonNeutral: cache?.data?.filter((s: any) => s.signal !== 'NEUTRAL').length || 0
      });
    } catch (err: any) {
      console.error('[DEBUG-TRIGGER] Error in updateSignalsCache:', err);
      res.status(500).json({
        success: false,
        error: err.message,
        stack: err.stack
      });
    }
  });

  // GET /api/debug/diagnose-signals
  router.get('/debug/diagnose-signals', async (req: Request, res: Response) => {
    try {
      const diagnostics: any[] = [];
      const globalTrueOhlcv = ctx.getGlobalTrueOhlcv();
      const globalCcxtTickers = ctx.getGlobalCcxtTickers();
      const globalSettings = ctx.getGlobalSettings();
      const keys = Object.keys(globalTrueOhlcv);
      
      for (const cleanSymbol of keys) {
        const cachedIndicators = globalTrueOhlcv[cleanSymbol];
        if (!cachedIndicators) continue;
        
        const price = cachedIndicators.sar || 0;
        let ticker: any = null;
        let symbolWithSlash = '';
        
        for (const exName in globalCcxtTickers) {
          const tickers = globalCcxtTickers[exName];
          if (tickers) {
            for (const [sym, t] of Object.entries<any>(tickers)) {
              const cleanSym = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
              if (cleanSym === cleanSymbol) {
                ticker = t;
                symbolWithSlash = sym;
                break;
              }
            }
          }
          if (ticker) break;
        }
        
        if (!ticker) {
          diagnostics.push({ symbol: cleanSymbol, status: "Missing live ticker data" });
          continue;
        }
        
        const tickerPrice = ticker.last || ticker.ask || price;
        const change = ticker.percentage || 0;
        const high = ticker.high || tickerPrice;
        const low = ticker.low || tickerPrice;
        const volume = ticker.quoteVolume || ticker.baseVolume || 0;
        const volatility = low > 0 ? ((high - low) / low) * 100 : 0;
        
        const recentHigh = high;
        const dropFromRecentHigh = recentHigh > 0 ? ((recentHigh - tickerPrice) / recentHigh) * 100 : 0;
        const dropFromHigh = tickerPrice > 0 ? ((high - tickerPrice) / high) * 100 : 0;
        const riseFromLow = low > 0 ? ((tickerPrice - low) / low) * 100 : 0;
        
        const vwapInfo = cachedIndicators.vwap || tickerPrice;
        const trueRsi = cachedIndicators.rsi1h || 50;
        const bbStatus = cachedIndicators.bb1h || 'INSIDE';
        const psarStatus1m = cachedIndicators.psarStatus1m || 'BEARISH';
        const isSarBearishFlipped1m = cachedIndicators.isSarBearishFlipped1m || false;
        const isShortTermBearish = psarStatus1m === 'BEARISH';
        const isQuickLocalSpike = (change >= 3.0 || riseFromLow >= 3.0) && dropFromRecentHigh <= 3.0;
        
        let matchedPattern = 'None';
        const wicks = cachedIndicators.wicks || { topPct: 0.4, bottomPct: 0.1, bodySize: 0 };
        const volumeSpike = cachedIndicators.volumeSpike || 1.0;
        const aggressiveness = globalSettings.autopilotAggressiveness || 'conservative';
        
        if (volume > 500) {
          let thr7 = 7.0;
          let thr5 = 5.0;
          let thr4 = 4.0;
          let thr3 = 3.0;
          let thr8 = 8.0;
          let thrRsi75 = 75;
          let activeSarBearish = isSarBearishFlipped1m;

          if (aggressiveness === 'aggressive') {
              thr7 = 4.0;
              thr5 = 3.0;
              thr4 = 2.5;
              thr3 = 2.0;
              thr8 = 5.0;
              thrRsi75 = 70;
              activeSarBearish = isSarBearishFlipped1m || psarStatus1m === 'BEARISH';
          } else if (aggressiveness === 'moderate') {
              thr7 = 5.5;
              thr5 = 4.0;
              thr4 = 3.2;
              thr3 = 2.5;
              thr8 = 6.5;
              thrRsi75 = 72;
              activeSarBearish = isSarBearishFlipped1m || psarStatus1m === 'BEARISH';
          }

          if ((change >= thr7 || isQuickLocalSpike) && activeSarBearish && dropFromRecentHigh >= 0.5 && dropFromRecentHigh <= 3.5 && volumeSpike < 2.0) {
            matchedPattern = '💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)';
          } else if (wicks.topPct > 0.55 && (change > thr3 || isQuickLocalSpike) && tickerPrice < vwapInfo && isShortTermBearish && dropFromRecentHigh <= 3.5) {
            matchedPattern = '🧹 False Breakout (Ложный пробой)';
          } else if ((change >= thr4 || riseFromLow >= thr8 || isQuickLocalSpike) && activeSarBearish && wicks.topPct > 0.4 && dropFromRecentHigh <= 3.5) {
            matchedPattern = '🔥 Vertical Exhaustion (Разворот)';
          } else if (change >= thr5 && dropFromRecentHigh <= 1.0 && isShortTermBearish) {
            matchedPattern = '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)';
          } else if (volumeSpike > 5 && change < 0.5 && (change > thr5 || isQuickLocalSpike) && dropFromRecentHigh > 0.5 && dropFromRecentHigh <= 3.0) {
            matchedPattern = '💀 Volume Climax (Predictive Dump)';
          } else if ((change >= thr5 || isQuickLocalSpike) && trueRsi >= thrRsi75 && dropFromRecentHigh <= 0.6 && (bbStatus === 'OVERBOUGHT' || wicks.topPct > 0.30)) {
            matchedPattern = '⚡ EXTREME OVERBOUGHT PEAK';
          }
        }
        
        const isWeexSupported = ctx.isWeexApiSupported(symbolWithSlash);
        const ema200_1hVal = cachedIndicators.ema200_1h;
        const isEma200Lock = (globalSettings.isEma200FilterEnabled !== false) && ema200_1hVal && tickerPrice > ema200_1hVal;
        
        const hasFvgAboveVal = cachedIndicators.hasFvgAbove;
        const isFvgAboveLock = (globalSettings.isFvgAboveFilterEnabled !== false) && !!hasFvgAboveVal;
        
        const hasBullishFvgBelowVal = cachedIndicators.hasBullishFvgBelow;
        const isBullishFvgBelowLock = (globalSettings.isFvgSupportBelowFilterEnabled !== false) && !!hasBullishFvgBelowVal;
        
        const isSweepVal = cachedIndicators.isLiquiditySweep || cachedIndicators.isLiquiditySweep1h || cachedIndicators.isLiquiditySweep5m;
        const sweepWickThreshold = globalSettings.liquiditySweepWickThreshold !== undefined ? globalSettings.liquiditySweepWickThreshold : 0.60;
        const isSweepLock = (globalSettings.isLiquiditySweepFilterEnabled !== false) && !isSweepVal && wicks.topPct < sweepWickThreshold;
        
        const peakDropLimit = Math.max(3.0, Math.min(5.5, volatility * 0.4));
        const isLateShortLock = (globalSettings.isLateShortFilterEnabled !== false) && (dropFromRecentHigh > peakDropLimit || (dropFromHigh > 4.5 && !isQuickLocalSpike)) && !matchedPattern.includes('РЕТЕСТ ПИКА');
        
        const isVolatilityBrakeLock = globalSettings.isVolatilityBrakeEnabled && volatility > (globalSettings.maxVolatilityLimit || 12.0);
        
        diagnostics.push({
          symbol: cleanSymbol,
          price: tickerPrice,
          change24h: change,
          volatility: volatility.toFixed(2),
          isWeexSupported,
          indicators: {
            rsi1h: trueRsi,
            psarStatus1m,
            isLiquiditySweep: !!isSweepVal,
            wicksTopPct: wicks.topPct,
            ema200_1h: ema200_1hVal,
            hasFvgAbove: !!hasFvgAboveVal,
            hasBullishFvgBelow: !!hasBullishFvgBelowVal
          },
          matchedPattern,
          filters: {
            ema200AboveIsLock: !!isEma200Lock,
            fvgAboveIsLock: !!isFvgAboveLock,
            fvgSupportBelowIsLock: !!isBullishFvgBelowLock,
            missingSweepOrTopWickIsLock: !!isSweepLock,
            lateShortIsLock: !!isLateShortLock,
            volatilityBrakeIsLock: !!isVolatilityBrakeLock
          },
          summary: matchedPattern !== 'None' 
            ? `Matched: ${matchedPattern}. Active block locks: ${[isEma200Lock ? 'EMA200' : '', isFvgAboveLock ? '4hFVGAbove' : '', isBullishFvgBelowLock ? '4hFVGBelowSupport' : '', isSweepLock ? 'Sweep/Wick' : '', isLateShortLock ? 'Late' : ''].filter(Boolean).join(', ') || 'NONE!'}`
            : "No specific pump/dump pattern matched"
        });
      }
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        totalCoinsCalculated: keys.length,
        diagnostics
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/debug/force-trigger-scan
  router.post('/debug/force-trigger-scan', async (req: Request, res: Response) => {
    try {
      const globalTrueOhlcv = ctx.getGlobalTrueOhlcv();
      const globalCcxtTickers = ctx.getGlobalCcxtTickers();
      const globalSettings = ctx.getGlobalSettings();
      const aiKnowledgeBase = ctx.getAiKnowledgeBase();

      const keys = Object.keys(globalTrueOhlcv);
      if (keys.length === 0) {
        return res.status(400).json({ success: false, error: 'Пока нет рассчитанных данных в GLOBAL_TRUE_OHLCV. Подождите обновления системного сканера.' });
      }
      
      // Shuffling keys and picking 5 random symbols
      const shuffled = keys.sort(() => 0.5 - Math.random());
      const selectedSymbols = shuffled.slice(0, 5);
      
      const results: any[] = [];
      
      for (const cleanSymbol of selectedSymbols) {
        const cachedIndicators = globalTrueOhlcv[cleanSymbol];
        if (!cachedIndicators) continue;
        
        const price = cachedIndicators.sar || 0;
        let ticker: any = null;
        
        for (const exName in globalCcxtTickers) {
          const tickers = globalCcxtTickers[exName];
          if (tickers) {
            for (const [sym, t] of Object.entries<any>(tickers)) {
              const cleanSym = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
              if (cleanSym === cleanSymbol) {
                ticker = t;
                break;
              }
            }
          }
          if (ticker) break;
        }
        
        if (!ticker) {
          results.push({
            symbol: cleanSymbol,
            error: "Missing live ticker data"
          });
          continue;
        }
        
        const tickerPrice = ticker.last || ticker.ask || price;
        const change = ticker.percentage || 0;
        const high = ticker.high || tickerPrice;
        const low = ticker.low || tickerPrice;
        const volume = ticker.quoteVolume || ticker.baseVolume || 0;
        const volatility = low > 0 ? ((high - low) / low) * 100 : 0;
        
        const recentHigh = high;
        const dropFromRecentHigh = recentHigh > 0 ? ((recentHigh - tickerPrice) / recentHigh) * 100 : 0;
        const dropFromHigh = tickerPrice > 0 ? ((high - tickerPrice) / high) * 100 : 0;
        const riseFromLow = low > 0 ? ((tickerPrice - low) / low) * 100 : 0;
        
        const vwapInfo = cachedIndicators.vwap || tickerPrice;
        const trueRsi = cachedIndicators.rsi1h || 50;
        const bbStatus = cachedIndicators.bb1h || 'INSIDE';
        const psarStatus1m = cachedIndicators.psarStatus1m || 'BEARISH';
        const isSarBearishFlipped1m = cachedIndicators.isSarBearishFlipped1m || false;
        const isSarBullishFlipped1m = cachedIndicators.isSarBullishFlipped1m || false;
        const isShortTermBearish = psarStatus1m === 'BEARISH';
        const isQuickLocalSpike = (change >= 3.0 || riseFromLow >= 3.0) && dropFromRecentHigh <= 3.0;
        const isQuickLocalDrop = (change <= -3.0 || dropFromRecentHigh >= 3.0) && riseFromLow <= 3.0;
        
        let matchedPattern = 'None';
        const wicks = cachedIndicators.wicks || { topPct: 0.4, bottomPct: 0.1, bodySize: 0 };
        const volumeSpike = cachedIndicators.volumeSpike || 1.0;
        
        // Pattern Matching Logic (Copy of the Agent #1 Core Patterns in updateSignalsCache)
        if (volume > 500) {
          if ((change >= 7 || isQuickLocalSpike) && isSarBearishFlipped1m && dropFromRecentHigh >= 0.5 && dropFromRecentHigh <= 3.5 && volumeSpike < 2.0) {
            matchedPattern = '💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)';
          } else if (wicks.topPct > 0.55 && (change > 3 || isQuickLocalSpike) && tickerPrice < vwapInfo && isShortTermBearish && dropFromRecentHigh <= 3.5) {
            matchedPattern = '🧹 False Breakout (Ложный пробой)';
          } else if ((change >= 4 || riseFromLow >= 8 || isQuickLocalSpike) && isSarBearishFlipped1m && wicks.topPct > 0.4 && dropFromRecentHigh <= 3.5) {
            matchedPattern = '🔥 Vertical Exhaustion (Разворот)';
          } else if (cachedIndicators.obImbalance > 85 && (change >= 5 || isQuickLocalSpike) && dropFromRecentHigh <= 1.0 && (cachedIndicators.funding || 0) > 0.02 && isShortTermBearish) {
            matchedPattern = '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)';
          } else if (volumeSpike > 5 && (change > 5 || isQuickLocalSpike) && dropFromRecentHigh > 0.5 && dropFromRecentHigh <= 3.0) {
            matchedPattern = '💀 Volume Climax (Predictive Dump)';
          } else if ((change >= 5 || isQuickLocalSpike) && trueRsi >= 75 && dropFromRecentHigh <= 0.6 && (bbStatus === 'OVERBOUGHT' || wicks.topPct > 0.30 || volumeSpike > 3.0)) {
            matchedPattern = '⚡ EXTREME OVERBOUGHT PEAK (Early Limit SHORT Entry)';
          } else if (change <= -7 && isSarBullishFlipped1m && riseFromLow >= 0.5 && riseFromLow <= 3.5 && volumeSpike < 2.0) {
            matchedPattern = '💥 ПРОЛИВ (SAR Bottom Reversal)';
          } else if (wicks.bottomPct > 0.60 && change < -3 && tickerPrice < vwapInfo && psarStatus1m === 'BULLISH' && riseFromLow <= 3.5) {
            matchedPattern = '🧹 Снятие ликвидности снизу (Bottom Liquidity Sweep)';
          } else if (change < -5 && (cachedIndicators.obImbalance || 50) < 15 && riseFromLow <= 1.0 && (cachedIndicators.funding || 0) < -0.02 && psarStatus1m === 'BULLISH') {
            matchedPattern = '💎 ИДЕАЛЬНЫЙ ЛОНГ (Smart Liquidity Floor)';
          } else if (volumeSpike > 5 && change >= -0.5 && change < -5 && riseFromLow > 0.5 && riseFromLow <= 3.0) {
            matchedPattern = '💀 Volume Climax Bottom (Recovery)';
          } else if ((change <= -5 || isQuickLocalDrop) && trueRsi <= 25 && riseFromLow <= 0.6 && (bbStatus === 'OVERSOLD' || wicks.bottomPct > 0.30 || volumeSpike > 3.0)) {
            matchedPattern = '⚡ EXTREME OVERSOLD DIP (Early Limit LONG Entry)';
          }
        }
        
        // Evaluate actual block locks:
        const blockLocks: string[] = [];
        const blockDetails: string[] = [];
        
        const ema200_1hVal = cachedIndicators.ema200_1h;
        if (globalSettings.isEma200FilterEnabled !== false && ema200_1hVal && tickerPrice > ema200_1hVal) {
          blockLocks.push("EMA200");
          blockDetails.push(`Цена ${tickerPrice.toFixed(4)} выше 1h EMA-200 (${ema200_1hVal.toFixed(4)}) - Шортить запрещено`);
        }
        if (globalSettings.isFvgAboveFilterEnabled !== false && cachedIndicators.hasFvgAbove) {
          blockLocks.push("4hFVGAbove");
          blockDetails.push("Активна магнитная бычья зона FVG сверху - Шорт небезопасен");
        }
        if (globalSettings.isFvgSupportBelowFilterEnabled !== false && cachedIndicators.hasBullishFvgBelow) {
          blockLocks.push("4hFVGBelowSupport");
          blockDetails.push("Прямо снизу находится сильная 4h FVG бычья поддержка");
        }
        const sweepWickThreshold2 = globalSettings.liquiditySweepWickThreshold !== undefined ? globalSettings.liquiditySweepWickThreshold : 0.60;
        if (globalSettings.isLiquiditySweepFilterEnabled !== false && !cachedIndicators.isLiquiditySweep && wicks.topPct < sweepWickThreshold2) {
          blockLocks.push("Sweep/Wick");
          blockDetails.push(`Нет подтвержденного Свипа ликвидности, и верхний фитиль (${(wicks.topPct * 100).toFixed(1)}%) ниже ${(sweepWickThreshold2 * 100).toFixed(0)}%`);
        }
        if (globalSettings.isLateShortFilterEnabled !== false && (dropFromRecentHigh > 3.0 || dropFromHigh > 4.5)) {
          blockLocks.push("Late");
          blockDetails.push(`Опоздавший шорт: цена уже ушла вниз от хая на ${dropFromRecentHigh.toFixed(2)}%`);
        }
        
        const fundingVal = cachedIndicators.funding || 0;
        const rawFundingLimit = (globalSettings.fundingShieldLimit || -0.15) / 100;
        if (fundingVal < rawFundingLimit) {
          blockLocks.push("FundingShield");
          blockDetails.push(`Сверхнегативный фандинг (${(fundingVal * 100).toFixed(4)}% < ${(rawFundingLimit * 100).toFixed(4)}%) - Опасность выбивания шортов`);
        }
        if (globalSettings.isVolatilityBrakeEnabled && volatility > (globalSettings.maxVolatilityLimit || 12.0)) {
          blockLocks.push("VolatilityBrake");
          blockDetails.push(`Часовая волатильность (${volatility.toFixed(1)}%) превышает лимит (${(globalSettings.maxVolatilityLimit || 12.0).toFixed(1)}%)`);
        }

        results.push({
          symbol: cleanSymbol,
          exchange: 'weex',
          price: tickerPrice,
          change24h: change,
          volume,
          matchedPattern,
          blockLocks,
          blockDetails,
          indicators: {
            rsi1h: trueRsi,
            vwap: vwapInfo,
            volatility,
            topWickPct: wicks.topPct,
            bottomWickPct: wicks.bottomPct,
            volumeSpike,
            ema200_1h: ema200_1hVal,
            isLiquiditySweep: !!cachedIndicators.isLiquiditySweep,
            hasBullishFvgBelow: !!cachedIndicators.hasBullishFvgBelow,
            hasFvgAbove: !!cachedIndicators.hasFvgAbove
          }
        });
      }
      
      // Now, run the actual AI Committee via Gemini on these 5 coins
      const rules = aiKnowledgeBase.filter(r => (r.agent === 'SCANNER' || r.agent === 'GENERAL') && !r.isArchived).map(r => r.text).join('\n');
      
      const prompt = `You are a strict Consensus AI Trading Committee consisting of 3 agents:
1. The Bull (Agent 1): Looks for reasons to BUY or enter LONG, or highlights positive metrics.
2. The Bear (Agent 2): Looks for reasons to REJECT or SHORT, or highlights warning indicators and risk factors.
3. The Judge (Agent 3): Listens to both and makes the final decision.

KNOWLEDGE BASE (RULES TO FOLLOW BY THE COMMITTEE):
${rules}

Please perform a structured, highly analytical review for each of the following coins:
Data: ${JSON.stringify(results)}

We want to debug exactly why these coins are not triggering trades (e.g. identify active block locks like EMA200 active, FVG magnet active, lacking liquidity sweep, or extreme heat).
You must return your response as a valid, standard JSON array of objects. Do not wrap it in markdown block quotes, do not add backticks, do not write anything else.
Each object must contain these keys exactly:
- symbol (string, matching the input symbol)
- bullVerdict (string: Russian language analytical comment from Agent 1)
- bearVerdict (string: Russian language analytical comment from Agent 2)
- judgeVerdict (string: Russian language final consensus decision from Agent 3)
- aiScore (number, 0 to 100, where >=90 is high confidence, <50 is weak configuration)
- finalVerdict (string: "SHORT", "LONG", or "REJECT")
`;

      try {
        const aiResponse = await ctx.runAiGeneration({
          model: 'gemini-3.7-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        });
        
        const committeeData = ctx.safeJsonParse(aiResponse.text, []);
        
        // Merge AI committee verdicts back into results
        for (const resItem of results) {
          const match = Array.isArray(committeeData) ? committeeData.find((item: any) => item && item.symbol === resItem.symbol) : null;
          if (match) {
            resItem.aiCommittee = {
              bullVerdict: match.bullVerdict || 'Сомнения в лонгах.',
              bearVerdict: match.bearVerdict || 'Сомнения в шортах.',
              judgeVerdict: match.judgeVerdict || 'Консенсус не достигнут.',
              aiScore: Number(match.aiScore) || 50,
              finalVerdict: match.finalVerdict || 'REJECT'
            };
          } else if (ctx.generateProgrammaticCommitteeFallback) {
            resItem.aiCommittee = ctx.generateProgrammaticCommitteeFallback(resItem);
          }
        }
      } catch (aiErr: any) {
        console.warn('[DEBUG FORCE TRIGGER] AI generation failed, falling back to programmatic committee:', aiErr.message);
        if (ctx.generateProgrammaticCommitteeFallback) {
          for (const resItem of results) {
            resItem.aiCommittee = ctx.generateProgrammaticCommitteeFallback(resItem);
          }
        }
      }
      
      // Print to terminal console
      console.log("\n=======================================================");
      console.log("⚡ FORCE TRIGGER SIGNALS SCAN & AI COMMITTEE VERDICTS ⚡");
      console.log(`Timestamp: ${new Date().toISOString()}`);
      console.log("=======================================================");
      for (const r of results) {
        console.log(`\n🔹 Монета: ${r.symbol} (Цена: $${r.price}, Изм24ч: ${r.change24h?.toFixed ? r.change24h.toFixed(2) : r.change24h}%)`);
        console.log(`   Паттерн: ${r.matchedPattern}`);
        console.log(`   Блок-фильтры: ${r.blockLocks && r.blockLocks.length > 0 ? r.blockLocks.join(', ') : 'НЕТ'}`);
        if (r.blockDetails && r.blockDetails.length > 0) {
          r.blockDetails.forEach((line: string) => console.log(`     🛑 ${line}`));
        }
        if (r.aiCommittee) {
          console.log(`   Комитет ИИ (Рейтинг: ${r.aiCommittee.aiScore}% | Финал: ${r.aiCommittee.finalVerdict})`);
          console.log(`     🟢 Бык:     ${r.aiCommittee.bullVerdict}`);
          console.log(`     🔴 Медведь: ${r.aiCommittee.bearVerdict}`);
          console.log(`     ⚖️ Судья:   ${r.aiCommittee.judgeVerdict}`);
        }
      }
      console.log("=======================================================\n");
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        results
      });
      
    } catch (err: any) {
      console.error('[API FORCE TRIGGER SCAN ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/debug/inject-test-signal
  router.post('/debug/inject-test-signal', async (req: Request, res: Response) => {
    try {
      const globalTrueOhlcv = ctx.getGlobalTrueOhlcv();
      const globalCcxtTickers = ctx.getGlobalCcxtTickers();
      const virtualTrades = ctx.getVirtualTrades();

      // Legacy direct signal injection support (if { signal: { ... } } passed)
      if (req.body.signal && req.body.signal.symbol) {
        const directSignal = req.body.signal;
        const sym = directSignal.symbol.toUpperCase().replace(/[\/:]/g, '');
        if (!globalTrueOhlcv[sym]) {
          globalTrueOhlcv[sym] = {
            rsi1h: 70,
            psarStatus1m: directSignal.side === 'SHORT' ? 'BEARISH' : 'BULLISH',
            isLiquiditySweep: true,
            wicks: { topPct: 0.6, bottomPct: 0.1, bodySize: 10 }
          };
        }
        await ctx.updateSignalsCache();
        return res.json({ success: true, message: `Direct signal injected for ${directSignal.symbol}`, signalDetails: directSignal });
      }

      const symbolInput = (req.body.symbol || 'SOLUSDT').toUpperCase().replace(/[\/:]/g, '');
      const direction = (req.body.direction || 'SHORT').toUpperCase();
      const force = req.body.force === true;

      // Inner helper to find WEEX ticker key
      const findWeexTickerKey = (cleanSym: string): string => {
        const tickers = globalCcxtTickers['weex'];
        if (!tickers) return '';
        for (const k of Object.keys(tickers)) {
          const norm = k.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
          if (norm === cleanSym) return k;
        }
        return '';
      };

      let tickerKey = findWeexTickerKey(symbolInput);
      if (!tickerKey) {
        tickerKey = `${symbolInput.replace('USDT', '')}/USDT:USDT`;
        if (!globalCcxtTickers['weex']) globalCcxtTickers['weex'] = {};
        globalCcxtTickers['weex'][tickerKey] = {
          symbol: tickerKey,
          last: symbolInput.startsWith('BTC') ? 65000 : (symbolInput.startsWith('ETH') ? 3400 : 100),
          percentage: 0,
          high: 100,
          low: 100,
          quoteVolume: 150000
        };
      }

      const ticker = globalCcxtTickers['weex'][tickerKey];
      const livePrice = ticker.last || 100;

      // Configure ticker for chosen pattern
      if (direction === 'SHORT') {
        ticker.percentage = 8.5; // Gain > 7% in 24h
        ticker.high = livePrice * 1.02;
        ticker.low = livePrice * 0.95;
        ticker.last = livePrice;
        ticker.quoteVolume = 250000;
      } else {
        ticker.percentage = -8.5; // Dump > 7% in 24h
        ticker.high = livePrice * 1.05;
        ticker.low = livePrice * 0.98;
        ticker.last = livePrice;
        ticker.quoteVolume = 250000;
      }

      // Inject indicators into True OHLCV cache
      if (direction === 'SHORT') {
        globalTrueOhlcv[symbolInput] = {
          rsi1h: 78,
          macd1h: 'BEARISH',
          bb1h: 'OVERBOUGHT',
          vwap: livePrice * 1.01,
          psarStatus: 'BEARISH',
          psarStatus1m: 'BEARISH',
          isSarFlipped1m: true,
          isSarBearishFlipped1m: true,
          isSarBullishFlipped1m: false,
          wicks: {
            topPct: 0.58,
            bottomPct: 0.05,
            bodySize: livePrice * 0.01
          },
          macdHistogram: -0.1,
          ema50: livePrice * 0.98,
          ema200: livePrice * 0.95,
          is48hBreakout: 0,
          ema200_1h: livePrice * 0.92,
          hasFvgAbove: false,
          hasBullishFvgBelow: false,
          isLiquiditySweep: true,
          trend1d: 'BEARISH',
          isLiquiditySweep1h: true,
          isLiquiditySweepLow1h: false,
          localHigh5m: livePrice * 1.01,
          localLow5m: livePrice * 0.95,
          isLiquiditySweep5m: true,
          isLiquiditySweepLow5m: false,
          hasFvg5mAbove: false,
          hasFvg5mBelow: false,
          pointA5m: livePrice,
          pointB5m: livePrice
        };
      } else {
        globalTrueOhlcv[symbolInput] = {
          rsi1h: 22,
          macd1h: 'BULLISH',
          bb1h: 'OVERSOLD',
          vwap: livePrice * 0.99,
          psarStatus: 'BULLISH',
          psarStatus1m: 'BULLISH',
          isSarFlipped1m: true,
          isSarBearishFlipped1m: false,
          isSarBullishFlipped1m: true,
          wicks: {
            topPct: 0.05,
            bottomPct: 0.58,
            bodySize: livePrice * 0.01
          },
          macdHistogram: 0.1,
          ema50: livePrice * 1.02,
          ema200: livePrice * 1.05,
          is48hBreakout: 0,
          ema200_1h: livePrice * 1.08,
          hasFvgAbove: false,
          hasBullishFvgBelow: false,
          isLiquiditySweep: false,
          isLiquiditySweepLow1h: true,
          trend1d: 'BULLISH',
          isLiquiditySweep1h: false,
          localHigh5m: livePrice * 1.05,
          localLow5m: livePrice * 0.99,
          isLiquiditySweep5m: false,
          isLiquiditySweepLow5m: true,
          hasFvg5mAbove: false,
          hasFvg5mBelow: false,
          pointA5m: livePrice,
          pointB5m: livePrice
        };
      }

      let originalTradesBackup: any[] = [];
      if (force) {
        originalTradesBackup = [...virtualTrades];
        const cutoff = Date.now() - 4 * 60 * 60 * 1000;
        virtualTrades.length = 0;
        originalTradesBackup.forEach(t => {
          const tNorm = t.symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
          if (tNorm === symbolInput && t.status === 'CLOSED' && t.closeTime && t.closeTime > cutoff) {
            return;
          }
          virtualTrades.push(t);
        });
      }

      console.log(`[TEST-SIGNAL-INJECT] Injecting ${direction} mock data for ${symbolInput} (Price: $${livePrice}). Running scan...`);
      
      // Recalculate signals cache
      await ctx.updateSignalsCache();

      const signalsCache = ctx.getSignalsCache();
      const generatedSignal = signalsCache?.data?.find((s: any) => s.symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase() === symbolInput);

      // Restore original trades while keeping newly opened autopilot trade
      let openedTrade = null;
      if (force && originalTradesBackup.length > 0) {
        openedTrade = virtualTrades.find(t => {
          const tNorm = t.symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
          return tNorm === symbolInput && t.status === 'OPEN' && (Date.now() - (t.openTime || 0)) < 15000;
        });

        virtualTrades.length = 0;
        originalTradesBackup.forEach(t => virtualTrades.push(t));

        if (openedTrade) {
          virtualTrades.push(openedTrade);
        }
      } else {
        openedTrade = virtualTrades.find(t => {
          const tNorm = t.symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
          return tNorm === symbolInput && t.status === 'OPEN' && (Date.now() - (t.openTime || 0)) < 15000;
        });
      }

      res.json({
        success: true,
        message: `Тестовый сигнал для ${symbolInput} (${direction}) успешно внедрен в систему.`,
        price: livePrice,
        signalGenerated: !!generatedSignal,
        signalDetails: generatedSignal || null,
        autopilotTradeOpened: !!openedTrade,
        openedTradeDetails: openedTrade || null,
        note: 'Индикаторы временно подменены для симуляции идеальных условий. Изменения вступят в силу немедленно.'
      });

    } catch (err: any) {
      console.error('[TEST-SIGNAL-INJECT] Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/debug-mexc
  router.get('/debug-mexc', (req: Request, res: Response) => {
    const globalCcxtTickers = ctx.getGlobalCcxtTickers();
    const c = globalCcxtTickers['mexc'] ? Object.keys(globalCcxtTickers['mexc']).length : 0;
    const mKeys = globalCcxtTickers['mexc'] ? Object.keys(globalCcxtTickers['mexc']).filter(k => k.toLowerCase().includes('m')) : [];

    res.json({ mexcTickersCount: c, keysSample: c > 0 ? Object.keys(globalCcxtTickers['mexc']).slice(0, 5) : [], mKeys });
  });

  return router;
}
