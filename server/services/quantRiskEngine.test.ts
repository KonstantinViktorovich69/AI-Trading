import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchesStructuredFilter, calculateConfidenceProbability, executeUpdateMarketPulse, executeScrapeSocialSentiment, type QuantRiskEngineContext } from './quantRiskEngine.ts';

describe('quantRiskEngine', () => {
  describe('matchesStructuredFilter', () => {
    it('returns matched=false for invalid or empty indicator', () => {
      const res = matchesStructuredFilter({ filterIndicator: 'none' }, 50, 1, 0);
      expect(res.matched).toBe(false);
    });

    it('matches RSI greater than target with penalty action', () => {
      const rule = {
        filterIndicator: 'rsi',
        filterCondition: 'gt',
        filterValue: 70,
        filterAction: 'penalty',
        text: 'Перегретый RSI'
      };
      const res = matchesStructuredFilter(rule, 75, 1, 0);
      expect(res.matched).toBe(true);
      expect(res.isPenalty).toBe(true);
      expect(res.reason).toContain('Перегретый RSI');
    });

    it('matches volume less than target with block action', () => {
      const rule = {
        filterIndicator: 'volume',
        filterCondition: 'lt',
        filterValue: 1.5,
        filterAction: 'block',
        text: 'Слабый объем'
      };
      const res = matchesStructuredFilter(rule, 50, 1.2, 0);
      expect(res.matched).toBe(true);
      expect(res.isBlock).toBe(true);
    });
  });

  describe('calculateConfidenceProbability', () => {
    let mockContext: QuantRiskEngineContext;

    beforeEach(() => {
      mockContext = {
        getGlobalTrueOHLCV: () => ({
          'BTCUSDT': {
            is48hBreakout: 1,
            rsi1h: 65,
            macdHistogram: 15,
            ema50: 64000,
            ema200: 62000,
            wicks: { topPct: 0.5 },
            isLiquiditySweep: true,
            vwap: 64500,
            psarStatus: 'BEARISH'
          }
        }),
        getGlobalCcxtTickers: () => ({
          binance: {
            'BTC/USDT': { quoteVolume: 2400000 }
          }
        }),
        getWsTickers: () => ({}),
        getOrderBookImbalance: () => ({
          'BTCUSDT': { imbalance: 60 }
        }),
        getModelWeights: () => ({
          beta0: 0, beta1: 0.5, beta2: 0.01, beta3: 0.05,
          beta4: 0.02, beta5: 0.01, beta6: 0.3, beta7: 0.4,
          beta8: 0.2, beta9: 0.5, beta10: 0.1, beta11: 0.3
        }),
        getAiKnowledgeBase: () => [],
        getMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0, recommendation: 'Standby', lastUpdated: Date.now() }),
        setMarketPulse: vi.fn(),
        getSocialSentimentCache: () => ({}),
        getSignalsCache: () => ({ btcTrend24h: 1.5 }),
        getGlobalLiquidations: () => ({}),
        safeJsonParse: vi.fn()
      };
    });

    it('calculates probability within [0.01, 0.99] range', () => {
      const result = calculateConfidenceProbability('BTCUSDT', 65000, 200000, mockContext);
      expect(result.p).toBeGreaterThanOrEqual(0.01);
      expect(result.p).toBeLessThanOrEqual(0.99);
      expect(result.features).toHaveLength(11);
    });

    it('returns default p=0.5 if indicators are not found', () => {
      const result = calculateConfidenceProbability('UNKNOWN_COIN', 10, 100, mockContext);
      expect(result.p).toBe(0.5);
    });
  });

  describe('executeUpdateMarketPulse', () => {
    it('sets technical fallback pulse when AI generation fails or is absent', async () => {
      let currentPulse: any = {};
      const mockContext: QuantRiskEngineContext = {
        getGlobalTrueOHLCV: () => ({}),
        getGlobalCcxtTickers: () => ({}),
        getWsTickers: () => ({}),
        getOrderBookImbalance: () => ({}),
        getModelWeights: () => ({}),
        getAiKnowledgeBase: () => [],
        getMarketPulse: () => currentPulse,
        setMarketPulse: vi.fn((pulse) => { currentPulse = pulse; }),
        getSocialSentimentCache: () => ({}),
        getSignalsCache: () => ({ btcTrend24h: 3.5 }),
        getGlobalLiquidations: () => ({}),
        safeJsonParse: vi.fn()
      };

      await executeUpdateMarketPulse(mockContext);

      expect(mockContext.setMarketPulse).toHaveBeenCalled();
      expect(currentPulse.sentiment).toBe('BULLISH');
      expect(currentPulse.bias).toBe(0.35);
    });
  });

  describe('executeScrapeSocialSentiment', () => {
    it('uses fallback and caches result when AI generation is not present', async () => {
      const cache: any = {};
      const mockContext: QuantRiskEngineContext = {
        getGlobalTrueOHLCV: () => ({}),
        getGlobalCcxtTickers: () => ({}),
        getWsTickers: () => ({
          Binance: {
            'BTC/USDT': { change: 18, quoteVolume: 5000000 }
          }
        }),
        getOrderBookImbalance: () => ({}),
        getModelWeights: () => ({}),
        getAiKnowledgeBase: () => [],
        getMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0, recommendation: 'Standby', lastUpdated: Date.now() }),
        setMarketPulse: vi.fn(),
        getSocialSentimentCache: () => cache,
        getSignalsCache: () => ({ btcTrend24h: 0 }),
        getGlobalLiquidations: () => ({}),
        safeJsonParse: vi.fn()
      };

      const res = await executeScrapeSocialSentiment('BTCUSDT', mockContext);
      expect(res.score).toBe(82);
      expect(res.trend).toBe('PUMP_HYPE');
      expect(cache['BTC'].trend).toBe('PUMP_HYPE');
    });
  });
});
