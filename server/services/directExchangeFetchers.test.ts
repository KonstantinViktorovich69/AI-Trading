import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { fetchWeexTickersDirect } from './directExchangeFetchers.ts';

describe('directExchangeFetchers', () => {
  let originalHttpsGet: typeof https.get;

  beforeEach(() => {
    originalHttpsGet = https.get;
  });

  afterEach(() => {
    https.get = originalHttpsGet;
    vi.restoreAllMocks();
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
