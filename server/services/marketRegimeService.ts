import type { MarketRegime, DecisionFactor, AgentVoteTrace, DecisionTrace } from '../types/trading.ts';

export interface MarketRegimeClassification {
  regime: MarketRegime;
  confidence: number;
  btcTrend24h: number;
  btcVolatility1h: number;
  avgAltCorrelation: number;
  volumeProfile: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  recommendedLongWeight: number;
  recommendedShortWeight: number;
  description: string;
}

/**
 * Классификатор рыночных режимов (Market Regime Classifier)
 * Определяет текущий глобальный/локальный режим рынка на основе поведения BTC и стаканов
 */
export function classifyMarketRegime(
  btcTicker: any,
  btcOhlcv?: any[],
  altMetrics?: { avgChange24h?: number; volSpikeRatio?: number }
): MarketRegimeClassification {
  const btcChange = btcTicker?.percentage !== undefined ? Number(btcTicker.percentage) : 0;
  const btcVol24h = btcTicker?.quoteVolume || btcTicker?.baseVolume || 0;

  // Оценка внутридневной волатильности по OHLCV свечам
  let btcVolatility1h = 1.2;
  if (Array.isArray(btcOhlcv) && btcOhlcv.length >= 5) {
    const recent = btcOhlcv.slice(-10);
    const ranges = recent.map((c: any) => {
      const high = c[2] || c.high || 0;
      const low = c[3] || c.low || 0;
      const close = c[4] || c.close || 1;
      return close > 0 ? ((high - low) / close) * 100 : 0;
    });
    btcVolatility1h = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  }

  // Определение режима рынка
  let regime: MarketRegime = 'NEUTRAL';
  let confidence = 0.85;
  let recommendedLongWeight = 1.0;
  let recommendedShortWeight = 1.0;
  let description = 'Нейтральный баланс рынка';

  if (btcVolatility1h > 4.0) {
    regime = 'HIGH_VOLATILITY';
    confidence = 0.90;
    recommendedLongWeight = 0.7;
    recommendedShortWeight = 0.7;
    description = 'Рынок в состоянии экстремальной волатильности / сквизов. Рекомендуется сниженный риск.';
  } else if (btcVolatility1h < 0.4 && Math.abs(btcChange) < 1.0) {
    regime = 'EXTREME_SQUEEZE';
    confidence = 0.80;
    recommendedLongWeight = 0.8;
    recommendedShortWeight = 0.8;
    description = 'Экстремальное сжатие волатильности (Bollinger Squeeze). Высокая вероятность резкого импульса.';
  } else if (btcChange >= 2.5) {
    regime = 'TREND_UP';
    confidence = Math.min(0.95, 0.75 + (btcChange / 20));
    recommendedLongWeight = 1.3;
    recommendedShortWeight = 0.7;
    description = `Бычий направленный тренд (BTC +${btcChange.toFixed(2)}%). Преимущество у лонг-паттернов.`;
  } else if (btcChange <= -2.5) {
    regime = 'TREND_DOWN';
    confidence = Math.min(0.95, 0.75 + (Math.abs(btcChange) / 20));
    recommendedLongWeight = 0.6;
    recommendedShortWeight = 1.4;
    description = `Медвежий направленный тренд (BTC ${btcChange.toFixed(2)}%). Преимущество у шорт-паттернов и фейдинга пампов.`;
  } else {
    regime = 'RANGING_FLAT';
    confidence = 0.82;
    recommendedLongWeight = 1.0;
    recommendedShortWeight = 1.0;
    description = 'Боковой диапазон (флэт). Равнозначная эффективность разворотных стратегий от границ диапазона.';
  }

  return {
    regime,
    confidence,
    btcTrend24h: btcChange,
    btcVolatility1h,
    avgAltCorrelation: 0.75,
    volumeProfile: btcChange > 0 ? 'ACCUMULATION' : (btcChange < 0 ? 'DISTRIBUTION' : 'NEUTRAL'),
    recommendedLongWeight,
    recommendedShortWeight,
    description
  };
}

/**
 * Проверка совместимости торгового направления с текущим режимом рынка
 */
export function isSideAllowedInRegime(side: 'LONG' | 'SHORT', regime: MarketRegime): { allowed: boolean; reason?: string } {
  if (regime === 'HIGH_VOLATILITY') {
    return { allowed: true, reason: 'Волатильный режим: разрешены быстрые скальп-входы с жестким контролем стопа' };
  }
  if (regime === 'TREND_DOWN' && side === 'LONG') {
    return { allowed: true, reason: 'Контртрендовый лонг на падающем рынке: требует повышенного порога подтверждения (BOS/ChoCh + FVG)' };
  }
  if (regime === 'TREND_UP' && side === 'SHORT') {
    return { allowed: true, reason: 'Контртрендовый шорт на растущем рынке: требует подтвержденного снятия ликвидности (Spire Climax)' };
  }
  return { allowed: true };
}
