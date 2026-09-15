/**
 * Модуль расчета технического анализа и индикаторов для фьючерсной торговли:
 * - RSI (Relative Strength Index)
 * - VWAP (Volume Weighted Average Price)
 * - Parabolic SAR (Stop and Reverse)
 * - ATR (Average True Range)
 * - Bollinger Bands
 * - MACD
 */

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Расчет RSI (Relative Strength Index)
 */
export function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
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
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Расчет VWAP (Volume Weighted Average Price)
 */
export function calculateVWAP(candles: OHLCV[]): number {
  if (!candles || candles.length === 0) return 0;

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice * c.volume;
    totalVolume += c.volume;
  }

  return totalVolume > 0 ? totalPV / totalVolume : candles[candles.length - 1].close;
}

/**
 * Расчет Parabolic SAR (Stop and Reverse)
 */
export function calculateParabolicSAR(
  candles: OHLCV[],
  step = 0.02,
  maxStep = 0.2
): { sar: number; isBearish: boolean } {
  if (!candles || candles.length < 3) {
    const last = candles && candles.length > 0 ? candles[candles.length - 1].close : 0;
    return { sar: last, isBearish: false };
  }

  let isLong = candles[1].close > candles[0].close;
  let af = step;
  let ep = isLong ? candles[0].high : candles[0].low;
  let sar = isLong ? candles[0].low : candles[0].high;

  for (let i = 1; i < candles.length; i++) {
    const prevSar = sar;

    if (isLong) {
      sar = prevSar + af * (ep - prevSar);
      sar = Math.min(sar, candles[i - 1].low, i > 1 ? candles[i - 2].low : candles[i - 1].low);

      if (candles[i].low < sar) {
        isLong = false;
        sar = ep;
        af = step;
        ep = candles[i].low;
      } else {
        if (candles[i].high > ep) {
          ep = candles[i].high;
          af = Math.min(af + step, maxStep);
        }
      }
    } else {
      sar = prevSar + af * (ep - prevSar);
      sar = Math.max(sar, candles[i - 1].high, i > 1 ? candles[i - 2].high : candles[i - 1].high);

      if (candles[i].high > sar) {
        isLong = true;
        sar = ep;
        af = step;
        ep = candles[i].high;
      } else {
        if (candles[i].low < ep) {
          ep = candles[i].low;
          af = Math.min(af + step, maxStep);
        }
      }
    }
  }

  const lastPrice = candles[candles.length - 1].close;
  return {
    sar,
    isBearish: sar > lastPrice
  };
}

/**
 * Расчет ATR (Average True Range)
 */
export function calculateATR(candles: OHLCV[], period = 14): number {
  if (!candles || candles.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose)
    );
    trs.push(tr);
  }

  if (trs.length < period) return 0;

  let atr = trs.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}
