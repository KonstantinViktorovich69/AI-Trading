import type { SignalData, TradingMode } from '../types/trading.ts';

export interface PatternAnalysisResult {
  patternName: string;
  isShortSetup?: boolean;
  isSpotBuySetup?: boolean;
  signalType: 'SHORT' | 'LONG' | 'NEUTRAL';
  scoreBonus: number;
  reason: string;
  spotDcaLadder?: Array<{
    step: number;
    price: number;
    percentDip: number;
    allocationPct: number;
    label: string;
  }>;
}

// Реестр тикеров Binance для исключения пересечений
let binanceSymbolsSet = new Set<string>();

export function setBinanceSymbols(symbols: string[]): void {
  binanceSymbolsSet = new Set(symbols.map(s => s.toUpperCase().replace(/[\/:]/g, '')));
}

export function isBinanceCrossListed(symbol: string): boolean {
  const clean = symbol.toUpperCase().replace(/[\/:]/g, '');
  return binanceSymbolsSet.has(clean) || binanceSymbolsSet.has(clean + 'USDT');
}

/**
 * Фильтрация монет для защиты от маркет-мейкеров Binance
 */
export function filterBinanceMarketMakerPairs(
  signals: SignalData[],
  excludeBinance: boolean = true
): SignalData[] {
  if (!excludeBinance) return signals;

  return signals.filter(s => {
    const isBinanceCrossed = isBinanceCrossListed(s.symbol);
    s.isBinanceCrossListed = isBinanceCrossed;
    // Если флаг включен, убираем монеты, которые торгуются на Binance
    return !isBinanceCrossed;
  });
}

/**
 * Анализ 1m/15m свечей на наличие паттернов фьючерсного шорт-скальпинга:
 * 1. SAR Peak Reversal
 * 2. Liquidity Sweep (длинный фитиль сверху)
 * 3. Parabolic Exhaustion (параболический выстрел с затуханием)
 */
export function analyzeShortScalpPatterns(
  price: number,
  high: number,
  low: number,
  open: number,
  vwap: number,
  sar: number,
  change24h: number,
  volume24h: number,
  avgVolume: number,
  rsi?: number
): PatternAnalysisResult {
  const candleRange = high - low;
  const upperWick = high - Math.max(open, price);
  const wickRatio = candleRange > 0 ? upperWick / candleRange : 0;
  
  const isSarBearish = sar > price;
  const isBelowVwap = price <= vwap;
  const isVolumeSpike = avgVolume > 0 && volume24h > avgVolume * 2.0;
  const currentRsi = rsi ?? 50;

  // 1. Паттерн "Слив" (SAR Peak Reversal после движения >= 7%)
  if (change24h >= 7 && isSarBearish && wickRatio >= 0.40) {
    return {
      patternName: 'SAR Peak Reversal (Слив)',
      isShortSetup: true,
      signalType: 'SHORT',
      scoreBonus: 35,
      reason: `Рост 24ч +${change24h.toFixed(1)}%, медвежий SAR, верхний фитиль ${(wickRatio * 100).toFixed(0)}%`
    };
  }

  // 2. Паттерн "Снятие ликвидности" (Liquidity Sweep сверху)
  if (wickRatio >= 0.50 && isBelowVwap && isSarBearish) {
    return {
      patternName: 'Liquidity Sweep (Снятие ликвидности)',
      isShortSetup: true,
      signalType: 'SHORT',
      scoreBonus: 40,
      reason: `Отказ от хая (фитиль ${(wickRatio * 100).toFixed(0)}%), уход ниже VWAP ($${vwap.toFixed(4)}) и медвежий SAR`
    };
  }

  // 3. Вертикальное истощение / Кульминация пампа (Pump Exhaustion)
  if ((change24h >= 10 || currentRsi >= 75) && isVolumeSpike && isSarBearish) {
    return {
      patternName: 'Parabolic Exhaustion (Кульминация пампа)',
      isShortSetup: true,
      signalType: 'SHORT',
      scoreBonus: 35,
      reason: `Экспоненциальный выстрел (+${change24h.toFixed(1)}%), RSI ${currentRsi.toFixed(0)} с аномальным объемом и медвежьим SAR`
    };
  }

  // 4. Сопротивление VWAP + Медвежий тренд (симметричный аналог Support Bounce)
  if (isBelowVwap && isSarBearish && wickRatio >= 0.30 && change24h >= -15.0 && change24h <= 4.0) {
    return {
      patternName: 'Resistance Rejection Below VWAP (Отбой от сопротивления)',
      isShortSetup: true,
      signalType: 'SHORT',
      scoreBonus: 30,
      reason: `Удержание ниже VWAP ($${vwap.toFixed(4)}) с медвежьим SAR и подтверждением отбоя`
    };
  }

  return {
    patternName: 'NEUTRAL',
    isShortSetup: false,
    signalType: 'NEUTRAL',
    scoreBonus: 0,
    reason: 'Паттерны шорт-скальпинга не обнаружены'
  };
}

/**
 * Анализ 1m/15m свечей на наличие паттернов фьючерсного лонг-скальпинга (по правилам базы знаний):
 * 1. SAR Bottom Reversal (Отскок со дна после пролива с подтверждением SAR)
 * 2. Liquidity Sweep Low (Снятие ликвидности снизу / отказ от продолжения падения / пинбар)
 * 3. Parabolic Exhaustion Dump (Кульминация продаж с объемом и разворотом)
 * 4. Floor Support Rebound (Отскок от подтвержденной плиты поддержки)
 */
export function analyzeLongScalpPatterns(
  price: number,
  high: number,
  low: number,
  open: number,
  vwap: number,
  sar: number,
  change24h: number,
  volume24h: number,
  avgVolume: number,
  rsi?: number
): PatternAnalysisResult {
  const candleRange = high - low;
  const lowerWick = Math.min(open, price) - low;
  const wickRatio = candleRange > 0 ? lowerWick / candleRange : 0;
  
  const isSarBullish = sar < price;
  const isAboveVwap = price >= vwap;
  const isVolumeSpike = avgVolume > 0 && volume24h > avgVolume * 2.0;
  const currentRsi = rsi ?? 50;

  // 1. Паттерн "Отскок со дна" (SAR Bottom Reversal после глубокого пролива <= -7%)
  if (change24h <= -7 && isSarBullish && wickRatio >= 0.40) {
    return {
      patternName: 'SAR Bottom Reversal (Отскок со дна)',
      signalType: 'LONG',
      scoreBonus: 35,
      reason: `Просадка 24ч ${change24h.toFixed(1)}%, бычий SAR, нижний фитиль откупа ${(wickRatio * 100).toFixed(0)}%`
    };
  }

  // 2. Паттерн "Снятие ликвидности снизу" (Bottom Liquidity Sweep)
  if (wickRatio >= 0.50 && isAboveVwap && isSarBullish) {
    return {
      patternName: 'Liquidity Sweep Low (Снятие ликвидности снизу)',
      signalType: 'LONG',
      scoreBonus: 40,
      reason: `Отказ от лоя (фитиль ${(wickRatio * 100).toFixed(0)}%), возврат выше VWAP ($${vwap.toFixed(4)}) и бычий SAR`
    };
  }

  // 3. Кульминация сброса (Dump Exhaustion / Oversold Spike)
  if ((change24h <= -10 || currentRsi <= 25) && isVolumeSpike && isSarBullish) {
    return {
      patternName: 'Dump Exhaustion (Кульминация сброса)',
      signalType: 'LONG',
      scoreBonus: 35,
      reason: `Экстремальный пролив (${change24h.toFixed(1)}%), RSI ${currentRsi.toFixed(0)} с аномальным объемом и бычьим SAR`
    };
  }

  // 4. Поддержка VWAP + Бычий тренд
  if (isAboveVwap && isSarBullish && wickRatio >= 0.30 && change24h >= -4.0 && change24h <= 15) {
    return {
      patternName: 'Support Bounce Above VWAP (Отскок от поддержки)',
      signalType: 'LONG',
      scoreBonus: 30,
      reason: `Удержание выше VWAP ($${vwap.toFixed(4)}) с бычьим SAR и подтверждением откупа`
    };
  }

  return {
    patternName: 'NEUTRAL',
    signalType: 'NEUTRAL',
    scoreBonus: 0,
    reason: 'Паттерны лонг-скальпинга не обнаружены'
  };
}

/**
 * Продвинутая стратегия для Спотовой торговли (Spot Strategy):
 * 1. Spot Accumulation & Consolidation Breakout (Накопление / Пробой консолидации выше VWAP)
 * 2. Spot Oversold Dip Recovery (Откуп просадки / Нижний тень-откуп при сильном падении)
 * 3. Spot Momentum Trend Following (Бычий импульс с растущим объемом)
 */
export function analyzeSpotAccumulationPatterns(
  price: number,
  high: number,
  low: number,
  open: number,
  vwap: number,
  sar: number,
  rsi: number,
  change24h: number,
  volume24h: number,
  avgVolume: number
): PatternAnalysisResult {
  const candleRange = high - low;
  const lowerWick = Math.min(open, price) - low;
  const lowerWickRatio = candleRange > 0 ? lowerWick / candleRange : 0;

  const isSarBullish = sar < price;
  const isAboveVwap = price >= vwap;
  const isVolumeSpike = avgVolume > 0 && volume24h > avgVolume * 2.0;

  // Helper to construct Spot DCA Buy Ladder (3 tiers: Market Entry 30%, -3.5% Dip 35%, -7.5% Deep Support 35%)
  const makeSpotLadder = (p: number) => [
    { step: 1, price: Number(p.toFixed(5)), percentDip: 0, allocationPct: 30, label: 'Базовый Спот Влив (30%)' },
    { step: 2, price: Number((p * 0.965).toFixed(5)), percentDip: -3.5, allocationPct: 35, label: 'DCA Накопление -3.5% (35%)' },
    { step: 3, price: Number((p * 0.925).toFixed(5)), percentDip: -7.5, allocationPct: 35, label: 'Глубокое DCA Накопление -7.5% (35%)' }
  ];

  // 1. Откуп дипа / Перепроданность (Spot Oversold Dip Recovery)
  if ((change24h <= -2.5 || lowerWickRatio >= 0.35) && rsi <= 45) {
    return {
      patternName: 'Spot Oversold Dip Recovery (Откуп дна)',
      isSpotBuySetup: true,
      signalType: 'LONG',
      scoreBonus: 40,
      reason: `Просадка 24ч ${change24h.toFixed(1)}%, RSI ${rsi.toFixed(0)}, откуп снизу ${(lowerWickRatio * 100).toFixed(0)}%`,
      spotDcaLadder: makeSpotLadder(price)
    };
  }

  // 2. Пробой консолидации выше VWAP (Spot Consolidation Breakout)
  if (isAboveVwap && (isSarBullish || rsi >= 45) && (avgVolume === 0 || volume24h >= avgVolume * 1.1) && rsi <= 72) {
    return {
      patternName: 'Spot Accumulation & Breakout (Пробой консолидации)',
      isSpotBuySetup: true,
      signalType: 'LONG',
      scoreBonus: 35,
      reason: `Закрепление выше VWAP ($${vwap.toFixed(4)}), бычий SAR/RSI (${rsi.toFixed(0)}), поджатие объемов`,
      spotDcaLadder: makeSpotLadder(price)
    };
  }

  // 3. Трендовый импульс Спота (Spot Momentum Trend)
  if (change24h >= 1.5 && change24h <= 25 && isAboveVwap && isSarBullish && rsi >= 48) {
    return {
      patternName: 'Spot Momentum Trend (Трендовое накопление)',
      isSpotBuySetup: true,
      signalType: 'LONG',
      scoreBonus: 30,
      reason: `Рост 24ч +${change24h.toFixed(1)}%, бычий SAR и VWAP поддержка`,
      spotDcaLadder: makeSpotLadder(price)
    };
  }

  // 4. Пинбар-Откуп или Локальное Дно (Spot Bottom Reversal)
  if (lowerWickRatio >= 0.40 || rsi <= 35) {
    return {
      patternName: 'Spot Bottom Reversal (Разворот дна)',
      isSpotBuySetup: true,
      signalType: 'LONG',
      scoreBonus: 35,
      reason: `Длинный фитиль откупа снизу (${(lowerWickRatio * 100).toFixed(0)}%) / перепроданный RSI ${rsi.toFixed(0)}`,
      spotDcaLadder: makeSpotLadder(price)
    };
  }

  return {
    patternName: 'NEUTRAL',
    isSpotBuySetup: false,
    signalType: 'NEUTRAL',
    scoreBonus: 0,
    reason: 'Паттерны спотового накопления не обнаружены'
  };
}

/**
 * Реестр заблокированных паттернов с низким винрейтом (<35%)
 */
interface BlacklistedPatternInfo {
  until: number;
  reason: string;
  winRate: number;
}

let blacklistedPatternsMap: Record<string, BlacklistedPatternInfo> = {};

export function updatePatternBlacklistFromStats(
  closedTrades: Array<{ type?: string; pattern?: string; pnl?: number; outcome?: string }>
): void {
  const now = Date.now();
  for (const pat of Object.keys(blacklistedPatternsMap)) {
    if (blacklistedPatternsMap[pat].until < now) {
      delete blacklistedPatternsMap[pat];
      console.log(`[PATTERN ENGINE] Снята блокировка с паттерна "${pat}".`);
    }
  }

  const patternStats: Record<string, { wins: number; total: number }> = {};
  const recent = closedTrades.slice(-40);
  
  for (const t of recent) {
    const pName = t.type || t.pattern || 'GENERAL';
    if (!patternStats[pName]) patternStats[pName] = { wins: 0, total: 0 };
    patternStats[pName].total += 1;
    if ((t.pnl !== undefined && t.pnl > 0) || t.outcome === 'WIN') {
      patternStats[pName].wins += 1;
    }
  }

  for (const [pName, stats] of Object.entries(patternStats)) {
    if (stats.total >= 4) {
      const winRate = (stats.wins / stats.total) * 100;
      if (winRate < 35) {
        blacklistedPatternsMap[pName] = {
          until: now + 12 * 3600 * 1000,
          reason: `Винрейт ${winRate.toFixed(1)}% < 35% за последние ${stats.total} сделок`,
          winRate: Number(winRate.toFixed(1))
        };
        console.warn(`[PATTERN ENGINE] ⚠️ Паттерн "${pName}" временно заблокирован из-за низкого винрейта (${winRate.toFixed(1)}%)`);
      }
    }
  }
}

export function isPatternBlacklisted(patternName: string): { blacklisted: boolean; reason?: string } {
  const entry = blacklistedPatternsMap[patternName];
  if (entry && entry.until > Date.now()) {
    return { blacklisted: true, reason: entry.reason };
  }
  return { blacklisted: false };
}

export function getBlacklistedPatterns(): Record<string, BlacklistedPatternInfo> {
  return { ...blacklistedPatternsMap };
}

/**
 * Единый маршрутизатор сигналов в зависимости от marketType и режимов (FUTURES / SPOT / COMBINED)
 */
export function evaluateSignalByMarketType(
  marketType: 'FUTURES' | 'SPOT',
  tradingMode: TradingMode,
  price: number,
  high: number,
  low: number,
  open: number,
  vwap: number,
  sar: number,
  rsi: number,
  change24h: number,
  volume24h: number,
  avgVolume: number
): PatternAnalysisResult {
  // Проверка соответствия режиму
  if (tradingMode === 'FUTURES' && marketType !== 'FUTURES') {
    return { patternName: 'NEUTRAL', signalType: 'NEUTRAL', scoreBonus: 0, reason: 'Пропущено: Включен режим только Фьючерсы' };
  }
  if (tradingMode === 'SPOT' && marketType !== 'SPOT') {
    return { patternName: 'NEUTRAL', signalType: 'NEUTRAL', scoreBonus: 0, reason: 'Пропущено: Включен режим только Спот' };
  }

  let result: PatternAnalysisResult;
  if (marketType === 'SPOT') {
    result = analyzeSpotAccumulationPatterns(price, high, low, open, vwap, sar, rsi, change24h, volume24h, avgVolume);
  } else {
    result = analyzeShortScalpPatterns(price, high, low, open, vwap, sar, change24h, volume24h, avgVolume);
  }

  if (result.patternName && result.patternName !== 'NEUTRAL') {
    const check = isPatternBlacklisted(result.patternName);
    if (check.blacklisted) {
      return {
        patternName: 'NEUTRAL',
        signalType: 'NEUTRAL',
        scoreBonus: 0,
        reason: `Пропущено [ПАТТЕРН В ЧЕРНОМ СПИСКЕ]: ${result.patternName} (${check.reason})`
      };
    }
  }

  return result;
}


/**
 * Фильтрация сигналов по правилам риск-менеджмента (volume < $50,000, просадки и т.д.)
 */
export function filterValidSignals(
  signals: SignalData[],
  minVolumeUsdt: number = 50000,
  excludeBinance: boolean = true
): SignalData[] {
  const step1 = filterBinanceMarketMakerPairs(signals, excludeBinance);

  return step1.filter(s => {
    if (s.volume24h && s.volume24h < minVolumeUsdt && Math.abs(s.change24h || 0) < 15) {
      return false;
    }
    return true;
  });
}
