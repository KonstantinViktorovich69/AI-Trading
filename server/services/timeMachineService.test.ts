import { describe, it, expect } from 'vitest';
import { simulateTradeAlternatives, runTimeMachineBatch } from './timeMachineService.ts';

describe('timeMachineService (Машина времени и бэктестинг сделок)', () => {
  it('correctly returns actual outcome when no candle data is supplied', () => {
    const mockTrade = {
      id: 'trade_test_1',
      symbol: 'BTC/USDT:USDT',
      side: 'SHORT',
      entryPrice: 90000,
      closePrice: 88000,
      pnlPercent: 11.11,
      matchedPattern: '🔥 Vertical Exhaustion',
      status: 'CLOSED'
    };

    const result = simulateTradeAlternatives(mockTrade, []);
    expect(result.tradeId).toBe('trade_test_1');
    expect(result.actualResult.pnlPercent).toBe(11.11);
    expect(result.scenarios.ACTUAL.isWin).toBe(true);
  });

  it('accurately evaluates OTE pullback, trailing stop and breakeven scenarios with candle data', () => {
    const mockTrade = {
      id: 'trade_test_2',
      symbol: 'ETH/USDT:USDT',
      side: 'LONG',
      entryPrice: 3000,
      closePrice: 3050,
      pnlPercent: 8.33,
      leverage: 5,
      matchedPattern: '💥 ПРОЛИВ',
      status: 'CLOSED'
    };

    // Candles: [ts, open, high, low, close, volume]
    const mockCandles: Array<[number, number, number, number, number, number]> = [
      [1000, 3000, 3010, 2980, 2990, 100], // Dip into OTE zone (2980 < 3000)
      [2000, 2990, 3080, 2985, 3070, 150], // Big pump up to 3080 (+13.3% pnl)
      [3000, 3070, 3085, 3040, 3050, 120]  // Pullback from high (trailing triggers)
    ];

    const result = simulateTradeAlternatives(mockTrade, mockCandles);

    expect(result.tradeId).toBe('trade_test_2');
    expect(result.scenarios.ACTUAL).toBeDefined();
    expect(result.scenarios.OTE_ENTRY).toBeDefined();
    expect(result.scenarios.TRAILING_STOP).toBeDefined();
    expect(result.scenarios.PTTP_PROFIT).toBeDefined();
    expect(result.scenarios.BREAKEVEN_QUICK).toBeDefined();

    // Verify best scenario is identified
    expect(['ACTUAL', 'OTE_ENTRY', 'TRAILING_STOP', 'PTTP_PROFIT', 'BREAKEVEN_QUICK']).toContain(result.bestScenario);
  });

  it('runs batch simulations and generates aggregated comparative metrics & lessons', () => {
    const mockTrades = [
      {
        id: 't1',
        symbol: 'SOL/USDT:USDT',
        side: 'SHORT',
        entryPrice: 180,
        closePrice: 175,
        pnlPercent: 13.88,
        leverage: 5,
        matchedPattern: '🎯 Wick Zone Retest',
        status: 'CLOSED'
      },
      {
        id: 't2',
        symbol: 'SOL/USDT:USDT',
        side: 'SHORT',
        entryPrice: 175,
        closePrice: 178,
        pnlPercent: -8.57,
        leverage: 5,
        matchedPattern: '🎯 Wick Zone Retest',
        status: 'CLOSED'
      }
    ];

    const { analyses, summary } = runTimeMachineBatch(mockTrades, {
      'SOLUSDT': [
        [1000, 180, 182, 178, 179, 100],
        [2000, 179, 181, 172, 174, 200]
      ]
    });

    expect(analyses.length).toBe(2);
    expect(summary.totalAnalyzedTrades).toBe(2);
    expect(summary.scenarioSummaries.ACTUAL).toBeDefined();
    expect(summary.scenarioSummaries.OTE_ENTRY).toBeDefined();
    expect(summary.scenarioSummaries.TRAILING_STOP).toBeDefined();
    expect(summary.topAdaptiveLessons.length).toBeGreaterThanOrEqual(1);
  });
});
