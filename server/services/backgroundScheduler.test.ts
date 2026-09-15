import { describe, it, expect, vi } from 'vitest';
import { BackgroundSchedulerService, recordMarketHistory, type BackgroundSchedulerContext } from './backgroundScheduler.ts';

describe('backgroundScheduler service', () => {
  it('records ticker prices and funding history and prunes old memory', () => {
    const historyData: Record<string, any[]> = {};
    const globalFundingHistory: Record<string, any[]> = {};
    const fundingRates: Record<string, number> = {
      'BTCUSDT': 0.0001,
      'weex-ETHUSDT': -0.0002
    };
    const globalTickers: Record<string, Record<string, any>> = {
      weex: {
        'BTC/USDT': { last: 60000, quoteVolume: 1000000 },
        'ETH/USDT': { last: 3000, volume: 500000 }
      }
    };

    const ctx: BackgroundSchedulerContext = {
      isMainThread: true,
      getGlobalCcxtTickers: () => globalTickers,
      getFundingRates: () => fundingRates,
      getHistoryData: () => historyData,
      getGlobalFundingHistory: () => globalFundingHistory
    };

    const now = Date.now();
    recordMarketHistory(ctx, now);

    expect(historyData['BTCUSDT']).toBeDefined();
    expect(historyData['BTCUSDT'].length).toBe(1);
    expect(historyData['BTCUSDT'][0].price).toBe(60000);

    expect(globalFundingHistory['BTCUSDT']).toBeDefined();
    expect(globalFundingHistory['BTCUSDT'][0].rate).toBe(0.0001);

    expect(globalFundingHistory['ETHUSDT']).toBeDefined();
    expect(globalFundingHistory['ETHUSDT'][0].rate).toBe(-0.0002);
  });

  it('prunes stale memory data older than 2 hours', () => {
    const now = Date.now();
    const staleTime = now - 3 * 60 * 60 * 1000; // 3 hours ago

    const historyData: Record<string, any[]> = {
      OLDCOIN: [{ price: 1.0, volume: 100, timestamp: staleTime }],
      ACTIVECOIN: [{ price: 2.0, volume: 200, timestamp: now }]
    };
    const globalFundingHistory: Record<string, any[]> = {
      OLDCOIN: [{ rate: 0.0001, time: staleTime }],
      ACTIVECOIN: [{ rate: 0.0002, time: now }]
    };

    const ctx: BackgroundSchedulerContext = {
      isMainThread: true,
      getGlobalCcxtTickers: () => ({}),
      getFundingRates: () => ({}),
      getHistoryData: () => historyData,
      getGlobalFundingHistory: () => globalFundingHistory
    };

    recordMarketHistory(ctx, now);

    expect(historyData['OLDCOIN']).toBeUndefined();
    expect(historyData['ACTIVECOIN']).toBeDefined();

    expect(globalFundingHistory['OLDCOIN']).toBeUndefined();
    expect(globalFundingHistory['ACTIVECOIN']).toBeDefined();
  });

  it('starts and stops interval schedules cleanly', () => {
    const manageTradesSpy = vi.fn().mockResolvedValue(undefined);
    const aiExpertSpy = vi.fn().mockResolvedValue(undefined);
    const autopilotSpy = vi.fn().mockResolvedValue(undefined);
    const settingsSyncSpy = vi.fn();

    const ctx: BackgroundSchedulerContext = {
      isMainThread: true,
      getGlobalCcxtTickers: () => ({}),
      getFundingRates: () => ({}),
      getHistoryData: () => ({}),
      getGlobalFundingHistory: () => ({}),
      manageTradesServerSide: manageTradesSpy,
      runAiExpertTraderLoop: aiExpertSpy,
      runAutopilotAndVirtualTradeEntry: autopilotSpy,
      sendSettingsToWorker: settingsSyncSpy
    };

    const scheduler = new BackgroundSchedulerService(ctx);
    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
