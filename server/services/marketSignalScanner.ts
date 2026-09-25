import { EventEmitter } from 'events';
import { classifyMarketRegime } from './marketRegimeService.ts';
import { DecisionTraceService } from './decisionTraceService.ts';
import { isPatternBlacklisted } from './signalEngine.ts';
import type { MarketRegime } from '../types/trading.ts';

export interface MarketSignalScannerContext {
  getGlobalTrueOHLCV: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getGlobalSettings: () => {
    isEma200FilterEnabled?: boolean;
    isFvgAboveFilterEnabled?: boolean;
    isFvgSupportBelowFilterEnabled?: boolean;
    isLiquiditySweepFilterEnabled?: boolean;
    liquiditySweepWickThreshold?: number;
    isLateShortFilterEnabled?: boolean;
    [key: string]: any;
  };
  isBinanceCrossListed: (symbol: string) => boolean;
  setCachedSignals: (cacheObj: {
    data: any[];
    lastUpdated: number;
    marketRegime: any;
    marketHealth: number;
    btcTrend24h: number;
    regimeDetails?: any;
  }) => void;
  emitSignalsUpdated: () => void;
  runAutopilotAndVirtualTradeEntry?: () => Promise<void>;
  isMainThread: boolean;
}

/**
 * Традиционные фондовые токены/акции США, которые не должны сканироваться крипто-скальпером
 */
export const TRADITIONAL_EQUITY_SYMBOLS = new Set([
  'DELL', 'AAL', 'PYPL', 'CRM', 'ALAB', 'MUU', 'POET', 'QNTX', 'RGTI', 'IONQ',
  'AAPL', 'TSLA', 'NVDA', 'AMZN', 'MSFT', 'GOOGL', 'META', 'AMD', 'INTC', 'COIN',
  'MSTR', 'PLTR', 'BABA', 'UVXY', 'SPY', 'QQQ', 'SOXL', 'MSTU', 'NVDL',
  'DKNG', 'HPE', 'BIIB', 'HOOD', 'UBER', 'DIS', 'NFLX', 'BA', 'NKE', 'MARA',
  'RIOT', 'CLSK', 'LCID', 'RIVN', 'SOFI', 'SMCI', 'ARM', 'PANW', 'CRWD', 'MRVL', 'SNOW', 'SQ', 'ROKU'
]);

export function isTraditionalEquitySymbol(symbol: string): boolean {
  if (!symbol) return false;
  const base = symbol.split(':')[0].replace('/USDT', '').replace('USDT', '').replace(/[\/:]/g, '').toUpperCase();
  return TRADITIONAL_EQUITY_SYMBOLS.has(base);
}

/**
 * Программная квант-генерация вердиктов трёх агентов (Бык, Медведь, Судья)
 */
export function generateProgrammaticCommitteeFallback(resItem: any) {
  const { symbol, matchedPattern, blockLocks, blockDetails, indicators } = resItem || {};
  const isShortPattern = matchedPattern && (
    matchedPattern.includes('СЛИВ') || 
    matchedPattern.includes('False Breakout') || 
    matchedPattern.includes('Exhaustion') || 
    matchedPattern.includes('Smart Liquidity Lock') || 
    matchedPattern.includes('Volume Climax') || 
    matchedPattern.includes('OVERBOUGHT')
  );
  const isLongPattern = matchedPattern && (
    matchedPattern.includes('ПРОЛИВ') || 
    matchedPattern.includes('Bottom') || 
    matchedPattern.includes('Smart Liquidity Floor') || 
    matchedPattern.includes('OVERSOLD')
  );

  let bullVerdict = "";
  let bearVerdict = "";
  let judgeVerdict = "";
  let aiScore = 50;
  let finalVerdict = "REJECT";

  const cleanRsi = indicators?.rsi1h ? Number(indicators.rsi1h).toFixed(1) : '50.0';
  const cleanWick = indicators?.topWickPct ? (Number(indicators.topWickPct) * 100).toFixed(1) : '0.0';

  if (blockLocks && blockLocks.length > 0) {
    if (isLongPattern) {
      bullVerdict = `Бык: Зафиксирован паттерн на лонг "${matchedPattern}". RSI на уровне ${cleanRsi}, но присутствуют сдерживающие фильтры.`;
    } else {
      bullVerdict = `Бык: Покупательских импульсов не замечено. Актив находится под давлением тренда, лонг крайне опасен.`;
    }

    const blocksStr = blockLocks.join(', ');
    bearVerdict = `Медведь: Торговля в шорт заблокирована фильтрами: ${blocksStr}. `;
    if (blockDetails && blockDetails.length > 0) {
      bearVerdict += blockDetails.join('. ');
    } else {
      bearVerdict += `Обнаружены критические риски против открытия позиции.`;
    }

    judgeVerdict = `⚖️ Судья: Консенсус — REJECT. Модель отменена из-за жестких риск-фильтров (${blockLocks.length} активных ограничений). Сохраняем стабильность капитала.`;
    aiScore = Math.max(10, 45 - blockLocks.length * 8);
    finalVerdict = "REJECT";
  } else {
    if (isShortPattern) {
      bullVerdict = `Бык: Рост актива выглядит исчерпанным, RSI на отметке ${cleanRsi}. Входить в лонг на хаях нецелесообразно.`;
      bearVerdict = `Медведь: Сформирован качественный паттерн "${matchedPattern}" при верхнем фитиле ${cleanWick}%. Локальная структура готова к снижению.`;
      judgeVerdict = `⚖️ Судья: Консенсус — SHORT. Входим в позицию лимитным ордером по паттерну "${matchedPattern}". Стоп-лосс выставлен по сетке.`;
      aiScore = Math.min(98, 80 + Math.floor((indicators?.volumeSpike || 1) * 3));
      finalVerdict = "SHORT";
    } else if (isLongPattern) {
      bullVerdict = `Бык: Обнаружен разворотный паттерн "${matchedPattern}". RSI в зоне перепроданности (${cleanRsi}%), ожидаем бычий импульс.`;
      bearVerdict = `Медведь: Продажи иссякли, снятие ликвидности снизу подтверждено. Цели снизу отработаны.`;
      judgeVerdict = `⚖️ Судья: Консенсус — LONG. Входим в длинную позицию со стопом под локальный экстремум. Риск-реворд оправдан.`;
      aiScore = Math.min(98, 82 + Math.floor((indicators?.volumeSpike || 1) * 2));
      finalVerdict = "LONG";
    } else {
      bullVerdict = `Бык: Актив движется в неопределенном флэте. Отсутствуют ярко выраженные бычьи разворотные структуры.`;
      bearVerdict = `Медведь: Сильные шорт-паттерны также не зафиксированы. Объемы торгов находятся в пределах нормы.`;
      judgeVerdict = `⚖️ Судья: Консенсус — REJECT. Отсутствуют триггеры для открытия позиции. Оставляем монету в режиме ожидания.`;
      aiScore = 48;
      finalVerdict = "REJECT";
    }
  }

  return {
    bullVerdict,
    bearVerdict,
    judgeVerdict,
    aiScore,
    finalVerdict
  };
}

/**
 * Детерминированный fallback для списка инструментов
 */
export function runDeterministicQuantCommitteeFallback(data: any[]): any[] {
  if (!Array.isArray(data)) return [];
  return data.map(item => generateProgrammaticCommitteeFallback(item));
}

/**
 * Основной движок сканирования и кэширования торговых сигналов
 */
export async function executeUpdateSignalsCache(ctx: MarketSignalScannerContext): Promise<void> {
  try {
    const GLOBAL_TRUE_OHLCV = ctx.getGlobalTrueOHLCV();
    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    const globalSettings = ctx.getGlobalSettings();
    const symbolsSet = new Set<string>();
    for (const k of Object.keys(GLOBAL_TRUE_OHLCV)) {
      if (!isTraditionalEquitySymbol(k)) {
        symbolsSet.add(k);
      }
    }

    // Работаем исключительно с крипто-тикерами биржи WEEX (исключая акции)
    const weexTickers = GLOBAL_CCXT_TICKERS['weex'];
    if (weexTickers) {
      for (const sym of Object.keys(weexTickers)) {
        const clean = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
        if (clean && clean.endsWith('USDT') && !isTraditionalEquitySymbol(clean)) {
          symbolsSet.add(clean);
        }
      }
    }

    const signals: any[] = [];
    let btcTrend24h = 0;
    
    let btcTickerObj: any = null;
    // Поиск тренда BTC для определения рыночного режима по бирже WEEX
    if (weexTickers) {
      for (const [sym, t] of Object.entries<any>(weexTickers)) {
        const clean = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
        if (clean === 'BTCUSDT') {
          btcTickerObj = t;
          btcTrend24h = t.percentage || 0;
          break;
        }
      }
    }

    const btcOhlcvData = GLOBAL_TRUE_OHLCV['BTCUSDT'] || GLOBAL_TRUE_OHLCV['BTC/USDT:USDT'] || [];
    const regimeAnalysis = classifyMarketRegime(btcTickerObj, btcOhlcvData);
    const marketRegime: MarketRegime = regimeAnalysis.regime;

    // Индексация тикеров исключительно по бирже WEEX для сканирования и торговли
    const cleanToTickerMap = new Map<string, { ticker: any, sym: string, exchange: string }>();
    if (weexTickers) {
      for (const [sym, t] of Object.entries<any>(weexTickers)) {
        const clean = sym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
        if (clean) {
          cleanToTickerMap.set(clean, { ticker: t, sym, exchange: 'weex' });
        }
      }
    }

    for (const cleanSymbol of Array.from(symbolsSet)) {
      if (isTraditionalEquitySymbol(cleanSymbol)) continue;
      const tickerInfo = cleanToTickerMap.get(cleanSymbol);
      const ticker = tickerInfo?.ticker;
      const symbolWithSlash = tickerInfo?.sym || `${cleanSymbol}/USDT:USDT`;
      const exchange = tickerInfo?.exchange || 'weex';

      const rawPrice = ticker?.last || ticker?.ask || ticker?.close || 0;
      const rawIndicators = GLOBAL_TRUE_OHLCV[cleanSymbol];

      if (!ticker && !rawIndicators?.sar) continue;

      const tickerPrice = rawPrice > 0 ? rawPrice : (rawIndicators?.sar || 0);
      if (tickerPrice <= 0) continue;

      const change = typeof ticker?.percentage === 'number' ? ticker.percentage : (ticker?.change || 0);
      const high = ticker?.high || (tickerPrice > 0 ? tickerPrice * (1 + Math.max(0, change / 100)) : tickerPrice);
      const low = ticker?.low || (tickerPrice > 0 ? tickerPrice * (1 + Math.min(0, change / 100)) : tickerPrice);
      const volume = ticker?.quoteVolume || ticker?.baseVolume || (ticker?.volume ? ticker.volume * tickerPrice : 0);
      const volatility = low > 0 ? ((high - low) / low) * 100 : 0;

      const recentHigh = high;
      const dropFromRecentHigh = recentHigh > 0 ? ((recentHigh - tickerPrice) / recentHigh) * 100 : 0;
      const dropFromHigh = tickerPrice > 0 ? ((high - tickerPrice) / high) * 100 : 0;
      const riseFromLow = low > 0 ? ((tickerPrice - low) / low) * 100 : 0;

      const range24h = high - low;
      const openPrice = ticker?.open || (tickerPrice / (1 + (change / 100)));
      const calcTopWick = range24h > 0 ? Math.max(0, (high - Math.max(tickerPrice, openPrice)) / range24h) : 0.3;
      const calcBottomWick = range24h > 0 ? Math.max(0, (Math.min(tickerPrice, openPrice) - low) / range24h) : 0.3;
      const estRsi = 50 + Math.max(-45, Math.min(45, change * 3.5));

      const cachedIndicators = rawIndicators || {
        sar: tickerPrice,
        vwap: ticker?.vwap || (high + low + tickerPrice) / 3 || tickerPrice,
        rsi1h: estRsi,
        bb1h: change > 5 ? 'OVERBOUGHT' : change < -5 ? 'OVERSOLD' : 'INSIDE',
        psarStatus1m: dropFromRecentHigh > 0.8 ? 'BEARISH' : riseFromLow > 0.8 ? 'BULLISH' : (change >= 0 ? 'BULLISH' : 'BEARISH'),
        isSarBearishFlipped1m: dropFromRecentHigh >= 0.6 && change > 2,
        isSarBullishFlipped1m: riseFromLow >= 0.6 && change < -2,
        wicks: { topPct: calcTopWick, bottomPct: calcBottomWick, bodySize: Math.abs(tickerPrice - openPrice) },
        volumeSpike: volume > 100000 ? 3.5 : 1.2
      };

      const vwapInfo = cachedIndicators.vwap || tickerPrice;
      const trueRsi = cachedIndicators.rsi1h || estRsi;
      const bbStatus = cachedIndicators.bb1h || (change > 5 ? 'OVERBOUGHT' : change < -5 ? 'OVERSOLD' : 'INSIDE');
      const psarStatus1m = cachedIndicators.psarStatus1m || (dropFromRecentHigh > 0.8 ? 'BEARISH' : 'BULLISH');
      const isSarBearishFlipped1m = cachedIndicators.isSarBearishFlipped1m || (dropFromRecentHigh >= 0.6 && change > 2);
      const isSarBullishFlipped1m = cachedIndicators.isSarBullishFlipped1m || (riseFromLow >= 0.6 && change < -2);
      const isShortTermBearish = psarStatus1m === 'BEARISH' || dropFromRecentHigh >= 0.8;
      const isQuickLocalSpike = (change >= 3.0 || riseFromLow >= 3.0) && dropFromRecentHigh <= 4.0;
      const isQuickLocalDrop = (change <= -3.0 || dropFromRecentHigh >= 3.0) && riseFromLow <= 4.0;
      const hasRealOhlcv = !!(rawIndicators && (rawIndicators.sar || rawIndicators.rsi1h || rawIndicators.psarStatus1m));

      let matchedPattern = 'None';
      let signalSide: 'SHORT' | 'LONG' | 'NEUTRAL' = 'NEUTRAL';
      let scoreBonus = 0;

      const wicks = cachedIndicators.wicks || { topPct: calcTopWick, bottomPct: calcBottomWick, bodySize: 0 };
      const volumeSpike = cachedIndicators.volumeSpike || 1.0;

      if (volume > 200) {
        // --- SHORT PATTERNS ---
        // Слив монеты: требует реальных OHLCV, подтвержденного падения SAR, импульса >= 7% и фитиля отбоя
        if (hasRealOhlcv && (change >= 7.0 || riseFromLow >= 8.0) && isSarBearishFlipped1m && volumeSpike >= 1.5 && (wicks.topPct >= 0.25 || dropFromRecentHigh >= 0.8)) {
          matchedPattern = '💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)';
          signalSide = 'SHORT';
          scoreBonus = 16;
        } else if ((wicks.topPct > 0.35 || dropFromRecentHigh >= 0.8) && (change >= 3.0 || riseFromLow >= 5.0) && (tickerPrice <= vwapInfo || isShortTermBearish)) {
          matchedPattern = '🧹 False Breakout (Ложный пробой)';
          signalSide = 'SHORT';
          scoreBonus = 14;
        } else if ((change >= 7.0 || riseFromLow >= 9.0) && (wicks.topPct > 0.35 || dropFromRecentHigh >= 0.8)) {
          matchedPattern = '⚡ 1m Spire Climax (Шпиль на 1м)';
          signalSide = 'SHORT';
          scoreBonus = 17;
        } else if (((cachedIndicators.obImbalance && cachedIndicators.obImbalance > 70) || trueRsi >= 72) && (change >= 3.5 || isQuickLocalSpike)) {
          matchedPattern = '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)';
          signalSide = 'SHORT';
          scoreBonus = 18;
        } else if ((change >= 3.0 || riseFromLow >= 4.5) && dropFromRecentHigh >= 0.2 && dropFromRecentHigh <= 3.5) {
          matchedPattern = '🎯 Wick Zone Retest (Ретест фитиля)';
          signalSide = 'SHORT';
          scoreBonus = 13;
        } else if ((change >= 4.0 || volatility >= 7.0 || trueRsi >= 66 || bbStatus === 'OVERBOUGHT')) {
          matchedPattern = '🔥 Vertical Exhaustion (Разворот)';
          signalSide = 'SHORT';
          scoreBonus = 15;
        } else if (volumeSpike > 3.0 && (change > 3.5 || isQuickLocalSpike)) {
          matchedPattern = '💀 Volume Climax (Predictive Dump)';
          signalSide = 'SHORT';
          scoreBonus = 12;
        } else if ((change >= 4.5 || isQuickLocalSpike) && (trueRsi >= 68 || bbStatus === 'OVERBOUGHT' || wicks.topPct > 0.25)) {
          matchedPattern = '⚡ EXTREME OVERBOUGHT PEAK (Early Limit SHORT Entry)';
          signalSide = 'SHORT';
          scoreBonus = 16;
        }
        // --- LONG PATTERNS ---
        // Пролив монеты: требует реальных OHLCV, подтвержденного бычьего SAR, просадки <= -7% и фитиля откупа
        else if (hasRealOhlcv && (change <= -7.0 || dropFromRecentHigh >= 8.0) && isSarBullishFlipped1m && volumeSpike >= 1.5 && (wicks.bottomPct >= 0.25 || riseFromLow >= 0.8)) {
          matchedPattern = '💥 ПРОЛИВ (SAR Bottom Reversal)';
          signalSide = 'LONG';
          scoreBonus = 16;
        } else if ((wicks.bottomPct > 0.35 || riseFromLow >= 0.8) && (change <= -3.0 || dropFromRecentHigh >= 5.0) && (tickerPrice >= vwapInfo || !isShortTermBearish)) {
          matchedPattern = '🧹 Снятие ликвидности снизу (Bottom Liquidity Sweep)';
          signalSide = 'LONG';
          scoreBonus = 14;
        } else if ((change <= -7.0 || dropFromRecentHigh >= 9.0) && (wicks.bottomPct > 0.35 || riseFromLow >= 0.8)) {
          matchedPattern = '⚡ 1m Spire Climax Bottom (Шпиль снизу)';
          signalSide = 'LONG';
          scoreBonus = 17;
        } else if (((cachedIndicators.obImbalance && cachedIndicators.obImbalance < 30) || trueRsi <= 28) && (change <= -3.5 || isQuickLocalDrop)) {
          matchedPattern = '💎 ИДЕАЛЬНЫЙ ЛОНГ (Smart Liquidity Floor)';
          signalSide = 'LONG';
          scoreBonus = 18;
        } else if ((change <= -3.0 || dropFromRecentHigh >= 4.5) && riseFromLow >= 0.2 && riseFromLow <= 3.5) {
          matchedPattern = '🎯 Bottom Wick Retest (Ретест дна)';
          signalSide = 'LONG';
          scoreBonus = 13;
        } else if ((change <= -4.0 || volatility >= 7.0 || trueRsi <= 34 || bbStatus === 'OVERSOLD')) {
          matchedPattern = '🔥 Reversal from Dump (Разворот пролива)';
          signalSide = 'LONG';
          scoreBonus = 15;
        } else if (volumeSpike > 3.0 && (change < -3.5 || isQuickLocalDrop)) {
          matchedPattern = '💀 Volume Climax Bottom (Recovery)';
          signalSide = 'LONG';
          scoreBonus = 12;
        } else if ((change <= -4.5 || isQuickLocalDrop) && (trueRsi <= 32 || bbStatus === 'OVERSOLD' || wicks.bottomPct > 0.25)) {
          matchedPattern = '⚡ EXTREME OVERSOLD DIP (Early Limit LONG Entry)';
          signalSide = 'LONG';
          scoreBonus = 16;
        }
      }

      const blockLocks: string[] = [];
      const blockDetails: string[] = [];

      // 0. Проверка блэклиста паттернов
      if (matchedPattern && matchedPattern !== 'None') {
        const blCheck = isPatternBlacklisted(matchedPattern);
        if (blCheck.blacklisted) {
          blockLocks.push("Blacklist");
          blockDetails.push(`Паттерн "${matchedPattern}" в черном списке: ${blCheck.reason}`);
        }
      }

      // 1. Фильтр 1h EMA-200 (симметричный для SHORT и LONG)
      const ema200_1hVal = cachedIndicators.ema200_1h;
      if (globalSettings.isEma200FilterEnabled !== false && ema200_1hVal) {
        if (signalSide === 'SHORT' && tickerPrice > ema200_1hVal * 1.05) {
          const isConfirmedStructuralShort = wicks.topPct >= 0.40 && volumeSpike >= 2.0;
          if (!isConfirmedStructuralShort) {
            blockLocks.push("EMA200");
            blockDetails.push(`Цена выше 1h EMA-200 (${ema200_1hVal.toFixed(4)}) без подтвержденного структурного фитиля`);
          }
        } else if (signalSide === 'LONG' && tickerPrice < ema200_1hVal * 0.95) {
          const isConfirmedStructuralLong = wicks.bottomPct >= 0.40 && volumeSpike >= 2.0;
          if (!isConfirmedStructuralLong) {
            blockLocks.push("EMA200");
            blockDetails.push(`Цена ниже 1h EMA-200 (${ema200_1hVal.toFixed(4)}) без подтвержденного структурного дна`);
          }
        }
      }

      // 2. FVG фильтры (симметричные для SHORT и LONG)
      if (globalSettings.isFvgAboveFilterEnabled !== false && cachedIndicators.hasFvgAbove && signalSide === 'SHORT') {
        blockLocks.push("4hFVGAbove");
        blockDetails.push("Активна магнитная бычья зона FVG сверху");
      }
      if (globalSettings.isFvgSupportBelowFilterEnabled !== false && cachedIndicators.hasBullishFvgBelow && signalSide === 'SHORT') {
        blockLocks.push("4hFVGBelowSupport");
        blockDetails.push("Снизу находится сильная 4h FVG бычья поддержка");
      }
      if (globalSettings.isFvgSupportBelowFilterEnabled !== false && (cachedIndicators as any).hasBearishFvgBelow && signalSide === 'LONG') {
        blockLocks.push("4hFVGBelow");
        blockDetails.push("Снизу находится зона медвежьего FVG давления");
      }

      // 3. Фильтр Снятия Ликвидности (симметричный для SHORT и LONG без фиктивных обходов)
      const sweepWickThreshold = globalSettings.liquiditySweepWickThreshold ?? 0.25;
      const isActualSweepConfirmed = signalSide === 'SHORT'
        ? !!(cachedIndicators.isLiquiditySweep || cachedIndicators.isLiquiditySweep1h || cachedIndicators.isLiquiditySweep5m || wicks.topPct >= sweepWickThreshold)
        : signalSide === 'LONG'
        ? !!(cachedIndicators.isLiquiditySweepLow || cachedIndicators.isLiquiditySweepLow1h || cachedIndicators.isLiquiditySweepLow5m || wicks.bottomPct >= sweepWickThreshold)
        : false;

      const isLiquiditySweepConfirmed = globalSettings.isLiquiditySweepFilterEnabled === false || isActualSweepConfirmed;

      if (globalSettings.isLiquiditySweepFilterEnabled !== false && !isActualSweepConfirmed) {
        if (signalSide === 'SHORT') {
          blockLocks.push("Sweep/Wick");
          blockDetails.push(`Нет подтвержденного Свипа ликвидности сверху (фитиль ${(wicks.topPct * 100).toFixed(0)}% < ${(sweepWickThreshold * 100).toFixed(0)}%)`);
        } else if (signalSide === 'LONG') {
          blockLocks.push("Sweep/Wick");
          blockDetails.push(`Нет подтвержденного Свипа ликвидности снизу (фитиль ${(wicks.bottomPct * 100).toFixed(0)}% < ${(sweepWickThreshold * 100).toFixed(0)}%)`);
        }
      }

      // 4. Фильтр Опоздавшего входа (Late Entry Guard - симметричный для SHORT и LONG)
      if (globalSettings.isLateShortFilterEnabled !== false) {
        if (signalSide === 'SHORT' && (dropFromRecentHigh > 3.5 || dropFromHigh > 5.0)) {
          blockLocks.push("Late");
          blockDetails.push(`Опоздавший шорт: цена уже откатилась на -${dropFromRecentHigh.toFixed(1)}% от хая`);
        } else if (signalSide === 'LONG' && riseFromLow > 4.5) {
          blockLocks.push("Late");
          blockDetails.push(`Опоздавший лонг: цена уже ушла вверх на +${riseFromLow.toFixed(1)}% от дна`);
        }
      }

      let baseScore = signalSide !== 'NEUTRAL' ? 75 + scoreBonus : 45;
      if (blockLocks.length > 0) {
        // Умеренное взвешенное снижение, сохраняющее пригодность подтвержденных сигналов
        baseScore = Math.max(50, baseScore - blockLocks.length * 8);
      }

      const isBinanceCrossed = ctx.isBinanceCrossListed(cleanSymbol);

      // Генерация DecisionTrace для полного логирования факторов принятия решения
      const trace = DecisionTraceService.buildTrace({
        symbol: symbolWithSlash,
        side: signalSide === 'NEUTRAL' ? 'SHORT' : signalSide,
        marketRegime,
        regimeConfidence: regimeAnalysis.confidence,
        patternName: matchedPattern,
        executionMode: 'PAPER',
        indicators: {
          rsi: trueRsi,
          volumeSpike,
          topWickPct: wicks.topPct,
          bottomWickPct: wicks.bottomPct,
          vwapDistancePct: vwapInfo?.distancePct,
          sarReversal: !!(isSarBearishFlipped1m || isSarBullishFlipped1m),
          bosChoch: isActualSweepConfirmed && (wicks.topPct >= 0.35 || wicks.bottomPct >= 0.35),
          liquiditySweep: isActualSweepConfirmed
        },
        rawAgentScores: {
          scout: {
            score: baseScore,
            reason: matchedPattern ? `Обнаружен паттерн "${matchedPattern}"` : 'Сканирование структуры',
            vote: signalSide === 'SHORT' ? 'APPROVE_SHORT' : (signalSide === 'LONG' ? 'APPROVE_LONG' : 'HOLD')
          },
          bull: {
            score: signalSide === 'LONG'
              ? baseScore
              : (marketRegime === 'TREND_UP' && trueRsi < 65 && !isActualSweepConfirmed ? 75 : Math.max(50, 100 - baseScore)),
            reason: signalSide === 'LONG'
              ? `Бычий импульс с RSI ${trueRsi.toFixed(1)}`
              : (marketRegime === 'TREND_UP' && trueRsi < 65 && !isActualSweepConfirmed ? 'Сильное восходящее давление покупателей' : 'Покупательские импульсы иссякли (сопротивление покупателей отсутствует)'),
            vote: signalSide === 'LONG'
              ? 'APPROVE_LONG'
              : (marketRegime === 'TREND_UP' && trueRsi < 65 && !isActualSweepConfirmed ? 'REJECT' : 'HOLD')
          },
          bear: {
            score: signalSide === 'SHORT'
              ? baseScore
              : (marketRegime === 'TREND_DOWN' && trueRsi > 35 && !isActualSweepConfirmed ? 75 : Math.max(50, 100 - baseScore)),
            reason: signalSide === 'SHORT'
              ? `Медвежий сетап: фитиль ${(wicks.topPct * 100).toFixed(1)}%`
              : (marketRegime === 'TREND_DOWN' && trueRsi > 35 && !isActualSweepConfirmed ? 'Активное давление продавцов без признаков разворота' : 'Продажи иссякли (давление продавцов отсутствует)'),
            vote: signalSide === 'SHORT'
              ? 'APPROVE_SHORT'
              : (marketRegime === 'TREND_DOWN' && trueRsi > 35 && !isActualSweepConfirmed ? 'REJECT' : 'HOLD')
          },
          liquidity: {
            score: isActualSweepConfirmed ? 90 : 65,
            reason: isActualSweepConfirmed ? 'Снятие ликвидности подтверждено' : 'Умеренный профиль ликвидности',
            vote: signalSide === 'SHORT' ? 'APPROVE_SHORT' : (signalSide === 'LONG' ? 'APPROVE_LONG' : 'HOLD')
          },
          risk: {
            score: blockLocks.length === 0 ? 85 : Math.max(35, 75 - blockLocks.length * 15),
            reason: blockLocks.length === 0 ? 'Риск-фильтры пройдены успешно' : `Предупреждения/Блокировки: ${blockLocks.join(', ')}`,
            vote: blockLocks.length === 0 ? (signalSide === 'SHORT' ? 'APPROVE_SHORT' : (signalSide === 'LONG' ? 'APPROVE_LONG' : 'HOLD')) : 'REJECT'
          }
        },
        blockLocks,
        blockDetails,
        requiredScore: (() => {
          // Dynamic adaptive required score based on market regime and trend alignment:
          const isTrendAligned = (signalSide === 'LONG' && marketRegime === 'TREND_UP') ||
                                 (signalSide === 'SHORT' && marketRegime === 'TREND_DOWN') ||
                                 isActualSweepConfirmed;
          if (isTrendAligned) {
            return 68; // Calibrated for high-conviction trend-aligned setups
          }
          if (marketRegime === 'RANGING_FLAT' || marketRegime === 'NEUTRAL') {
            return 79; // Ужесточённый порог во флэтовом режиме для защиты от ложных пробоев
          }
          return 75; // Strict standard threshold for counter-trend or high volatility
        })()
      });

      // Определение уровня риска на основе волатильности, RSI и блокировок
      let riskLevel = 'LOW';
      if (blockLocks.length > 1 || volatility > 50) {
        riskLevel = 'CRITICAL';
      } else if (blockLocks.length === 1 || volatility > 25 || trueRsi > 80 || trueRsi < 20) {
        riskLevel = 'HIGH';
      } else if (volatility > 12 || trueRsi > 68 || trueRsi < 32) {
        riskLevel = 'MODERATE';
      }

      const cleanCoin = cleanSymbol.replace(/USDT$/, '') || cleanSymbol;
      const displayType = matchedPattern && matchedPattern !== 'None'
        ? matchedPattern
        : (signalSide === 'SHORT' ? 'Квантовый Шорт' : signalSide === 'LONG' ? 'Квантовый Лонг' : 'Флэт');

      signals.push({
        symbol: symbolWithSlash,
        rawSymbol: symbolWithSlash,
        coin: cleanCoin,
        exchange,
        price: tickerPrice,
        change24h: Number(change.toFixed(2)),
        volume,
        volatility: Number(volatility.toFixed(1)),
        signal: signalSide,
        side: signalSide === 'NEUTRAL' ? undefined : signalSide,
        isSellSignal: signalSide === 'SHORT',
        type: displayType,
        riskLevel,
        score: baseScore,
        aiScore: baseScore,
        rsi: trueRsi,
        bbStatus,
        dropProb: signalSide === 'SHORT' ? Math.min(95, Math.round(baseScore)) : 25,
        riseProb: signalSide === 'LONG' ? Math.min(95, Math.round(baseScore)) : 25,
        matchedPattern,
        patternName: matchedPattern,
        reasons: blockDetails,
        blockLocks,
        blockDetails,
        marketRegime,
        decisionTrace: trace,
        indicators: {
          rsi1h: trueRsi,
          vwap: vwapInfo,
          volatility: Number(volatility.toFixed(1)),
          topWickPct: wicks.topPct,
          bottomWickPct: wicks.bottomPct,
          volumeSpike,
          ema200_1h: ema200_1hVal,
          isLiquiditySweep: isLiquiditySweepConfirmed,
          hasBullishFvgBelow: !!cachedIndicators.hasBullishFvgBelow,
          hasFvgAbove: !!cachedIndicators.hasFvgAbove
        },
        smartLimitTarget: signalSide === 'SHORT' ? tickerPrice * 1.002 : (signalSide === 'LONG' ? tickerPrice * 0.998 : tickerPrice),
        isLiquiditySweep: isLiquiditySweepConfirmed,
        isBinanceCrossListed: isBinanceCrossed,
        timestamp: Date.now()
      });
    }

    // Сортировка сигналов: сначала активные с высоким рейтингом
    signals.sort((a, b) => {
      if (a.signal !== 'NEUTRAL' && b.signal === 'NEUTRAL') return -1;
      if (a.signal === 'NEUTRAL' && b.signal !== 'NEUTRAL') return 1;
      return (b.score || 0) - (a.score || 0);
    });

    ctx.setCachedSignals({
      data: signals,
      lastUpdated: Date.now(),
      marketRegime,
      regimeDetails: regimeAnalysis,
      marketHealth: Math.min(100, Math.max(10, 50 + (signals.filter(s => s.signal !== 'NEUTRAL').length * 4))),
      btcTrend24h
    });

    ctx.emitSignalsUpdated();

    if (ctx.isMainThread && ctx.runAutopilotAndVirtualTradeEntry) {
      ctx.runAutopilotAndVirtualTradeEntry().catch(e => console.error('[AUTOPILOT ERROR]', e));
    }
  } catch (e: any) {
    console.error('[UPDATE SIGNALS CACHE ERROR]', e?.message || e);
  }
}
