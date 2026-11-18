import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateProgrammaticCommitteeFallback, runDeterministicQuantCommitteeFallback, executeUpdateSignalsCache, evaluateScannerPatternPure, type MarketSignalScannerContext } from './marketSignalScanner.ts';

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

  describe('disabledPatterns kill-switch (K3)', () => {
    it('keeps signal unchanged when disabledPatterns is empty and suppresses matched pattern to NEUTRAL when listed', async () => {
      const input = {
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
      };

      const baseline = evaluateScannerPatternPure({ ...input, disabledPatterns: [] });
      expect(baseline.signalSide).toBe('SHORT');
      expect(baseline.matchedPattern).toBe('💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)');
      expect(baseline.scoreBonus).toBe(16);

      const suppressed = evaluateScannerPatternPure({
        ...input,
        disabledPatterns: ['  💀 слив монеты (SAR Reversal at Peak)  ']
      });
      expect(suppressed.signalSide).toBe('NEUTRAL');
      expect(suppressed.matchedPattern).toBe('None');
      expect(suppressed.scoreBonus).toBe(0);

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
          disabledPatterns: ['💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)']
        }),
        setCachedSignals: (obj) => { cachedSignals = obj; },
        emitSignalsUpdated: vi.fn(),
        isMainThread: false
      });

      expect(cachedSignals?.data).toHaveLength(1);
      expect(cachedSignals.data[0].signal).toBe('NEUTRAL');
      expect(cachedSignals.data[0].matchedPattern).toBe('None');
    });
  });
});

