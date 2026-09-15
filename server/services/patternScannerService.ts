export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorSummary {
  rsi: number;
  trueRsi: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbStatus: 'OVERBOUGHT' | 'OVERSOLD' | 'NORMAL';
  bbBandwidth: number;
  sar: number;
  sarDirection: 'BULLISH' | 'BEARISH';
  kdj: { k: number; d: number; j: number };
  vwap?: number;
}

export interface PatternDetectionResult {
  patternName: string;
  side: 'SHORT' | 'LONG';
  confidence: number;
  dropProb: number;
  reasons: string[];
  smartLimitTarget: number;
  idealEntryMin: number;
  idealEntryMax: number;
  recentHigh: number;
  recentLow: number;
  isLiquiditySweep: boolean;
  isStructureBroken: boolean;
}

/**
 * Calculates Wilder's RSI from candle closes.
 */
export function calculateRSI(closes: number[], period = 14): number {
  if (!closes || closes.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - (100 / (1 + rs))).toFixed(2));
}

/**
 * Calculates Bollinger Bands (Upper, Middle, Lower, Bandwidth).
 */
export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number; middle: number; lower: number; bandwidth: number; status: 'OVERBOUGHT' | 'OVERSOLD' | 'NORMAL' } {
  if (!closes || closes.length < period) {
    const last = closes && closes.length > 0 ? closes[closes.length - 1] : 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0, status: 'NORMAL' };
  }

  const slice = closes.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  const middle = sum / period;

  const variance = slice.reduce((acc, val) => acc + Math.pow(val - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;

  const currentPrice = closes[closes.length - 1];
  let status: 'OVERBOUGHT' | 'OVERSOLD' | 'NORMAL' = 'NORMAL';
  if (currentPrice >= upper) {
    status = 'OVERBOUGHT';
  } else if (currentPrice <= lower) {
    status = 'OVERSOLD';
  }

  return {
    upper: Number(upper.toFixed(5)),
    middle: Number(middle.toFixed(5)),
    lower: Number(lower.toFixed(5)),
    bandwidth: Number(bandwidth.toFixed(2)),
    status
  };
}

/**
 * Calculates Parabolic SAR.
 */
export function calculateParabolicSAR(
  candles: Candle[],
  step = 0.02,
  maxStep = 0.2
): { sar: number; direction: 'BULLISH' | 'BEARISH'; flipped: boolean } {
  if (!candles || candles.length < 2) {
    const lastPrice = candles && candles.length > 0 ? candles[0].close : 0;
    return { sar: lastPrice, direction: 'BULLISH', flipped: false };
  }

  let isBull = candles[1].close >= candles[0].close;
  let sar = isBull ? candles[0].low : candles[0].high;
  let ep = isBull ? candles[0].high : candles[0].low;
  let af = step;
  let flipped = false;

  for (let i = 1; i < candles.length; i++) {
    const prevSar = sar;
    sar = prevSar + af * (ep - prevSar);

    if (isBull) {
      if (i >= 2) sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      else sar = Math.min(sar, candles[i - 1].low);

      if (candles[i].low < sar) {
        isBull = false;
        sar = ep;
        ep = candles[i].low;
        af = step;
        if (i === candles.length - 1) flipped = true;
      } else {
        if (candles[i].high > ep) {
          ep = candles[i].high;
          af = Math.min(af + step, maxStep);
        }
      }
    } else {
      if (i >= 2) sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      else sar = Math.max(sar, candles[i - 1].high);

      if (candles[i].high > sar) {
        isBull = true;
        sar = ep;
        ep = candles[i].high;
        af = step;
        if (i === candles.length - 1) flipped = true;
      } else {
        if (candles[i].low < ep) {
          ep = candles[i].low;
          af = Math.min(af + step, maxStep);
        }
      }
    }
  }

  return {
    sar: Number(sar.toFixed(5)),
    direction: isBull ? 'BULLISH' : 'BEARISH',
    flipped
  };
}

/**
 * Calculates KDJ Oscillator values (K, D, J).
 */
export function calculateKDJ(
  candles: Candle[],
  period = 9,
  smoothK = 3,
  smoothD = 3
): { k: number; d: number; j: number } {
  if (!candles || candles.length < period) {
    return { k: 50, d: 50, j: 50 };
  }

  let k = 50;
  let d = 50;

  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map(c => c.high));
    const lowest = Math.min(...window.map(c => c.low));
    const close = candles[i].close;

    const rsv = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }

  const j = 3 * k - 2 * d;
  return {
    k: Number(k.toFixed(2)),
    d: Number(d.toFixed(2)),
    j: Number(j.toFixed(2))
  };
}

/**
 * Calculates intraday VWAP.
 */
export function calculateVWAP(candles: Candle[]): number {
  if (!candles || candles.length === 0) return 0;

  let cumulativeTypicalVolume = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    cumulativeTypicalVolume += typicalPrice * vol;
    cumulativeVolume += vol;
  }

  if (cumulativeVolume === 0) return candles[candles.length - 1].close;
  return Number((cumulativeTypicalVolume / cumulativeVolume).toFixed(5));
}

/**
 * Multi-pattern quantum scalping detector for SHORT and LONG.
 */
export function detectTradingPatterns(candles: Candle[]): PatternDetectionResult | null {
  if (!candles || candles.length < 15) return null;

  const current = candles[candles.length - 1];
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, 14);
  const bb = calculateBollingerBands(closes, 20, 2);
  const sarResult = calculateParabolicSAR(candles);
  const vwap = calculateVWAP(candles);

  const highest24 = Math.max(...candles.map(c => c.high));
  const lowest24 = Math.min(...candles.map(c => c.low));

  const totalRange = current.high - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;

  // 1. Spire Climax / False Breakout Pinbar (SHORT)
  if (totalRange > 0 && upperWick / totalRange >= 0.5 && (current.high >= highest24 * 0.995 || rsi > 70)) {
    const idealMin = current.close * 0.995;
    const idealMax = current.high;
    const smartLimit = Number(((idealMin + idealMax) / 2).toFixed(5));

    return {
      patternName: 'Шпиль на 1м / Ложный пробой (SHORT)',
      side: 'SHORT',
      confidence: 88,
      dropProb: 85,
      reasons: [
        `Длинная верхняя тень (${Math.round((upperWick / totalRange) * 100)}% диапазона)`,
        `RSI перегрет: ${rsi}`,
        `Снятие ликвидности у максимума $${highest24.toFixed(4)}`
      ],
      smartLimitTarget: smartLimit,
      idealEntryMin: Number(idealMin.toFixed(5)),
      idealEntryMax: Number(idealMax.toFixed(5)),
      recentHigh: highest24,
      recentLow: lowest24,
      isLiquiditySweep: true,
      isStructureBroken: current.close < vwap
    };
  }

  // 2. Spire Bottom / False Breakdown Pinbar (LONG)
  if (totalRange > 0 && lowerWick / totalRange >= 0.5 && (current.low <= lowest24 * 1.005 || rsi < 30)) {
    const idealMin = current.low;
    const idealMax = current.close * 1.005;
    const smartLimit = Number(((idealMin + idealMax) / 2).toFixed(5));

    return {
      patternName: 'Отскок от дна / Пинбар поддержки (LONG)',
      side: 'LONG',
      confidence: 86,
      dropProb: 15,
      reasons: [
        `Длинная нижняя тень (${Math.round((lowerWick / totalRange) * 100)}% диапазона)`,
        `RSI перепродан: ${rsi}`,
        `Захват ликвидности на минимуме $${lowest24.toFixed(4)}`
      ],
      smartLimitTarget: smartLimit,
      idealEntryMin: Number(idealMin.toFixed(5)),
      idealEntryMax: Number(idealMax.toFixed(5)),
      recentHigh: highest24,
      recentLow: lowest24,
      isLiquiditySweep: true,
      isStructureBroken: current.close > vwap
    };
  }

  // 3. Parabolic Exhaustion / SAR Flip (SHORT)
  if (sarResult.direction === 'BEARISH' && sarResult.flipped && (bb.status === 'OVERBOUGHT' || rsi > 68)) {
    const idealMin = current.close * 0.998;
    const idealMax = current.high;
    const smartLimit = Number(((idealMin + idealMax) / 2).toFixed(5));

    return {
      patternName: 'SAR Peak Reversal / Параболический разворот (SHORT)',
      side: 'SHORT',
      confidence: 82,
      dropProb: 78,
      reasons: [
        `Смена Parabolic SAR на медвежий сверху свечи`,
        `Пробой верхней полосы Боллинджера (${bb.upper})`,
        `RSI: ${rsi}`
      ],
      smartLimitTarget: smartLimit,
      idealEntryMin: Number(idealMin.toFixed(5)),
      idealEntryMax: Number(idealMax.toFixed(5)),
      recentHigh: highest24,
      recentLow: lowest24,
      isLiquiditySweep: true,
      isStructureBroken: true
    };
  }

  // 4. Parabolic Bottom Dump Exhaustion / SAR Flip (LONG)
  if (sarResult.direction === 'BULLISH' && sarResult.flipped && (bb.status === 'OVERSOLD' || rsi < 32)) {
    const idealMin = current.low;
    const idealMax = current.close * 1.002;
    const smartLimit = Number(((idealMin + idealMax) / 2).toFixed(5));

    return {
      patternName: 'SAR Bottom Reversal / Отскок пролива (LONG)',
      side: 'LONG',
      confidence: 81,
      dropProb: 20,
      reasons: [
        `Смена Parabolic SAR на бычий снизу свечи`,
        `Пробой нижней полосы Боллинджера (${bb.lower})`,
        `RSI: ${rsi}`
      ],
      smartLimitTarget: smartLimit,
      idealEntryMin: Number(idealMin.toFixed(5)),
      idealEntryMax: Number(idealMax.toFixed(5)),
      recentHigh: highest24,
      recentLow: lowest24,
      isLiquiditySweep: true,
      isStructureBroken: true
    };
  }

  return null;
}
