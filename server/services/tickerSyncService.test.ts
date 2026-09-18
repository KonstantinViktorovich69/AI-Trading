import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExchangeLink, buildExchangeSymbolsMap, getTradingAdvice, syncGlobalTickers, type TickerSyncContext } from './tickerSyncService.ts';

describe('tickerSyncService', () => {
  it('getExchangeLink generates correct exchange URLs', () => {
    expect(getExchangeLink('binance', 'BTC/USDT')).toBe('https://www.binance.com/en/futures/BTCUSDT');
    expect(getExchangeLink('bybit', 'ETH/USDT')).toBe('https://www.bybit.com/en-US/trade/futures/usdt/ETHUSDT');
    expect(getExchangeLink('okx', 'SOL/USDT')).toBe('https://www.okx.com/trade-swap/SOL-USDT-SWAP');
    expect(getExchangeLink('mexc', 'BTC/USDT')).toBe('https://futures.mexc.com/exchange/BTC_USDT');
    expect(getExchangeLink('weex', 'PEPE/USDT')).toBe('https://www.weex.com/trade/1000PEPE_USDT');
    expect(getExchangeLink('weex', 'BTC/USDT')).toBe('https://www.weex.com/trade/BTC_USDT');
    expect(getExchangeLink('bitget', 'XRP/USDT')).toBe('https://www.bitget.com/mix/usdt/XRPUSDT_UMCBL');
  });

  it('buildExchangeSymbolsMap builds correct mappings for pairs', () => {
    const map = buildExchangeSymbolsMap(['BTC/USDT', 'ETH/USDT', 'DOGE/USDT']);
    expect(map.binance['BTC/USDT']).toBe('BTCUSDT');
    expect(map.kraken['BTC/USDT']).toBe('XBTUSDT');
    expect(map.kraken['DOGE/USDT']).toBe('XDGUSDT');
    expect(map.kucoin['ETH/USDT']).toBe('ETH-USDT');
    expect(map.weex['BTC/USDT']).toBe('BTC_USDT');
  });

  it('getTradingAdvice returns correct advice based on signal and type', () => {
    const shortParabola = getTradingAdvice('STRONG SELL', 'Парабола');
    expect(shortParabola).toContain('Совет по SHORT');
    expect(shortParabola).toContain('VWAP');

    const shortStopHunt = getTradingAdvice('SELL', 'Stop Hunt');
    expect(shortStopHunt).toContain('ложный пробой');

    const longDip = getTradingAdvice('BUY', 'Пролив');
    expect(longDip).toContain('Совет по LONG');
    expect(longDip).toContain('Паническая распродажа');
  });

  describe('syncGlobalTickers', () => {
    let mockContext: TickerSyncContext;
    let isFetchingState = false;
    let isInitialOhlcvState = false;
    let geoblockedState = false;
    let restBlocked: Set<string>;
    let globalCcxtTickers: Record<string, any>;
    let wsTickers: any;
    let apiHealth: Record<string, any>;

    beforeEach(() => {
      isFetchingState = false;
      isInitialOhlcvState = false;
      geoblockedState = false;
      restBlocked = new Set<string>();
      globalCcxtTickers = {};
      wsTickers = { Weex: {}, Binance: {}, Bybit: {}, Mexc: {} };
      apiHealth = {};

      const mockExchange = {
        options: {},
        fetchTickers: vi.fn().mockResolvedValue({
          'BTC/USDT': {
            symbol: 'BTC/USDT',
            last: 65000,
            bid: 64999,
            ask: 65001,
            percentage: 2.5
          }
        })
      };

      mockContext = {
        getCcxtExchanges: () => ({
          weex: mockExchange,
          binance: mockExchange,
          bybit: mockExchange
        }),
        getRestBlockedExchanges: () => restBlocked,
        isBinanceGeoblocked: () => geoblockedState,
        setBinanceGeoblocked: (v) => { geoblockedState = v; },
        getGlobalCcxtTickers: () => globalCcxtTickers,
        getWsTickers: () => wsTickers,
        getApiHealth: () => apiHealth,
        safeRedisSet: vi.fn(),
        updateSignalsCache: vi.fn(),
        updateTrueOHLCV: vi.fn(),
        emitPriceUpdate: vi.fn(),
        isFetching: () => isFetchingState,
        setIsFetching: (v) => { isFetchingState = v; },
        isInitialOhlcvFetched: () => isInitialOhlcvState,
        setInitialOhlcvFetched: (v) => { isInitialOhlcvState = v; },
        fetchWeexTickersDirect: vi.fn().mockResolvedValue({
          'BTC/USDT': {
            symbol: 'BTC/USDT',
            last: 50000,
            bid: 49999,
            ask: 50001,
            percentage: 2.5
          }
        }),
        fetchMexcTickersDirect: vi.fn().mockResolvedValue({})
      };
    });

    it('successfully syncs tickers and updates cache and signals', async () => {
      // Temporarily bypass test mode environment var for this test
      const originalTestMode = process.env.TEST_MODE;
      delete process.env.TEST_MODE;

      try {
        await syncGlobalTickers(mockContext, false);

        expect(mockContext.updateSignalsCache).toHaveBeenCalled();
        expect(mockContext.emitPriceUpdate).toHaveBeenCalled();
        expect(mockContext.updateTrueOHLCV).toHaveBeenCalled();
        expect(isInitialOhlcvState).toBe(true);
        expect(globalCcxtTickers.weex).toBeDefined();
        const btcTicker = globalCcxtTickers.weex['BTC/USDT:USDT'] || globalCcxtTickers.weex['BTC/USDT'] || Object.values(globalCcxtTickers.weex)[0];
        expect(btcTicker).toBeDefined();
        expect(btcTicker.last).toBe(50000);
        expect(btcTicker.symbol).toBe('BTC/USDT');
      } finally {
        if (originalTestMode) process.env.TEST_MODE = originalTestMode;
      }
    });

    it('does not re-enter if isFetching is true', async () => {
      isFetchingState = true;
      const originalTestMode = process.env.TEST_MODE;
      delete process.env.TEST_MODE;

      try {
        await syncGlobalTickers(mockContext, false);
        expect(mockContext.updateSignalsCache).not.toHaveBeenCalled();
      } finally {
        if (originalTestMode) process.env.TEST_MODE = originalTestMode;
      }
    });
  });
});
