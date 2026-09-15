import { describe, it, expect, vi } from 'vitest';
import {
  calculateEMA,
  recalculateIndicatorsForSymbol,
  updateLocalCandlesForSymbol,
  getWallAdjustedTp,
  updateDerivativesData,
  checkOrderBooks,
  MarketDataCollectorContext
} from '../../server/services/marketDataCollectorService.ts';

function createMockContext(overrides?: Partial<MarketDataCollectorContext>): MarketDataCollectorContext {
  const globalTrueOHLCV: Record<string, any> = {};
  const globalRawOHLCV: Record<string, any> = {};
  const globalCcxtTickers: Record<string, Record<string, any>> = {};
  const globalATR: Record<string, number> = {};
  const globalADX: Record<string, number> = {};
  const globalDerivatives: { fundingRates: any } = { fundingRates: {} };
  const fundingRates: Record<string, number> = {};
  const openInterests: Record<string, number> = {};
  const orderBookImbalance: Record<string, any> = {};
  const globalOrderBookHistory: Record<string, any[]> = {};
  const cacheSignals: any = { data: [] };
  const virtualTrades: any[] = [];
  let isBinanceGeoblocked = false;

  const defaultCtx: MarketDataCollectorContext = {
    getGlobalTrueOHLCV: () => globalTrueOHLCV,
    getGlobalRawOHLCV: () => globalRawOHLCV,
    getGlobalCcxtTickers: () => globalCcxtTickers,
    getGlobalATR: () => globalATR,
    getGlobalADX: () => globalADX,
    getGlobalDerivatives: () => globalDerivatives,
    getFundingRates: () => fundingRates,
    getOpenInterests: () => openInterests,
    getOrderBookImbalance: () => orderBookImbalance,
    getGlobalOrderBookHistory: () => globalOrderBookHistory,
    getCacheSignals: () => cacheSignals,
    getVirtualTrades: () => virtualTrades,
    getCcxtExchange: () => null,
    isBinanceGeoblocked: () => isBinanceGeoblocked,
    setBinanceGeoblocked: (val: boolean) => { isBinanceGeoblocked = val; },
    isMainThread: () => true,
    ...overrides
  };

  return defaultCtx;
}

describe('MarketDataCollectorService', () => {
  describe('calculateEMA', () => {
    it('calculates exponential moving average correctly', () => {
      expect(calculateEMA([], 10)).toBe(0);
      expect(calculateEMA([100], 10)).toBe(100);
      
      const values = [10, 11, 12, 13, 14, 15];
      const ema = calculateEMA(values, 3);
      expect(ema).toBeGreaterThan(12);
      expect(ema).toBeLessThan(15);
    });
  });

  describe('recalculateIndicatorsForSymbol', () => {
    it('computes RSI, MACD, BB, PSAR, and wicks from raw candles', () => {
      const ctx = createMockContext();
      const rawOHLCV = ctx.getGlobalRawOHLCV();
      
      // Generate 30 15m candles
      const baseTime = Date.now() - 30 * 15 * 60000;
      const candles15m: number[][] = [];
      for (let i = 0; i < 35; i++) {
        const time = baseTime + i * 15 * 60000;
        const open = 100 + i;
        const high = 105 + i;
        const low = 98 + i;
        const close = 103 + i;
        const volume = 1000 + i * 10;
        candles15m.push([time, open, high, low, close, volume]);
      }

      rawOHLCV['BTCUSDT'] = {
        '15m': candles15m,
        '1m': []
      };

      recalculateIndicatorsForSymbol('BTCUSDT', ctx);

      const trueOHLCV = ctx.getGlobalTrueOHLCV();
      expect(trueOHLCV['BTCUSDT']).toBeDefined();
      expect(trueOHLCV['BTCUSDT'].rsi1h).toBeGreaterThan(0);
      expect(trueOHLCV['BTCUSDT'].macd1h).toBeDefined();
      expect(trueOHLCV['BTCUSDT'].bb1h).toBeDefined();
      expect(trueOHLCV['BTCUSDT'].wicks).toBeDefined();
      expect(trueOHLCV['BTCUSDT'].wicks.topPct).toBeGreaterThanOrEqual(0);
    });
  });

  describe('updateLocalCandlesForSymbol', () => {
    it('updates current candle close and triggers indicator recalculation', () => {
      const ctx = createMockContext();
      const rawOHLCV = ctx.getGlobalRawOHLCV();
      
      const now = Date.now();
      const bucket15m = Math.floor(now / (15 * 60000)) * (15 * 60000);
      
      const candles15m: number[][] = [];
      for (let i = 0; i < 30; i++) {
        candles15m.push([bucket15m - (30 - i) * 15 * 60000, 100, 105, 95, 102, 500]);
      }
      candles15m.push([bucket15m, 102, 103, 101, 102, 100]);

      rawOHLCV['ETHUSDT'] = {
        '15m': candles15m,
        '1m': [[Math.floor(now / 60000) * 60000, 102, 103, 101, 102, 100]]
      };

      updateLocalCandlesForSymbol('ETHUSDT', 110, 50, ctx);

      const last15 = candles15m[candles15m.length - 1];
      expect(last15[4]).toBe(110); // Close updated
      expect(last15[2]).toBe(110); // High updated
      
      const trueOHLCV = ctx.getGlobalTrueOHLCV();
      expect(trueOHLCV['ETHUSDT']).toBeDefined();
    });
  });

  describe('getWallAdjustedTp', () => {
    it('returns targetTpPrice if not a sell/short signal', () => {
      const ctx = createMockContext();
      const tp = getWallAdjustedTp('BTC/USDT', false, 100, 95, ctx);
      expect(tp).toBe(95);
    });

    it('adjusts TP upward to front-run large bid wall on SHORT position', () => {
      const ctx = createMockContext();
      const obImbalance = ctx.getOrderBookImbalance();
      obImbalance['BTCUSDT'] = {
        walls: [
          { type: 'bid', price: 99.0, size: 50000, distancePct: 1.0 }
        ]
      };

      // Current price is 100, target TP is 95, bid wall is at 99.0 (within 1.5% range)
      // Adjusted TP should front-run at 99.0 * 1.0005 = 99.0495
      const tp = getWallAdjustedTp('BTCUSDT', true, 100, 95, ctx);
      expect(tp).toBe(99.0495);
    });

    it('keeps targetTpPrice if no bid walls are between current price and TP', () => {
      const ctx = createMockContext();
      const obImbalance = ctx.getOrderBookImbalance();
      obImbalance['SOLUSDT'] = {
        walls: [
          { type: 'bid', price: 90.0, size: 50000, distancePct: 10.0 }
        ]
      };

      const tp = getWallAdjustedTp('SOLUSDT', true, 100, 95, ctx);
      expect(tp).toBe(95);
    });
  });

  describe('checkOrderBooks', () => {
    it('parses order book bids, asks, and detects icebergs and imbalances', async () => {
      const mockWeex = {
        fetchOrderBook: vi.fn().mockResolvedValue({
          bids: [
            [99.5, 100],
            [99.0, 500], // Large bid size
            [98.5, 20]
          ],
          asks: [
            [100.5, 50],
            [101.0, 30]
          ]
        })
      };

      const ctx = createMockContext({
        getCcxtExchange: () => mockWeex,
        getCacheSignals: () => ({
          data: [{ symbol: 'BTCUSDT', price: 100 }]
        })
      });

      await checkOrderBooks(ctx);

      const obData = ctx.getOrderBookImbalance()['BTCUSDT'];
      expect(obData).toBeDefined();
      expect(obData.bidVolume).toBeGreaterThan(0);
      expect(obData.askVolume).toBeGreaterThan(0);
      expect(obData.walls).toBeDefined();
    });
  });
});
