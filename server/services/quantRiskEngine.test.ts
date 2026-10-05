import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  matchesStructuredFilter,
  calculateConfidenceProbability,
  evaluateKnowledgeBaseForSignal,
  inferStructuredFilterFromRule,
  enrichKnowledgeBaseWithStructuredFilters,
  executeUpdateMarketPulse,
  executeScrapeSocialSentiment,
  type QuantRiskEngineContext
} from './quantRiskEngine.ts';

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

  describe('evaluateKnowledgeBaseForSignal', () => {
    it('returns empty result when knowledge base is empty', () => {
      const res = evaluateKnowledgeBaseForSignal('ETHUSDT', { rsi: 70 }, []);
      expect(res.isBlocked).toBe(false);
      expect(res.penaltyScore).toBe(0);
      expect(res.matchedRuleIds).toHaveLength(0);
    });

    it('applies blocking rule globally across all assets', () => {
      const kb = [{
        id: 'al_1',
        text: '[Авто-Обучение | BTC/USDT | PnL -4.8%] Избегать входа при RSI > 80',
        filterIndicator: 'rsi',
        filterCondition: 'gt',
        filterValue: 80,
        filterAction: 'block',
        impact: -12,
        successRate: 0.15
      }];

      // Evaluated on SOLUSDT (different symbol from BTC)
      const res = evaluateKnowledgeBaseForSignal('SOLUSDT', { rsi: 85 }, kb);
      expect(res.isBlocked).toBe(true);
      expect(res.matchedRuleIds).toContain('al_1');
    });

    it('applies penalty with asset-specific multiplier when matching same asset', () => {
      const kb = [{
        id: 'al_2',
        text: '[Авто-Обучение | DOGE/USDT | PnL -3.5%] Штрафовать лонги при падении объема',
        filterIndicator: 'volume',
        filterCondition: 'lt',
        filterValue: 1.5,
        filterAction: 'penalty',
        impact: 10,
        successRate: 0.5
      }];

      const resDoge = evaluateKnowledgeBaseForSignal('DOGE/USDT', { volumeSpike: 1.0 }, kb);
      const resOther = evaluateKnowledgeBaseForSignal('XRP/USDT', { volumeSpike: 1.0 }, kb);

      expect(resDoge.penaltyScore).toBeGreaterThanOrEqual(5);
      expect(resOther.penaltyScore).toBeGreaterThanOrEqual(5);
      expect(resDoge.matchedRuleIds).toContain('al_2');
      expect(resOther.matchedRuleIds).toContain('al_2');
    });

    it('dynamically infers triggers from text-only rules and applies penalties', () => {
      const kb = [{
        id: 'al_text_only',
        text: '[Авто-Обучение | FIL/USDT | PnL -29.9%] Избегать входов при перекупленности RSI > 75 и слабом объеме',
        impact: -12,
        successRate: 0.15,
        isArchived: true // Archived because of low winrate on loss
      }];

      // Evaluated with RSI 80 (should trigger penalty via dynamic inference even though archived)
      const res = evaluateKnowledgeBaseForSignal('FIL/USDT', { rsi: 80, volumeSpike: 1.0 }, kb);
      expect(res.penaltyScore).toBeGreaterThanOrEqual(5);
      expect(res.matchedRuleIds).toContain('al_text_only');
    });
  });

  describe('inferStructuredFilterFromRule & enrichKnowledgeBaseWithStructuredFilters', () => {
    it('infers RSI triggers correctly from text', () => {
      const rule = { text: 'Условие: перекупленный RSI > 72 на 15м' };
      const inferred = inferStructuredFilterFromRule(rule);
      expect(inferred).not.toBeNull();
      expect(inferred?.filterIndicator).toBe('rsi');
      expect(inferred?.filterCondition).toBe('gt');
      expect(inferred?.filterValue).toBe(72);
    });

    it('infers volume spike triggers correctly from text', () => {
      const rule = { text: 'Вход только при кульминационном объеме (объем > 2.0x)' };
      const inferred = inferStructuredFilterFromRule(rule);
      expect(inferred).not.toBeNull();
      expect(inferred?.filterIndicator).toBe('volume');
      expect(inferred?.filterCondition).toBe('gt');
      expect(inferred?.filterValue).toBe(2.0);
    });

    it('enriches a list of text-only rules with structured filters', () => {
      const kb = [
        { id: '1', text: '[Авто-Обучение | BTC/USDT | PnL -10%] Падение объема' },
        { id: '2', text: 'Паттерн Памп: Рост > 8% за 24ч' },
        { id: '3', text: 'Уже структурировано', filterIndicator: 'rsi', filterCondition: 'gt', filterValue: 70 }
      ];
      const count = enrichKnowledgeBaseWithStructuredFilters(kb);
      expect(count).toBe(2);
      expect((kb[0] as any).filterIndicator).toBeDefined();
      expect((kb[1] as any).filterIndicator).toBe('change24h');
      expect((kb[2] as any).filterValue).toBe(70);
    });
  });
});
