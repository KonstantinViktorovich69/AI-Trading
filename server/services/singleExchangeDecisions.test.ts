import { describe, it, expect, vi } from 'vitest';
import { manageActiveTrades, VirtualTradeEngineDependencies } from './virtualTradeEngine.ts';
import { calculateConfidenceProbability, executeScrapeSocialSentiment, QuantRiskEngineContext } from './quantRiskEngine.ts';
import { filterValidSignals } from './signalEngine.ts';
import { TRADING_SETTINGS_WHITELIST } from './buildInfo.ts';
import type { SignalData } from '../types/trading.ts';

describe('Single Exchange (WEEX Only) Decisions & Strategy Isolation', () => {
  describe('1. Price resolution in virtualTradeEngine is strictly WEEX', () => {
    it('does not update trade price or trigger exits if WEEX has no ticker, even if Binance/MEXC have prices', async () => {
      const sampleTrade: any = {
        id: 'trade_weex_isolation_1',
        symbol: 'BTC/USDT',
        side: 'SHORT',
        entryPrice: 65000,
        currentPrice: 65000,
        amount: 100,
        leverage: 10,
        status: 'OPEN',
        openTime: Date.now() - 60000,
        stopLoss: 66000,
        takeProfit: 63000
      };

      const mockDeps: VirtualTradeEngineDependencies = {
        getVirtualTrades: () => [sampleTrade],
        getGlobalSettings: () => ({ exchangeApiConfig: { exchange: 'weex' } }),
        // Binance and MEXC have tickers, but WEEX is missing/empty
        getGlobalCcxtTickers: () => ({
          binance: {
            'BTC/USDT': { last: 70000, bid: 69990, ask: 70010, close: 70000 }
          },
          mexc: {
            'BTC/USDT:USDT': { last: 70000, bid: 69990, ask: 70010, close: 70000 }
          },
          weex: {}
        }),
        getWsTickers: () => ({
          Binance: {
            'BTC/USDT': { last: 70000, bid: 69990, ask: 70010, close: 70000 }
          },
          Mexc: {
            'BTC/USDT:USDT': { last: 70000, bid: 69990, ask: 70010, close: 70000 }
          },
          Weex: {}
        }),
        getGlobalTrueOhlcv: () => ({}),
        getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 50 }),
        getAiKnowledgeBase: () => [],
        getVirtualBalance: () => 1000,
        setVirtualBalance: vi.fn(),
        getStartOfDayRealBalance: () => 1000,
        setStartOfDayRealBalance: vi.fn(),
        getStartOfWeekBalance: () => 1000,
        setStartOfWeekBalance: vi.fn(),
        isCircuitBreakerActive: () => false,
        triggerCircuitBreaker: vi.fn(),
        getCcxtClient: vi.fn(),
        fetchCachedRealBalance: vi.fn(),
        saveTradeDB: vi.fn(),
        saveBalanceDB: vi.fn(),
        saveKnowledgeDB: vi.fn(),
        sendTelegramMessage: vi.fn(),
        emitSignalsUpdated: vi.fn(),
        executeRealCloseOnExchange: vi.fn(),
        executeRealPartialCloseOnExchange: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        setRealTradeSlTpOnExchange: vi.fn().mockResolvedValue(true),
        runAiGeneration: vi.fn().mockResolvedValue({ text: '{}' })
      };

      await manageActiveTrades(mockDeps);

      // Trade must NOT have taken the 70000 price from Binance/MEXC!
      expect(sampleTrade.currentPrice).toBe(65000);
      expect(sampleTrade.status).toBe('OPEN');
    });

    it('takes the WEEX price even when Binance and MEXC have different prices', async () => {
      const sampleTrade: any = {
        id: 'trade_weex_isolation_2',
        symbol: 'BTC/USDT',
        side: 'SHORT',
        entryPrice: 65000,
        currentPrice: 65000,
        amount: 100,
        leverage: 10,
        status: 'OPEN',
        openTime: Date.now() - 60000,
        stopLoss: 66000,
        takeProfit: 63000
      };

      const mockDeps: VirtualTradeEngineDependencies = {
        getVirtualTrades: () => [sampleTrade],
        getGlobalSettings: () => ({ exchangeApiConfig: { exchange: 'weex' } }),
        getGlobalCcxtTickers: () => ({
          binance: {
            'BTC/USDT': { last: 70000, bid: 69990, ask: 70010, close: 70000 }
          },
          weex: {
            'BTC/USDT:USDT': { last: 64200, bid: 64190, ask: 64210, close: 64200 }
          }
        }),
        getWsTickers: () => ({}),
        getGlobalTrueOhlcv: () => ({}),
        getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 50 }),
        getAiKnowledgeBase: () => [],
        getVirtualBalance: () => 1000,
        setVirtualBalance: vi.fn(),
        getStartOfDayRealBalance: () => 1000,
        setStartOfDayRealBalance: vi.fn(),
        getStartOfWeekBalance: () => 1000,
        setStartOfWeekBalance: vi.fn(),
        isCircuitBreakerActive: () => false,
        triggerCircuitBreaker: vi.fn(),
        getCcxtClient: vi.fn(),
        fetchCachedRealBalance: vi.fn(),
        saveTradeDB: vi.fn(),
        saveBalanceDB: vi.fn(),
        saveKnowledgeDB: vi.fn(),
        sendTelegramMessage: vi.fn(),
        emitSignalsUpdated: vi.fn(),
        executeRealCloseOnExchange: vi.fn(),
        executeRealPartialCloseOnExchange: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        setRealTradeSlTpOnExchange: vi.fn().mockResolvedValue(true),
        runAiGeneration: vi.fn().mockResolvedValue({ text: '{}' })
      };

      await manageActiveTrades(mockDeps);

      expect(sampleTrade.currentPrice).toBe(64200);
    });
  });

  describe('2. quantRiskEngine features x6 and social hype read from WEEX', () => {
    it('calculates x6 volume spike using WEEX ticker and ignores Binance', () => {
      const mockContext: QuantRiskEngineContext = {
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
          // Binance has huge volume, but WEEX has moderate volume
          binance: {
            'BTC/USDT': { quoteVolume: 999999999 }
          },
          weex: {
            'BTC/USDT:USDT': { quoteVolume: 2400000 } // avgHourly = 100,000
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

      // volume = 200,000 > 100,000 * 1.5 -> x6 must be 1 based on WEEX quoteVolume
      const resSpike = calculateConfidenceProbability('BTCUSDT', 65000, 200000, mockContext);
      expect(resSpike.features[5]).toBe(1);

      // volume = 120,000 < 100,000 * 1.5 -> x6 must be 0 based on WEEX quoteVolume
      const resNoSpike = calculateConfidenceProbability('BTCUSDT', 65000, 120000, mockContext);
      expect(resNoSpike.features[5]).toBe(0);
    });

    it('reads social hype change from WEEX globalCcxtTickers and ignores Binance wsTickers', async () => {
      const socialSentimentCache: Record<string, any> = {};
      const mockContext: QuantRiskEngineContext = {
        getGlobalTrueOHLCV: () => ({}),
        getGlobalCcxtTickers: () => ({
          weex: {
            'SOL/USDT:USDT': {
              percentage: 20, // > 15% -> PUMP_HYPE
              quoteVolume: 5000000
            }
          }
        }),
        getWsTickers: () => ({
          Binance: {
            'SOL/USDT': { change: -5, quoteVolume: 1000 } // Opposite direction on Binance
          }
        }),
        getOrderBookImbalance: () => ({}),
        getModelWeights: () => ({}),
        getAiKnowledgeBase: () => [],
        getMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0, recommendation: '', lastUpdated: Date.now() }),
        setMarketPulse: vi.fn(),
        getSocialSentimentCache: () => socialSentimentCache,
        getSignalsCache: () => null,
        getGlobalLiquidations: () => ({}),
        safeJsonParse: vi.fn()
      };

      const result = await executeScrapeSocialSentiment('SOL/USDT', mockContext);
      expect(result.trend).toBe('PUMP_HYPE');
      expect(result.score).toBe(82);
    });
  });

  describe('3. Binance cross-listing filter removal', () => {
    it('signal passes filterValidSignals based strictly on volume/change without cross-listing checks', () => {
      const signals: SignalData[] = [
        {
          symbol: 'BTCUSDT',
          exchange: 'weex',
          price: 65000,
          change24h: 3.5,
          volume24h: 1000000,
          signal: 'SHORT',
          aiScore: 85,
          timestamp: Date.now()
        },
        {
          symbol: 'LOWVOLUSDT',
          exchange: 'weex',
          price: 1.0,
          change24h: 1.0,
          volume24h: 10000, // < 50,000 and abs(change) < 15% -> filtered out
          signal: 'SHORT',
          aiScore: 80,
          timestamp: Date.now()
        }
      ];

      const filtered = filterValidSignals(signals, 50000);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].symbol).toBe('BTCUSDT');
      expect((filtered[0] as any).isBinanceCrossListed).toBeUndefined();
    });
  });

  describe('4. buildInfo TRADING_SETTINGS_WHITELIST', () => {
    it('contains the 4 session settings and does not contain excludeBinanceCrossListed', () => {
      expect(TRADING_SETTINGS_WHITELIST).toContain('isSessionFilterEnabled');
      expect(TRADING_SETTINGS_WHITELIST).toContain('allowedSessions');
      expect(TRADING_SETTINGS_WHITELIST).toContain('blockedHoursUtc');
      expect(TRADING_SETTINGS_WHITELIST).toContain('sessionAdaptiveScoreBoost');
      expect(TRADING_SETTINGS_WHITELIST).not.toContain('excludeBinanceCrossListed');

      // Verify alphabetical order
      const sorted = [...TRADING_SETTINGS_WHITELIST].sort();
      expect([...TRADING_SETTINGS_WHITELIST]).toEqual(sorted);
    });
  });
});
