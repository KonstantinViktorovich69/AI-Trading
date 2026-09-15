import { describe, it, expect, vi } from 'vitest';
import { MarketDataHubService } from './marketDataHubService.ts';

describe('MarketDataHubService', () => {
  it('correctly initializes exchanges, symbols, and provides findTickerInMap', async () => {
    const mockDeps: any = {
      getGlobalCcxtTickers: () => ({}),
      getWsTickers: () => ({ Weex: {}, Binance: {}, Bybit: {}, Mexc: {} }),
      getApiHealth: () => ({}),
      getGlobalLiquidations: () => ({}),
      getGlobalWhales: () => ({}),
      getGlobalPumps: () => new Set<string>(),
      getGlobalCvd: () => ({}),
      getCacheSignals: () => ({}),
      getVirtualTrades: () => [],
      updateSignalsCache: vi.fn(),
      updateTrueOHLCV: vi.fn(),
      updateLocalCandlesForSymbol: vi.fn(),
      emitPriceUpdate: vi.fn(),
      logStructured: vi.fn()
    };

    const hub = new MarketDataHubService(mockDeps);
    expect(hub.getPairs().length).toBeGreaterThan(10);
    expect(hub.getCcxtExchanges().weex).toBeDefined();
    expect(hub.getExchangeInstance('binance')).toBeDefined();

    // Test findTickerInMap variations
    const tickers = {
      'BTC/USDT': { last: 65000 },
      'ETH_USDT': { last: 3500 },
      'SOLUSDT': { last: 150 }
    };

    expect(hub.findTickerInMap('BTC/USDT', tickers)?.last).toBe(65000);
    expect(hub.findTickerInMap('ETH/USDT', tickers)?.last).toBe(3500);
    expect(hub.findTickerInMap('SOL/USDT', tickers)?.last).toBe(150);
    expect(hub.findTickerInMap('NONEXISTENT/USDT', tickers)).toBeNull();

    // Test getExchangeLink
    const link = hub.getExchangeLink('weex', 'BTC/USDT');
    expect(link).toContain('weex.com');

    // Test cleanSymbol and normalizeSymbol
    expect(hub.cleanSymbol('BTC/USDT:USDT')).toBe('BTCUSDT');
    expect(hub.normalizeSymbol('BTC_USDT')).toBe('BTCUSDT');

    // Test getTickerSyncContext
    const ctx = hub.getTickerSyncContext();
    expect(ctx.getCcxtExchanges()).toBe(hub.getCcxtExchanges());
    expect(ctx.isBinanceGeoblocked()).toBe(false);
    ctx.setBinanceGeoblocked(true);
    expect(hub.getIsBinanceGeoblocked()).toBe(true);

    // Test price emission throttling
    hub.throttlePriceEmit();
    expect(mockDeps.emitPriceUpdate).toHaveBeenCalled();

    // Test offline market initialization
    process.env.TEST_MODE = '1';
    await hub.initMarkets();
  });
});
