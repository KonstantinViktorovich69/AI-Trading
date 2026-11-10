import { describe, it, expect, vi } from 'vitest';
import { calculateConfidenceProbability, type QuantRiskEngineContext } from './quantRiskEngine.ts';
import {
  trainQuantModel,
  clipModelWeight,
  MODEL_WEIGHT_ABS_MAX,
  type QuantModelTrainerContext
} from './quantModelTrainer.ts';

describe('Phase 3: Quant Probability Model Symmetry & Honest Training', () => {
  describe('T3.1: Directional Symmetry (Mirror Market Test)', () => {
    function createMockQuantContext(symbol: string, indicators: any, obImbalance: number = 0): QuantRiskEngineContext {
      return {
        getGlobalTrueOHLCV: () => ({ [symbol]: indicators }),
        getGlobalCcxtTickers: () => ({
          weex: {
            [`${symbol}:USDT`]: { quoteVolume: 2400000 } // avg hourly vol = 100,000
          }
        }),
        getOrderBookImbalance: () => ({ [symbol]: { imbalance: obImbalance } }),
        getModelWeights: () => ({
          beta0: 0.1,
          beta1: 0.5,
          beta2: 0.02,
          beta3: 0.1,
          beta4: 0.05,
          beta5: 0.05,
          beta6: 0.2,
          beta7: 0.3,
          beta8: 0.4,
          beta9: 0.5,
          beta10: 0.1,
          beta11: 0.3
        }),
        getAiKnowledgeBase: () => [],
        getMarketPulse: () => ({ bias: 0, sentiment: 'NEUTRAL', recommendation: 'Range Trading', lastUpdated: Date.now() }),
        setMarketPulse: vi.fn(),
        getSocialSentimentCache: () => ({}),
        getWsTickers: () => ({}),
        getSignalsCache: () => null,
        getGlobalLiquidations: () => ({}),
        safeJsonParse: (j: string, f: any) => { try { return JSON.parse(j); } catch { return f; } }
      };
    }

    it('p(SHORT) with side="SHORT" is bitwise identical to p without side', () => {
      const indicators = {
        is48hBreakout: 1,
        rsi1h: 75,
        macdHistogram: 2.5,
        ema50: 95,
        ema200: 90,
        wicks: { topPct: 0.45, bottomPct: 0.1 },
        isLiquiditySweep: true,
        vwap: 96,
        psarStatus: 'BEARISH'
      };

      const ctx = createMockQuantContext('BTCUSDT', indicators, 50);

      const legacyResult = calculateConfidenceProbability('BTCUSDT', 100, 200000, ctx);
      const shortResult = calculateConfidenceProbability('BTCUSDT', 100, 200000, ctx, 'SHORT');

      expect(shortResult.p).toBe(legacyResult.p);
      expect(shortResult.features).toEqual(legacyResult.features);
    });

    it('mirror market test: features(LONG, mirror) matches features(SHORT, original)', () => {
      // Original SHORT market setup:
      // Price pumped to 100. Overbought, breakout high, top wick rejection, bearish SAR.
      const originalIndicators = {
        is48hBreakout: 1,
        rsi1h: 78,
        macdHistogram: 4.0,
        ema50: 95, // (100 - 95)/95 * 100 = 5.263%
        ema200: 90, // (100 - 90)/90 * 100 = 11.111%
        wicks: { topPct: 0.55, bottomPct: 0.05 },
        isLiquiditySweep: true,
        vwap: 96, // (100 - 96)/96 * 100 = 4.167%
        psarStatus: 'BEARISH'
      };

      const originalCtx = createMockQuantContext('PUMP_COIN', originalIndicators, 60);
      const shortFeatures = calculateConfidenceProbability('PUMP_COIN', 100, 200000, originalCtx, 'SHORT').features;

      // Perfectly Mirrored LONG market setup:
      // Price dumped to 100. Oversold, breakdown low, bottom wick rejection, bullish SAR.
      // Ema50 and Ema200 are chosen so that (ema - price)/ema equals original (price - ema)/ema.
      const mirrorEma50 = 100 / (1 - 5.263157894736842 / 100);
      const mirrorEma200 = 100 / (1 - 11.11111111111111 / 100);
      const mirrorVwap = 100 / (1 - 4.166666666666667 / 100);

      const mirrorIndicators = {
        is48hBreakoutLow: 1,
        rsi1h: 100 - 78, // 22
        macdHistogram: -4.0,
        ema50: mirrorEma50,
        ema200: mirrorEma200,
        wicks: { topPct: 0.05, bottomPct: 0.55 },
        isLiquiditySweepLow: true,
        vwap: mirrorVwap,
        psarStatus: 'BULLISH'
      };

      const mirrorCtx = createMockQuantContext('DUMP_COIN', mirrorIndicators, -60);
      const longFeatures = calculateConfidenceProbability('DUMP_COIN', 100, 200000, mirrorCtx, 'LONG').features;

      // Compare each of the 11 features
      expect(longFeatures).toHaveLength(11);
      expect(shortFeatures).toHaveLength(11);

      // x1 (Breakout)
      expect(longFeatures[0]).toBe(shortFeatures[0]); // 1
      // x2 (RSI centered at 0: 78-50=28 vs 50-22=28)
      expect(longFeatures[1]).toBe(shortFeatures[1]); // 28
      // x3 (MACD Histogram %)
      expect(longFeatures[2]).toBeCloseTo(shortFeatures[2], 4);
      // x4 (EMA50 distance %)
      expect(longFeatures[3]).toBeCloseTo(shortFeatures[3], 4);
      // x5 (EMA200 distance %)
      expect(longFeatures[4]).toBeCloseTo(shortFeatures[4], 4);
      // x6 (Volume spike - symmetric)
      expect(longFeatures[5]).toBe(shortFeatures[5]); // 1
      // x7 (Order book imbalance)
      expect(longFeatures[6]).toBeCloseTo(shortFeatures[6], 4); // 0.6
      // x8 (Wick: bottomPct for long, topPct for short)
      expect(longFeatures[7]).toBe(shortFeatures[7]); // 0.55
      // x9 (Liquidity sweep)
      expect(longFeatures[8]).toBe(shortFeatures[8]); // 1
      // x10 (VWAP distance %)
      expect(longFeatures[9]).toBeCloseTo(shortFeatures[9], 4);
      // x11 (PSAR reversal status)
      expect(longFeatures[10]).toBe(shortFeatures[10]); // 1
    });
  });

  describe('T3.2: Honest Quant Trainer (Zero Fabrication & Filtering)', () => {
    it('trains on real side-aware features or legacy SHORT, skipping trades without features or legacy LONG', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log');

      // Prepare 35 closed trades to meet the 30 closedTrades minimum
      const sampleFeatures = [1, 25, 2.5, 4.0, 8.0, 1, 0.5, 0.4, 1, 3.0, 1];
      const virtualTrades: any[] = [];

      // 15 legacy SHORT trades with features (valid for training)
      for (let i = 0; i < 15; i++) {
        virtualTrades.push({
          id: `t_short_${i}`,
          status: 'CLOSED',
          side: 'SHORT',
          features: [...sampleFeatures],
          pnlPercent: 2.0,
          outcome: 1
        });
      }

      // 10 new side-aware LONG trades with featuresVersion: 2 (valid for training)
      for (let i = 0; i < 10; i++) {
        virtualTrades.push({
          id: `t_long_v2_${i}`,
          status: 'CLOSED',
          side: 'LONG',
          featuresVersion: 2,
          features: [...sampleFeatures],
          pnlPercent: -1.5,
          outcome: 0
        });
      }

      // 6 legacy LONG trades without featuresVersion (MUST BE SKIPPED as inverted legacy)
      for (let i = 0; i < 6; i++) {
        virtualTrades.push({
          id: `t_long_legacy_${i}`,
          status: 'CLOSED',
          side: 'LONG',
          features: [...sampleFeatures],
          pnlPercent: 3.0,
          outcome: 1
        });
      }

      // 5 trades without features (MUST BE SKIPPED, NO FABRICATION)
      for (let i = 0; i < 5; i++) {
        virtualTrades.push({
          id: `t_no_feat_${i}`,
          status: 'CLOSED',
          side: 'SHORT',
          features: undefined,
          pnlPercent: 4.0,
          signalAiScore: 85
        });
      }

      let savedWeights: any = null;
      const trainerCtx: QuantModelTrainerContext = {
        getModelStatus: () => ({ isTrainingActive: false, lastRetrained: 0, totalLearnedTrades: 0 }),
        getModelWeights: () => ({
          beta0: 0.1, beta1: 0.2, beta2: 0.1, beta3: 0.05,
          beta4: 0.05, beta5: 0.05, beta6: 0.1, beta7: 0.1,
          beta8: 0.2, beta9: 0.2, beta10: 0.1, beta11: 0.2
        }),
        setModelWeights: (w) => { savedWeights = w; },
        getVirtualTrades: () => virtualTrades,
        getAiKnowledgeBase: () => [],
        saveKnowledgeDB: vi.fn().mockResolvedValue(undefined),
        saveSettings: vi.fn(),
        deadZonePct: 0.05
      };

      await trainQuantModel(trainerCtx);

      // Verify trainer logging format: [TRAINER] used=<n> skippedNoFeatures=<n> skippedLegacyLong=<n>
      const trainerLog = consoleLogSpy.mock.calls
        .map(call => call.join(' '))
        .find(msg => msg.includes('[TRAINER] used='));

      expect(trainerLog).toBeDefined();
      expect(trainerLog).toContain('used=25'); // 15 valid short + 10 valid v2 long = 25
      expect(trainerLog).toContain('skippedNoFeatures=5'); // 5 trades without features
      expect(trainerLog).toContain('skippedLegacyLong=6'); // 6 legacy long trades

      // Crucial: trades without features were NOT mutated with fabricated synthetic features
      const noFeatTrade = virtualTrades.find(t => t.id === 't_no_feat_0');
      expect(noFeatTrade.features).toBeUndefined();

      consoleLogSpy.mockRestore();
    });
  });

  describe('T3.3: Model Boundaries & Weight Clipping', () => {
    it('clipModelWeight clamps values to [-MODEL_WEIGHT_ABS_MAX, +MODEL_WEIGHT_ABS_MAX] and logs clipping', () => {
      const consoleLogSpy = vi.spyOn(console, 'log');

      expect(clipModelWeight(1.5, 'beta1')).toBe(1.5);
      expect(clipModelWeight(-0.8, 'beta2')).toBe(-0.8);

      // Excessively large weights from drift
      expect(clipModelWeight(14.8, 'beta4')).toBe(MODEL_WEIGHT_ABS_MAX);
      expect(clipModelWeight(-12.5, 'beta2')).toBe(-MODEL_WEIGHT_ABS_MAX);

      const clipLogs = consoleLogSpy.mock.calls
        .map(call => call.join(' '))
        .filter(msg => msg.includes('[MODEL] weight clipped'));

      expect(clipLogs).toHaveLength(2);
      expect(clipLogs[0]).toContain('beta4 14.8000 -> 5');
      expect(clipLogs[1]).toContain('beta2 -12.5000 -> -5');

      consoleLogSpy.mockRestore();
    });
  });
});
