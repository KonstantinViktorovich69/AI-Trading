import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { fetchMexcTickersDirect, fetchWeexTickersDirect } from './directExchangeFetchers.ts';

describe('directExchangeFetchers', () => {
  let originalHttpsGet: typeof https.get;

  beforeEach(() => {
    originalHttpsGet = https.get;
  });

  afterEach(() => {
    https.get = originalHttpsGet;
    vi.restoreAllMocks();
  });

  it('fetchMexcTickersDirect parses valid response and populates fallback map', async () => {
    const mockRes = new EventEmitter() as any;
    const mockReq = new EventEmitter() as any;
    mockReq.destroy = vi.fn();

    vi.spyOn(https, 'get').mockImplementation((options: any, callback: any) => {
      callback(mockRes);
      setTimeout(() => {
        mockRes.emit('data', JSON.stringify({
          success: true,
          data: [
            {
              symbol: 'BTC_USDT',
              lastPrice: 65000,
              bid1: 64990,
              ask1: 65010,
              volume24: 1000,
              amount24: 65000000,
              high24Price: 66000,
              lower24Price: 64000,
              riseFallRate: 0.05
            }
          ]
        }));
        mockRes.emit('end');
      }, 5);
      return mockReq;
    });

    const result = await fetchMexcTickersDirect();
    expect(result['BTC/USDT:USDT']).toBeDefined();
    expect(result['BTC/USDT:USDT'].last).toBe(65000);
    expect(result['BTC/USDT:USDT'].percentage).toBe(5);
    expect((globalThis as any).MEXC_SPOT_TICKERS['BTC_USDT']).toBeDefined();
  });

  it('fetchWeexTickersDirect parses valid response array', async () => {
    const mockRes = new EventEmitter() as any;
    const mockReq = new EventEmitter() as any;
    mockReq.destroy = vi.fn();

    vi.spyOn(https, 'get').mockImplementation((options: any, callback: any) => {
      callback(mockRes);
      setTimeout(() => {
        mockRes.emit('data', JSON.stringify([
          {
            symbol: 'BTCUSDT',
            lastPrice: '65500',
            highPrice: '66500',
            lowPrice: '64500',
            openPrice: '64000',
            priceChangePercent: '2.34',
            priceChange: '1500',
            volume: '500',
            quoteVolume: '32750000',
            markPrice: '65505',
            indexPrice: '65500'
          }
        ]));
        mockRes.emit('end');
      }, 5);
      return mockReq;
    });

    const result = await fetchWeexTickersDirect();
    expect(result['BTC/USDT:USDT']).toBeDefined();
    expect(result['BTC/USDT:USDT'].last).toBe(65500);
    expect(result['BTC/USDT:USDT'].percentage).toBe(2.34);
  });
});
