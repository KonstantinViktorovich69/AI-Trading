import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMarketRegime } from './marketRegimeService.ts';
import { executeUpdateSignalsCache, type MarketSignalScannerContext } from './marketSignalScanner.ts';

describe('Phase 2: Market Regime & Data Quality Remediation', () => {
  describe('T2.1: classifyMarketRegime with real vs mock candles', () => {
    it('classifies HIGH_VOLATILITY when 1h candle ranges exceed 4.0%', () => {
      // Create 10 candles where range is 5% each: high = 105, low = 100, close = 100 -> range = 5%
      const highVolCandles = Array.from({ length: 10 }, (_, i) => [
        1700000000000 + i * 3600000,
        100, // open
        105, // high
        100, // low
        100, // close -> (105 - 100)/100 = 5%
        1000 // volume
      ]);

      const res = classifyMarketRegime({ percentage: 0.5 }, highVolCandles);
      expect(res.btcVolatility1h).toBeGreaterThanOrEqual(4.0);
      expect(res.regime).toBe('HIGH_VOLATILITY');
      expect(res.recommendedLongWeight).toBe(0.7);
      expect(res.recommendedShortWeight).toBe(0.7);
    });

    it('classifies EXTREME_SQUEEZE when 1h candle ranges < 0.4% and btcChange < 1.0%', () => {
      // Create 10 candles where range is 0.2% each: high = 100.2, low = 100, close = 100 -> range = 0.2%
      const tightCandles = Array.from({ length: 10 }, (_, i) => [
        1700000000000 + i * 3600000,
        100,
        100.2,
        100,
        100,
        500
      ]);

      const res = classifyMarketRegime({ percentage: 0.2 }, tightCandles);
      expect(res.btcVolatility1h).toBeLessThan(0.4);
      expect(res.regime).toBe('EXTREME_SQUEEZE');
      expect(res.recommendedLongWeight).toBe(0.8);
      expect(res.recommendedShortWeight).toBe(0.8);
    });

    it('falls back to btcVolatility1h = 1.2 and RANGING_FLAT when candles are missing or empty', () => {
      // Legacy behavior: btcOhlcv was an object or empty array
      const resWithoutCandles = classifyMarketRegime({ percentage: 0.5 }, []);
      expect(resWithoutCandles.btcVolatility1h).toBe(1.2);
      expect(resWithoutCandles.regime).toBe('RANGING_FLAT');

      const resWithObject = classifyMarketRegime({ percentage: 0.5 }, { sar: 65000 } as any);
      expect(resWithObject.btcVolatility1h).toBe(1.2);
      expect(resWithObject.regime).toBe('RANGING_FLAT');
    });
  });

  describe('T2.1 & T2.2: executeUpdateSignalsCache with raw BTC candles & data quality tagging', () => {
    let cachedSignals: any = null;

    const highVolBtcCandles = Array.from({ length: 10 }, (_, i) => [
      1700000000000 + i * 3600000,
      100,
      106,
      100,
      100, // 6% range
      1000
    ]);

    const buildMockContext = (options: {
      regimeUsesRealBtcCandles?: boolean;
      includeRawBtcCandles?: boolean;
      coinHasRealIndicators?: boolean;
    }): MarketSignalScannerContext => {
      cachedSignals = null;
      return {
        getGlobalTrueOHLCV: () => {
          const res: Record<string, any> = {
            'BTCUSDT': { sar: 65000 } // Legacy indicators object
          };
          if (options.coinHasRealIndicators) {
            res['ETHUSDT'] = {
              sar: 3000,
              vwap: 2990,
              rsi1h: 42,
              bb1h: 'INSIDE',
              psarStatus1m: 'BULLISH',
              isSarBullishFlipped1m: false,
              wicks: { topPct: 0.2, bottomPct: 0.4, bodySize: 10 },
              volumeSpike: 1.5
            };
          }
          return res;
        },
        getGlobalRawOHLCV: options.includeRawBtcCandles ? () => ({
          'BTCUSDT': {
            '1h': highVolBtcCandles,
            '15m': []
          }
        }) : undefined,
        getGlobalCcxtTickers: () => ({
          weex: {
            'BTC/USDT': {
              last: 65000,
              percentage: 0.5,
              high: 66000,
              low: 64000,
              quoteVolume: 1000000
            },
            'ETH/USDT': {
              last: 3000,
              percentage: 2.5,
              high: 3050,
              low: 2950,
              quoteVolume: 500000
            }
          }
        }),
        getGlobalSettings: () => ({
          regimeUsesRealBtcCandles: options.regimeUsesRealBtcCandles === true,
          isEma200FilterEnabled: false,
          isFvgAboveFilterEnabled: false,
          isFvgSupportBelowFilterEnabled: false,
          isLiquiditySweepFilterEnabled: false,
          isLateShortFilterEnabled: false
        }),
        setCachedSignals: vi.fn((obj) => { cachedSignals = obj; }),
        emitSignalsUpdated: vi.fn(),
        runAutopilotAndVirtualTradeEntry: vi.fn().mockResolvedValue(undefined),
        isMainThread: true
      };
    };

    it('defaults regimeUsesRealBtcCandles to false: active regime is legacy (RANGING_FLAT) and shadow logs real (HIGH_VOLATILITY)', async () => {
      const ctx = buildMockContext({
        regimeUsesRealBtcCandles: false,
        includeRawBtcCandles: true,
        coinHasRealIndicators: true
      });

      await executeUpdateSignalsCache(ctx);

      expect(cachedSignals).toBeDefined();
      expect(cachedSignals.marketRegime).toBe('RANGING_FLAT'); // Legacy
      expect(cachedSignals.shadowRegimeReal.regime).toBe('HIGH_VOLATILITY'); // Real BTC candles
      expect(cachedSignals.regimeReal).toBe('HIGH_VOLATILITY');
      expect(cachedSignals.regimeLegacy).toBe('RANGING_FLAT');
    });

    it('uses HIGH_VOLATILITY as active regime when regimeUsesRealBtcCandles is enabled', async () => {
      const ctx = buildMockContext({
        regimeUsesRealBtcCandles: true,
        includeRawBtcCandles: true,
        coinHasRealIndicators: true
      });

      await executeUpdateSignalsCache(ctx);

      expect(cachedSignals).toBeDefined();
      expect(cachedSignals.marketRegime).toBe('HIGH_VOLATILITY');
    });

    it('tags coin without OHLCV candles as ESTIMATED with explicit estimatedFields', async () => {
      const ctx = buildMockContext({
        regimeUsesRealBtcCandles: false,
        includeRawBtcCandles: true,
        coinHasRealIndicators: false // ETH has no indicators in GLOBAL_TRUE_OHLCV
      });

      await executeUpdateSignalsCache(ctx);

      expect(cachedSignals).toBeDefined();
      const ethSignal = cachedSignals.data.find((s: any) => s.symbol.includes('ETH'));
      expect(ethSignal).toBeDefined();
      expect(ethSignal.dataQuality).toBe('ESTIMATED');
      expect(ethSignal.estimatedFields).toContain('rsi1h');
      expect(ethSignal.estimatedFields).toContain('volumeSpike');
      expect(ethSignal.estimatedFields).toContain('wicks');
      expect(ethSignal.estimatedFields).toContain('sar');
      expect(ethSignal.decisionTrace.metadata.dataQuality).toBe('ESTIMATED');
      expect(ethSignal.shadowRegimeReal).toBe('HIGH_VOLATILITY');
    });

    it('tags coin with complete OHLCV candles as REAL with empty estimatedFields', async () => {
      const ctx = buildMockContext({
        regimeUsesRealBtcCandles: false,
        includeRawBtcCandles: true,
        coinHasRealIndicators: true // ETH has full indicators
      });

      await executeUpdateSignalsCache(ctx);

      expect(cachedSignals).toBeDefined();
      const ethSignal = cachedSignals.data.find((s: any) => s.symbol.includes('ETH'));
      expect(ethSignal).toBeDefined();
      expect(ethSignal.dataQuality).toBe('REAL');
      expect(ethSignal.estimatedFields).toEqual([]);
      expect(ethSignal.decisionTrace.metadata.dataQuality).toBe('REAL');
    });
  });
});
