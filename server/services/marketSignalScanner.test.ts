import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateProgrammaticCommitteeFallback,
  runDeterministicQuantCommitteeFallback,
  executeUpdateSignalsCache,
  evaluateScannerPatternPure,
  SCANNER_PATTERN_NAMES,
  getUnknownDisabledPatterns,
  resetUnknownDisabledPatternsWarnForTest,
  type MarketSignalScannerContext
} from './marketSignalScanner.ts';

describe('marketSignalScanner', () => {
  describe('generateProgrammaticCommitteeFallback', () => {
    it('returns SHORT consensus for unblocked SHORT pattern', () => {
      const res = generateProgrammaticCommitteeFallback({
        symbol: 'BTC/USDT',
        matchedPattern: '💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)',
        blockLocks: [],
        blockDetails: [],
        indicators: {
          rsi1h: 78,
          topWickPct: 0.65,
          volumeSpike: 2.5
        }
      });

      expect(res.finalVerdict).toBe('SHORT');
      expect(res.judgeVerdict).toContain('SHORT');
      expect(res.aiScore).toBeGreaterThanOrEqual(80);
      expect(res.bearVerdict).toContain('Сформирован качественный паттерн');
    });

    it('returns LONG consensus for unblocked LONG pattern', () => {
      const res = generateProgrammaticCommitteeFallback({
        symbol: 'ETH/USDT',
        matchedPattern: '💥 ПРОЛИВ (SAR Bottom Reversal)',
        blockLocks: [],
        blockDetails: [],
        indicators: {
          rsi1h: 22,
          bottomWickPct: 0.6,
          volumeSpike: 1.8
        }
      });

      expect(res.finalVerdict).toBe('LONG');
      expect(res.judgeVerdict).toContain('LONG');
      expect(res.aiScore).toBeGreaterThanOrEqual(80);
      expect(res.bullVerdict).toContain('Обнаружен разворотный паттерн');
    });

    it('returns REJECT when blockLocks are present', () => {
      const res = generateProgrammaticCommitteeFallback({
        symbol: 'SOL/USDT',
        matchedPattern: '🔥 Vertical Exhaustion (Разворот)',
        blockLocks: ['EMA200', '4hFVGAbove'],
        blockDetails: ['Цена выше EMA-200', 'Зона FVG сверху'],
        indicators: {
          rsi1h: 72
        }
      });

      expect(res.finalVerdict).toBe('REJECT');
      expect(res.judgeVerdict).toContain('REJECT');
      expect(res.bearVerdict).toContain('заблокирована фильтрами: EMA200, 4hFVGAbove');
      expect(res.aiScore).toBeLessThan(50);
    });

    it('returns REJECT for neutral data', () => {
      const res = generateProgrammaticCommitteeFallback({
        symbol: 'ADA/USDT',
        matchedPattern: 'None',
        blockLocks: [],
        blockDetails: [],
        indicators: { rsi1h: 50 }
      });

      expect(res.finalVerdict).toBe('REJECT');
      expect(res.bullVerdict).toContain('неопределенном флэте');
    });
  });

  describe('runDeterministicQuantCommitteeFallback', () => {
    it('handles empty or non-array inputs gracefully', () => {
      expect(runDeterministicQuantCommitteeFallback([])).toEqual([]);
      expect(runDeterministicQuantCommitteeFallback(null as any)).toEqual([]);
    });

    it('processes array of signals correctly', () => {
      const results = runDeterministicQuantCommitteeFallback([
        {
          symbol: 'BTC/USDT',
          matchedPattern: '💀 СЛИВ МОНЕТЫ',
          blockLocks: [],
          indicators: { rsi1h: 80 }
        }
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].finalVerdict).toBe('SHORT');
    });
  });

  describe('executeUpdateSignalsCache', () => {
    let mockContext: MarketSignalScannerContext;
    let cachedSignals: any = null;

    beforeEach(() => {
      cachedSignals = null;
      mockContext = {
        getGlobalTrueOHLCV: () => ({
          'BTCUSDT': {
            sar: 65000,
            vwap: 64800,
            rsi1h: 78,
            bb1h: 'OVERBOUGHT',
            psarStatus1m: 'BEARISH',
            isSarBearishFlipped1m: true,
            wicks: { topPct: 0.65, bottomPct: 0.1, bodySize: 0 },
            volumeSpike: 1.5,
            isLiquiditySweep: true
          }
        }),
        getGlobalCcxtTickers: () => ({
          weex: {
            'BTC/USDT': {
              last: 65000,
              percentage: 8.5,
              high: 65500,
              low: 60000,
              quoteVolume: 1000000
            }
          }
        }),
        getGlobalSettings: () => ({
          isEma200FilterEnabled: true,
          isFvgAboveFilterEnabled: true,
          isFvgSupportBelowFilterEnabled: true,
          isLiquiditySweepFilterEnabled: true,
          liquiditySweepWickThreshold: 0.60,
          isLateShortFilterEnabled: true
        }),
        setCachedSignals: vi.fn((obj) => { cachedSignals = obj; }),
        emitSignalsUpdated: vi.fn(),
        runAutopilotAndVirtualTradeEntry: vi.fn().mockResolvedValue(undefined),
        isMainThread: true
      };
    });

    it('scans indicators, creates signals cache, and fires update events', async () => {
      await executeUpdateSignalsCache(mockContext);

      expect(mockContext.setCachedSignals).toHaveBeenCalled();
      expect(mockContext.emitSignalsUpdated).toHaveBeenCalled();
      expect(cachedSignals).toBeDefined();
      expect(cachedSignals.data).toHaveLength(1);
      expect(cachedSignals.data[0].signal).toBe('SHORT');
      expect(cachedSignals.data[0].matchedPattern).toContain('СЛИВ МОНЕТЫ');
      expect(cachedSignals.marketRegime).toBe('TREND_UP'); // btc change > 2.5
    });

    it('keeps ESTIMATED ticker-only coins NEUTRAL instead of firing fake directional patterns', async () => {
      const estContext: MarketSignalScannerContext = {
        ...mockContext,
        getGlobalTrueOHLCV: () => ({}),
        getGlobalCcxtTickers: () => ({
          weex: {
            'DOGE/USDT:USDT': {
              last: 0.15,
              percentage: -12.0,
              high: 0.18,
              low: 0.145,
              open: 0.17,
              quoteVolume: 500000
            }
          }
        })
      };

      await executeUpdateSignalsCache(estContext);

      expect(cachedSignals).toBeDefined();
      expect(cachedSignals.data).toHaveLength(1);
      expect(cachedSignals.data[0].dataQuality).toBe('ESTIMATED');
      expect(cachedSignals.data[0].signal).toBe('NEUTRAL');
      expect(cachedSignals.data[0].matchedPattern).toBe('None');
    });
  });

  describe('evaluateScannerPatternPure parity', () => {
    it('matches executeUpdateSignalsCache pattern selection deterministically for SHORT/LONG/ESTIMATED', () => {
      const shortRes = evaluateScannerPatternPure({
        tickerPrice: 65000,
        change: 8.5,
        high: 65500,
        low: 60000,
        volume: 1000000,
        rawIndicators: {
          sar: 65000,
          vwap: 64800,
          rsi1h: 78,
          bb1h: 'OVERBOUGHT',
          psarStatus1m: 'BEARISH',
          isSarBearishFlipped1m: true,
          wicks: { topPct: 0.65, bottomPct: 0.1, bodySize: 0 },
          volumeSpike: 1.5
        }
      });
      expect(shortRes.signalSide).toBe('SHORT');
      expect(shortRes.matchedPattern).toBe('💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)');

      const longRes = evaluateScannerPatternPure({
        tickerPrice: 100,
        change: -8.5,
        high: 110,
        low: 99,
        volume: 1000000,
        rawIndicators: {
          sar: 99,
          vwap: 102,
          rsi1h: 22,
          bb1h: 'OVERSOLD',
          psarStatus1m: 'BULLISH',
          isSarBullishFlipped1m: true,
          wicks: { topPct: 0.1, bottomPct: 0.6, bodySize: 0 },
          volumeSpike: 1.8
        }
      });
      expect(longRes.signalSide).toBe('LONG');
      expect(longRes.matchedPattern).toBe('💥 ПРОЛИВ (SAR Bottom Reversal)');

      const estRes = evaluateScannerPatternPure({
        tickerPrice: 0.15,
        change: -12.0,
        high: 0.18,
        low: 0.145,
        volume: 500000,
        open: 0.17,
        rawIndicators: undefined
      });
      expect(estRes.dataQuality).toBe('ESTIMATED');
      expect(estRes.signalSide).toBe('NEUTRAL');
      expect(estRes.matchedPattern).toBe('None');
    });
  });

  describe('disabledPatterns kill-switch (L2 branch-level fall-through)', () => {
    it('allows subsequent matching pattern (Volume Climax Bottom) to trigger when earlier pattern (Bottom Wick Retest) is disabled', () => {
      // Matches both '🎯 Bottom Wick Retest (Ретест дна)' AND '💀 Volume Climax Bottom (Recovery)'
      // Avoids earlier LONG branches: change > -7 (dropFromRecentHigh < 8, wait: dropFromRecentHigh=(105-100)/105=4.76%),
      // riseFromLow=(100-98)/98=2.04% (between 0.5 and 3.5), wicks.bottomPct=0.34 (<0.35 & <0.40),
      // rsi1h=45 (>30), bb1h='INSIDE', volumeSpike=3.5 (>=3.0), isSarBullishFlipped1m=false.
      const dualLongInput = {
        tickerPrice: 100,
        change: -4.5,
        high: 105,
        low: 98,
        volume: 1_000_000,
        rawIndicators: {
          sar: 101,
          vwap: 102,
          rsi1h: 45,
          bb1h: 'INSIDE',
          psarStatus1m: 'BULLISH',
          isSarBullishFlipped1m: false,
          isSarBearishFlipped1m: false,
          wicks: { topPct: 0.1, bottomPct: 0.34, bodySize: 0 },
          volumeSpike: 3.5
        }
      };

      const baseline = evaluateScannerPatternPure({ ...dualLongInput, disabledPatterns: [] });
      expect(baseline.signalSide).toBe('LONG');
      expect(baseline.matchedPattern).toBe('🎯 Bottom Wick Retest (Ретест дна)');
      expect(baseline.scoreBonus).toBe(13);

      // Disable Bottom Wick Retest (case + whitespace insensitive) -> must fall through to Volume Climax Bottom
      const fallThrough = evaluateScannerPatternPure({
        ...dualLongInput,
        disabledPatterns: ['  🎯 bottom wick retest (ретест дна)  ']
      });
      expect(fallThrough.signalSide).toBe('LONG');
      expect(fallThrough.matchedPattern).toBe('💀 Volume Climax Bottom (Recovery)');
      expect(fallThrough.scoreBonus).toBe(12);

      // Disabling both matching LONG branches suppresses to NEUTRAL
      const suppressedBoth = evaluateScannerPatternPure({
        ...dualLongInput,
        disabledPatterns: [
          '🎯 Bottom Wick Retest (Ретест дна)',
          '💀 Volume Climax Bottom (Recovery)'
        ]
      });
      expect(suppressedBoth.signalSide).toBe('NEUTRAL');
      expect(suppressedBoth.matchedPattern).toBe('None');
      expect(suppressedBoth.scoreBonus).toBe(0);

      // Other non-disabled patterns (e.g. SHORT SAR Reversal) stay completely unaffected
      const unaffectedShort = evaluateScannerPatternPure({
        tickerPrice: 65000,
        change: 8.5,
        high: 65500,
        low: 60000,
        volume: 1_000_000,
        disabledPatterns: ['🎯 Bottom Wick Retest (Ретест дна)'],
        rawIndicators: {
          sar: 65000,
          vwap: 64800,
          rsi1h: 78,
          bb1h: 'OVERBOUGHT',
          psarStatus1m: 'BEARISH',
          isSarBearishFlipped1m: true,
          wicks: { topPct: 0.65, bottomPct: 0.1, bodySize: 0 },
          volumeSpike: 1.5
        }
      });
      expect(unaffectedShort.signalSide).toBe('SHORT');
      expect(unaffectedShort.matchedPattern).toBe('💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)');
    });

    it('suppresses cache signal to NEUTRAL when all matching patterns for the coin are disabled, and warns once on unknown names', async () => {
      resetUnknownDisabledPatternsWarnForTest();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const input = {
        tickerPrice: 65000,
        change: 8.5,
        high: 65500,
        low: 60000,
        volume: 1_000_000,
        rawIndicators: {
          sar: 65000,
          vwap: 64800,
          rsi1h: 78,
          bb1h: 'OVERBOUGHT',
          psarStatus1m: 'BEARISH',
          isSarBearishFlipped1m: true,
          wicks: { topPct: 0.65, bottomPct: 0.1, bodySize: 0 },
          volumeSpike: 1.5
        }
      };

      // Unknown name check & warning
      expect(SCANNER_PATTERN_NAMES).toHaveLength(16);
      expect(getUnknownDisabledPatterns(['NoSuchPattern', '  🎯 bottom wick retest (ретест дна)  '])).toEqual(['NoSuchPattern']);

      let cachedSignals: any = null;
      await executeUpdateSignalsCache({
        getGlobalTrueOHLCV: () => ({
          BTCUSDT: { ...input.rawIndicators, isLiquiditySweep: true }
        }),
        getGlobalCcxtTickers: () => ({
          weex: {
            'BTC/USDT': {
              last: 65000,
              percentage: 8.5,
              high: 65500,
              low: 60000,
              quoteVolume: 1000000
            }
          }
        }),
        getGlobalSettings: () => ({
          isEma200FilterEnabled: true,
          isFvgAboveFilterEnabled: true,
          isFvgSupportBelowFilterEnabled: true,
          isLiquiditySweepFilterEnabled: true,
          liquiditySweepWickThreshold: 0.60,
          isLateShortFilterEnabled: true,
          disabledPatterns: [
            'Unknown Fake Pattern',
            '💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)',
            '🧹 False Breakout (Ложный пробой)',
            '⚡ 1m Spire Climax (Шпиль на 1м)',
            '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)',
            '🎯 Wick Zone Retest (Ретест фитиля)',
            '🔥 Vertical Exhaustion (Разворот)',
            '💀 Volume Climax (Predictive Dump)',
            '⚡ EXTREME OVERBOUGHT PEAK (Early Limit SHORT Entry)'
          ]
        }),
        setCachedSignals: (obj) => { cachedSignals = obj; },
        emitSignalsUpdated: vi.fn(),
        isMainThread: false
      });

      expect(cachedSignals?.data).toHaveLength(1);
      expect(cachedSignals.data[0].signal).toBe('NEUTRAL');
      expect(cachedSignals.data[0].matchedPattern).toBe('None');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown Fake Pattern'));
      warnSpy.mockRestore();
    });
  });
});

