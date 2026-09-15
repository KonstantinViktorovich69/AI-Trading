import { describe, it, expect, vi } from 'vitest';
import { TradeManagerService } from './tradeManagerService.ts';

describe('TradeManagerService', () => {
  it('initializes balance state and daily trackers correctly', () => {
    const mockDeps: any = {
      getVirtualTrades: () => [],
      getGlobalSettings: () => ({ exchangeApiConfig: { isEnabled: false } }),
      getGlobalCcxtTickers: () => ({}),
      getWsTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({}),
      getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
      getAiKnowledgeBase: () => [],
      getCcxtClient: vi.fn(),
      executeWithRetry: vi.fn(),
      saveTradeDB: vi.fn(),
      saveBalanceDB: vi.fn(),
      saveKnowledgeDB: vi.fn(),
      sendTelegramMessage: vi.fn(),
      emitSignalsUpdated: vi.fn(),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn(),
      runAiGeneration: vi.fn()
    };

    const manager = new TradeManagerService(mockDeps, {
      virtualBalance: 1200,
      startOfDayBalance: 1200,
      startOfDayRealBalance: 500,
      startOfWeekBalance: 1000
    });

    expect(manager.getVirtualBalance()).toBe(1200);
    expect(manager.getStartOfDayBalance()).toBe(1200);
    expect(manager.getStartOfDayRealBalance()).toBe(500);
    expect(manager.getStartOfWeekBalance()).toBe(1000);
    expect(manager.getIsCircuitBreakerActive()).toBe(false);

    manager.setVirtualBalance(1350);
    expect(manager.getVirtualBalance()).toBe(1350);
  });

  it('triggers circuit breaker and force closes open virtual trades with correct PnL', async () => {
    const mockTrade: any = {
      id: 'trade_1',
      symbol: 'BTC/USDT',
      side: 'LONG',
      status: 'OPEN',
      entryPrice: 50000,
      currentPrice: 48000,
      amount: 100,
      leverage: 5,
      isReal: false
    };

    const virtualTrades = [mockTrade];
    const saveTradeSpy = vi.fn();
    const sendTelegramSpy = vi.fn();
    const saveBalanceSpy = vi.fn();

    const mockDeps: any = {
      getVirtualTrades: () => virtualTrades,
      getGlobalSettings: () => ({ exchangeApiConfig: { isEnabled: false } }),
      getGlobalCcxtTickers: () => ({}),
      getWsTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({}),
      getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
      getAiKnowledgeBase: () => [],
      getCcxtClient: vi.fn(),
      executeWithRetry: vi.fn(),
      saveTradeDB: saveTradeSpy,
      saveBalanceDB: saveBalanceSpy,
      saveKnowledgeDB: vi.fn(),
      sendTelegramMessage: sendTelegramSpy,
      emitSignalsUpdated: vi.fn(),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn(),
      runAiGeneration: vi.fn()
    };

    const manager = new TradeManagerService(mockDeps, { virtualBalance: 1000 });

    await manager.triggerCircuitBreaker('Critical Drawdown Exceeded');

    expect(manager.getIsCircuitBreakerActive()).toBe(true);
    expect(mockTrade.status).toBe('CLOSED');
    expect(mockTrade.closeReason).toContain('Critical Drawdown Exceeded');
    expect(saveTradeSpy).toHaveBeenCalled();
    expect(sendTelegramSpy).toHaveBeenCalled();
    expect(saveBalanceSpy).toHaveBeenCalled();
  });
});
