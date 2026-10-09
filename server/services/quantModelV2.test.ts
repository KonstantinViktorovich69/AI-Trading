import { describe, it, expect, beforeEach } from 'vitest';
import { computeQuantFeaturesV2 } from './quantFeaturesV2.ts';
import {
  trainQuantModelV2,
  calculateProbabilityV2IfAccepted,
  getQuantModelV2Status,
  getQuantModelV2ShadowReport,
  calculateAuc,
  calculateLogLoss,
  calculateBrierScore,
  resetQuantModelV2ForTest
} from './quantModelV2.ts';
import { calculateConfidenceProbability } from './quantRiskEngine.ts';

describe('Quant Model V2 (Промт 4/4)', () => {
  beforeEach(() => {
    resetQuantModelV2ForTest();
  });

  describe('Блок A: computeQuantFeaturesV2', () => {
    it('находит индикаторы по различным представлениям символа (TREE/USDT:USDT, TREEUSDT, TREE/USDT)', () => {
      const mockIndicators = {
        is48hBreakout: 1,
        rsi1h: 65,
        macdHistogram: 0.5,
        ema50: 98,
        ema200: 95,
        vwap: 99,
        psarStatus: 'BEARISH'
      };

      // 1. True OHLCV stores key as 'TREEUSDT' (normalized/clean)
      const trueOhlcv = {
        TREEUSDT: mockIndicators
      };

      const res1 = computeQuantFeaturesV2({
        symbol: 'TREE/USDT:USDT',
        price: 100,
        volume: 5000,
        trueOhlcv
      });
      expect(res1.hadIndicators).toBe(true);
      expect(res1.keyUsed).toBe('TREEUSDT');
      expect(res1.features[0]).toBe(1); // breakout
      expect(res1.features[1]).toBe(15); // rsi - 50 = 65 - 50 = 15
      expect(res1.features[10]).toBe(1); // psar BEARISH -> 1

      // 2. Querying with 'TREE/USDT'
      const res2 = computeQuantFeaturesV2({
        symbol: 'TREE/USDT',
        price: 100,
        volume: 5000,
        trueOhlcv
      });
      expect(res2.hadIndicators).toBe(true);
      expect(res2.keyUsed).toBe('TREEUSDT');

      // 3. Querying with exact key 'TREEUSDT'
      const res3 = computeQuantFeaturesV2({
        symbol: 'TREEUSDT',
        price: 100,
        volume: 5000,
        trueOhlcv
      });
      expect(res3.hadIndicators).toBe(true);
      expect(res3.keyUsed).toBe('TREEUSDT');
    });

    it('считает x6 по тикеру WEEX (quoteVolume / 24)', () => {
      const trueOhlcv = {
        TREEUSDT: { rsi1h: 50 }
      };

      // WEEX ticker has 24h quote volume = 24000 USDT -> avg hourly = 1000 USDT
      const tickers = {
        weex: {
          'TREE/USDT': { quoteVolume: 24000 }
        }
      };

      // volume = 1200 <= 1000 * 1.5 -> x6 = 0
      const resBelow = computeQuantFeaturesV2({
        symbol: 'TREE/USDT:USDT',
        price: 100,
        volume: 1200,
        trueOhlcv,
        tickers
      });
      expect(resBelow.features[5]).toBe(0);

      // volume = 1800 > 1000 * 1.5 -> x6 = 1
      const resAbove = computeQuantFeaturesV2({
        symbol: 'TREE/USDT:USDT',
        price: 100,
        volume: 1800,
        trueOhlcv,
        tickers
      });
      expect(resAbove.features[5]).toBe(1);
    });

    it('если индикаторов нет — hadIndicators=false и features остаются нулями', () => {
      const res = computeQuantFeaturesV2({
        symbol: 'NONEXISTENT/USDT:USDT',
        price: 100,
        volume: 5000,
        trueOhlcv: {}
      });
      expect(res.hadIndicators).toBe(false);
      expect(res.keyUsed).toBeUndefined();
      expect(res.features).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe('Блок C: trainQuantModelV2 и метрики', () => {
    it('отказ при n < 200 (INSUFFICIENT_DATA)', () => {
      const mockTrades: any[] = [];
      for (let i = 0; i < 50; i++) {
        mockTrades.push({
          id: `t_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          entryDiagnostics: {
            featuresV2HadIndicators: true,
            featuresV2: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
          }
        });
      }

      const res = trainQuantModelV2(mockTrades);
      expect(res.status).toBe('INSUFFICIENT_DATA');
      expect(res.accepted).toBe(false);
    });

    it('хронологическое разбиение без пересечений и исключение gapAffected', () => {
      const now = Date.now();
      const mockTrades: any[] = [];

      for (let i = 0; i < 220; i++) {
        mockTrades.push({
          id: `t_${i}`,
          status: 'CLOSED',
          isPaper: true,
          // 20 trades are gapAffected and must be excluded
          gapAffected: i % 11 === 0,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          openTime: now + i * 60000,
          closeTime: now + i * 60000 + 30000,
          entryDiagnostics: {
            featuresV2HadIndicators: true,
            featuresV2: [i % 2, (i % 10) - 5, 0, 0, 0, 0, 0, 0, 0, 0, 0]
          }
        });
      }

      const res = trainQuantModelV2(mockTrades);
      // 220 minus 20 gapAffected = 200 eligible trades!
      expect(res.nTrain + res.nVal).toBe(200);
      expect(res.nTrain).toBe(140); // 70% of 200
      expect(res.nVal).toBe(60);   // 30% of 200
    });

    it('проверка acceptance criteria: accepted=true при наличии явного сигнала и false на чистом шуме', () => {
      const now = Date.now();

      // 1. Dataset with clear predictable signal: feature[0] predicts outcome
      const predictiveTrades: any[] = [];
      for (let i = 0; i < 250; i++) {
        const signal = i % 2 === 0 ? 1 : -1;
        const isWin = signal > 0;
        predictiveTrades.push({
          id: `pred_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: isWin ? 'TAKE_PROFIT' : 'STOP_LOSS',
          entryPrice: 100,
          closePrice: isWin ? 104 : 96,
          amount: 10,
          leverage: 5,
          pnl: isWin ? 2.0 : -2.0,
          openTime: now + i * 60000,
          closeTime: now + i * 60000 + 30000,
          entryDiagnostics: {
            featuresV2HadIndicators: true,
            featuresV2: [signal * 5, signal * 2, signal, 0, 0, 0, 0, 0, 0, 0, 0]
          }
        });
      }

      const predResult = trainQuantModelV2(predictiveTrades);
      expect(predResult.metrics).toBeDefined();
      expect(predResult.metrics!.auc).toBeGreaterThanOrEqual(0.55);
      expect(predResult.metrics!.logLossImprovement).toBeGreaterThan(0.005);
      expect(predResult.accepted).toBe(true);

      // calculateProbabilityV2IfAccepted should return probability when accepted
      const p = calculateProbabilityV2IfAccepted([5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0], true);
      expect(typeof p).toBe('number');
      expect(p!).toBeGreaterThan(0.5);

      // 2. Dataset with pure uniform noise where signal is zero
      const noiseTrades: any[] = [];
      for (let i = 0; i < 250; i++) {
        const isWin = i % 2 === 0;
        noiseTrades.push({
          id: `noise_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: isWin ? 'TAKE_PROFIT' : 'STOP_LOSS',
          entryPrice: 100,
          closePrice: isWin ? 101 : 99,
          amount: 10,
          leverage: 5,
          pnl: isWin ? 0.5 : -0.5,
          openTime: now + i * 60000,
          closeTime: now + i * 60000 + 30000,
          entryDiagnostics: {
            featuresV2HadIndicators: true,
            featuresV2: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
          }
        });
      }

      const noiseResult = trainQuantModelV2(noiseTrades);
      expect(noiseResult.accepted).toBe(false);
    });

    it('calculateAuc, calculateLogLoss, calculateBrierScore math sanity', () => {
      const labels = [1, 1, 0, 0];
      const perfectPreds = [0.9, 0.8, 0.2, 0.1];
      expect(calculateAuc(labels, perfectPreds)).toBe(1.0);
      expect(calculateLogLoss(labels, perfectPreds)).toBeLessThan(0.3);
      expect(calculateBrierScore(labels, perfectPreds)).toBeLessThan(0.05);

      const invertedPreds = [0.1, 0.2, 0.8, 0.9];
      expect(calculateAuc(labels, invertedPreds)).toBe(0.0);
    });
  });

  describe('Блок D: Статус и Shadow Report', () => {
    it('getQuantModelV2Status and getQuantModelV2ShadowReport produce valid structures', () => {
      const mockTrades = [
        {
          id: 't_diag_1',
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          entryDiagnostics: {
            featuresV2HadIndicators: true,
            quantP: 0.52,
            quantPV2: 0.65
          }
        }
      ];

      const status = getQuantModelV2Status(mockTrades);
      expect(status.totalTrades).toBe(1);
      expect(status.recent200CoveragePct).toBe(100);

      const report = getQuantModelV2ShadowReport(mockTrades);
      expect(report.evaluatedTrades).toBe(1);
      expect(report.decilesV2.length).toBe(10);
    });
  });

  describe('Регрессия: Старая модель (calculateConfidenceProbability) осталась нетронутой', () => {
    it('calculateConfidenceProbability works exactly as before with legacy context', () => {
      const mockCtx: any = {
        getGlobalTrueOHLCV: () => ({
          'TREE/USDT:USDT': {
            is48hBreakout: 1,
            rsi1h: 60,
            macdHistogram: 0.1,
            ema50: 99,
            ema200: 95,
            vwap: 99.5,
            psarStatus: 'BEARISH'
          }
        }),
        getGlobalCcxtTickers: () => ({
          mexc: {},
          binance: {}
        }),
        getOrderBookImbalance: () => ({}),
        getModelWeights: () => ({
          beta0: 0,
          beta1: 0,
          beta2: 0,
          beta3: 0,
          beta4: 0,
          beta5: 0,
          beta6: 0,
          beta7: 0,
          beta8: 0,
          beta9: 0,
          beta10: 0,
          beta11: 0
        }),
        getAiKnowledgeBase: () => []
      };

      const res = calculateConfidenceProbability('TREE/USDT:USDT', 100, 1000, mockCtx);
      expect(res.p).toBe(0.5);
      expect(res.features.length).toBe(11);
    });
  });
});
