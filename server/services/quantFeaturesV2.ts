import { cleanSymbol, normalizeSymbol, findTickerInMap } from '../utils/symbolUtils.ts';

export interface ComputeQuantFeaturesV2Params {
  symbol: string;
  price: number;
  volume: number;
  trueOhlcv?: Record<string, any>;
  tickers?: Record<string, any>;
  orderBookImbalance?: Record<string, any>;
}

export interface ComputeQuantFeaturesV2Result {
  features: number[];
  hadIndicators: boolean;
  keyUsed?: string;
  ageSec?: number;
}

/**
 * Computes 11 quant features for Quant Model v2 using clean input data.
 * Pure function: takes direct arguments rather than global contexts.
 *
 * Fixes compared to v1 calculateConfidenceProbability:
 * 1. Indicator lookup checks candidate keys [symbol, cleanSymbol(symbol), normalizeSymbol(symbol)] in trueOhlcv.
 * 2. x6 (hourly volume spike) is calculated using WEEX ticker via findTickerInMap with quoteVolume/24.
 * 3. orderBookImbalance is looked up across candidate keys.
 * 4. If no indicators found, hadIndicators = false and all 11 features are set to 0.
 */
export function computeQuantFeaturesV2(params: ComputeQuantFeaturesV2Params): ComputeQuantFeaturesV2Result {
  const { symbol, price, volume, trueOhlcv, tickers, orderBookImbalance } = params;

  if (!symbol) {
    return { features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hadIndicators: false };
  }

  // 1. Resolve indicators from trueOhlcv using candidate keys
  const candidateKeys = [
    symbol,
    cleanSymbol(symbol),
    normalizeSymbol(symbol)
  ];

  let indicators: any = null;
  let keyUsed: string | undefined = undefined;

  if (trueOhlcv) {
    for (const key of candidateKeys) {
      if (key && trueOhlcv[key]) {
        indicators = trueOhlcv[key];
        keyUsed = key;
        break;
      }
    }
  }

  // If no indicators found, return all zeros with hadIndicators: false
  if (!indicators) {
    return {
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hadIndicators: false
    };
  }

  // Indicator age if timestamp exists
  let ageSec: number | undefined = undefined;
  if (typeof indicators.timestamp === 'number' && indicators.timestamp > 0) {
    ageSec = Math.max(0, Math.round((Date.now() - indicators.timestamp) / 1000));
  } else if (typeof indicators.lastUpdated === 'number' && indicators.lastUpdated > 0) {
    ageSec = Math.max(0, Math.round((Date.now() - indicators.lastUpdated) / 1000));
  }

  const currentPrice = price > 0 ? price : (indicators.close || indicators.price || 1);

  // x1: 48h breakout
  const x1 = indicators.is48hBreakout || 0;

  // x2: 1h RSI centered at 0: (rsi - 50)
  const x2 = (indicators.rsi1h !== undefined ? indicators.rsi1h : (indicators.rsi !== undefined ? indicators.rsi : 50)) - 50;

  // x3: MACD histogram relative to price (%)
  const x3 = ((indicators.macdHistogram || 0) / (currentPrice || 1)) * 100;

  // x4: Distance from EMA50 (%)
  const x4 = indicators.ema50 ? ((currentPrice - indicators.ema50) / indicators.ema50) * 100 : 0;

  // x5: Distance from EMA200 (%)
  const x5 = indicators.ema200 ? ((currentPrice - indicators.ema200) / indicators.ema200) * 100 : 0;

  // x6: Hourly volume spike relative to 24h average from WEEX ticker
  // Resolves ticker from WEEX map via findTickerInMap
  let weexTicker: any = null;
  if (tickers) {
    const weexMap = tickers.weex || tickers['weex'] || tickers;
    weexTicker = findTickerInMap(symbol, weexMap);
  }
  const quoteVol = weexTicker?.quoteVolume || weexTicker?.volume24h || weexTicker?.quoteVolume24h || 0;
  const avgHourlyVol = quoteVol > 0 ? quoteVol / 24 : 0;
  const x6 = (avgHourlyVol > 0 && volume > avgHourlyVol * 1.5) ? 1 : 0;

  // x7: Order book imbalance normalized (-1 to 1)
  let ob: any = null;
  if (orderBookImbalance) {
    for (const key of candidateKeys) {
      if (key && orderBookImbalance[key]) {
        ob = orderBookImbalance[key];
        break;
      }
    }
  }
  const x7 = (ob?.imbalance !== undefined ? ob.imbalance : 0) / 100;

  // x8: Top wick percentage
  const x8 = indicators.wicks?.topPct || 0;

  // x9: Liquidity sweep flag
  const x9 = (indicators.isLiquiditySweep || indicators.isLiquiditySweep1h || indicators.isLiquiditySweep5m) ? 1 : 0;

  // x10: Distance from VWAP (%)
  const x10 = indicators.vwap ? ((currentPrice - indicators.vwap) / indicators.vwap) * 100 : 0;

  // x11: Parabolic SAR status: BEARISH -> 1, BULLISH -> -1
  const x11 = indicators.psarStatus === 'BEARISH' ? 1 : (indicators.psarStatus === 'BULLISH' ? -1 : 0);

  const features = [x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11];

  return {
    features,
    hadIndicators: true,
    keyUsed,
    ageSec
  };
}
