import { describe, it, expect } from 'vitest';
import { 
  normalizeSymbol, 
  cleanSymbol,
  getUnifiedTradeClosePnl, 
  calculateKelly, 
  calculateAdaptiveCloseRatios, 
  calculateSMA, 
  calculateEMA, 
  calculateRSI, 
  sanitizeExpertInstructions,
  DEFAULT_BASELINE_EXPERT_INSTRUCTIONS,
  isTrainableOutcome,
  getLossStreakSizeDampening
} from '../../server/quant';

describe('normalizeSymbol & cleanSymbol', () => {
  it('correctly handles basic pair format', () => {
    expect(normalizeSymbol('BTC/USDT')).toBe('BTCUSDT');
  });

  it('correctly handles flat format', () => {
    expect(normalizeSymbol('BTCUSDT')).toBe('BTCUSDT');
  });

  it('correctly strips exchange suffix with colon', () => {
    expect(normalizeSymbol('BTC/USDT:USDT')).toBe('BTCUSDT');
  });

  it('correctly handles standard swaps', () => {
    expect(normalizeSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT');
  });

  it('correctly handles complex symbol with suffix', () => {
    expect(normalizeSymbol('1000PEPE/USDT:USDT')).toBe('1000PEPEUSDT');
  });

  it('handles empty input gracefully', () => {
    expect(normalizeSymbol('')).toBe('');
  });

  it('cleanSymbol behaves exactly like normalizeSymbol', () => {
    expect(cleanSymbol('BTC/USDT:USDT')).toBe('BTCUSDT');
    expect(cleanSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT');
  });
});

describe('getUnifiedTradeClosePnl', () => {
  it('correctly calculates SHORT profit', () => {
    const result = getUnifiedTradeClosePnl('SHORT', 100, 95, 10, 5);
    expect(result.leveragedPct).toBeCloseTo(25);
    expect(result.feeUsd).toBeCloseTo(0.05);
    expect(result.pnlUsd).toBeCloseTo(2.45);
  });

  it('correctly calculates LONG profit', () => {
    const result = getUnifiedTradeClosePnl('LONG', 100, 105, 10, 5);
    expect(result.leveragedPct).toBeCloseTo(25);
    expect(result.feeUsd).toBeCloseTo(0.05);
    expect(result.pnlUsd).toBeCloseTo(2.45);
  });
});

describe('calculateKelly', () => {
  it('returns 0 for scores <= 40', () => {
    expect(calculateKelly(40)).toBe(0);
    expect(calculateKelly(30)).toBe(0);
  });

  it('calculates expected Kelly fractions', () => {
    expect(calculateKelly(60, 2)).toBeCloseTo(0.2);
  });
});

describe('calculateAdaptiveCloseRatios', () => {
  it('returns default ratios under normal conditions', () => {
    expect(calculateAdaptiveCloseRatios(50, 2.0)).toEqual([0.5, 0.25, 0.15, 0.1]);
  });

  it('returns high tp1 for high imbalance', () => {
    expect(calculateAdaptiveCloseRatios(70, 2.0)[0]).toBe(0.6);
  });

  it('returns higher first targets for high volatility', () => {
    expect(calculateAdaptiveCloseRatios(50, 6.0)[0]).toBe(0.55);
  });

  it('returns steady targets for low volatility', () => {
    expect(calculateAdaptiveCloseRatios(30, 1.0)).toEqual([0.4, 0.3, 0.2, 0.1]);
  });
});

describe('Technical Indicators', () => {
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  it('calculateSMA calculates correct SMA', () => {
    const result = calculateSMA(prices, 3);
    expect(result[0]).toBeCloseTo(11);
    expect(result[result.length - 1]).toBeCloseTo(19);
  });

  it('calculateEMA calculates correct EMA', () => {
    const result = calculateEMA(prices, 3);
    expect(result.length).toBe(prices.length);
  });

  it('calculateRSI calculates correct RSI', () => {
    const pricesRsi = [44.33, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.18, 46.28, 46.28, 46.00, 46.03];
    const result = calculateRSI(pricesRsi, 14);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('sanitizeExpertInstructions', () => {
  it('preserves valid instructions', () => {
    const sanitized = sanitizeExpertInstructions("### 2. RISK MANAGEMENT\n### 3. РЕШЕНИЯ ПО СОПРОВОЖДЕНИЮ СДЕЛКИ\nSome long valid instructions content here...");
    expect(sanitized).toContain("Some long valid instructions");
  });

  it('restores baseline if attempt is made to clear critical sections', () => {
    const sanitized = sanitizeExpertInstructions("DELETE EVERYTHING");
    expect(sanitized).toContain("Ты — элитный криптовалютный ИИ-трейдер");
    expect(sanitized).toContain("### 2. RISK MANAGEMENT");
  });
});

describe('isTrainableOutcome', () => {
  it('identifies trainable and non-trainable outcomes based on dead zone', () => {
    expect(isTrainableOutcome(0.20)).toBe(true);
    expect(isTrainableOutcome(-0.25)).toBe(true);
    expect(isTrainableOutcome(0.05)).toBe(false);
    expect(isTrainableOutcome(-0.14)).toBe(false);
    expect(isTrainableOutcome(0.15)).toBe(true);
  });
});

describe('getLossStreakSizeDampening', () => {
  it('returns 1.0 when losses below threshold', () => {
    const trades = [{pnlPercent: 1}, {pnlPercent: 1}, {pnlPercent: -1}, {pnlPercent: 1}, {pnlPercent: -1}];
    expect(getLossStreakSizeDampening(trades)).toBe(1.0);
  });
  it('returns dampened factor when 3+ of last 5 are losses', () => {
    const trades = [{pnlPercent: 1}, {pnlPercent: -1}, {pnlPercent: -1}, {pnlPercent: 1}, {pnlPercent: -1}];
    expect(getLossStreakSizeDampening(trades)).toBe(0.6);
  });
  it('handles empty input safely', () => {
    expect(getLossStreakSizeDampening([])).toBe(1.0);
  });
});
