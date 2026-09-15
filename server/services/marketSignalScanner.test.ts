import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateProgrammaticCommitteeFallback, runDeterministicQuantCommitteeFallback, executeUpdateSignalsCache, type MarketSignalScannerContext } from './marketSignalScanner.ts';

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
        isBinanceCrossListed: vi.fn().mockReturnValue(true),
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
  });
});
