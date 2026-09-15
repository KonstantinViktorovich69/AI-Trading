import { describe, it, expect, vi } from 'vitest';
import { AutopilotEngineService } from './autoPilotEngineService.ts';

describe('AutopilotEngineService', () => {
  it('initializes dependencies and tracks state correctly', () => {
    const mockDeps: any = {
      getGlobalSettings: () => ({ isAutopilotEnabled: false }),
      getCacheSignals: () => ({ data: [] }),
      getVirtualTrades: () => [],
      pushVirtualTrade: vi.fn(),
      getVirtualBalance: () => 500,
      setVirtualBalance: vi.fn(),
      getStartOfDayBalance: () => 500,
      getGlobalCcxtTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({}),
      getGlobalAdx: () => ({}),
      getGlobalAtr: () => ({}),
      getGlobalOrderBookHistory: () => ({}),
      getOrderBookImbalance: () => ({}),
      getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
      getProlivPeaks: () => [],
      getAutopilotFailedSymbols: () => new Set(),
      getAiKnowledgeBase: () => [],
      readLocalDB: () => ({}),
      isCircuitBreakerActive: () => false,
      acquireExecutionLock: () => true,
      isWeexApiSupported: () => true,
      getCcxtClient: vi.fn(),
      fetchCachedRealBalance: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn(),
      saveTradeDB: vi.fn(),
      saveBalanceDB: vi.fn(),
      saveSettings: vi.fn(),
      sendTelegramMessage: vi.fn(),
      emitSignalsUpdated: vi.fn(),
      runAiGeneration: vi.fn(),
      getWallAdjustedTp: vi.fn()
    };

    const service = new AutopilotEngineService(mockDeps);
    expect(service.getSymbolsUndergoingRealOpen()).toBeInstanceOf(Set);
    expect(service.getCommitteeVetoShadowStats().wouldHaveBlockedCount).toBe(0);
    expect(service.getCommitteeVetoShadowStats().totalRealEntriesChecked).toBe(0);
  });

  it('safely exits early when autopilot is disabled in settings', async () => {
    const mockDeps: any = {
      getGlobalSettings: () => ({ isAutopilotEnabled: false }),
      getCacheSignals: () => ({ data: [{ symbol: 'BTCUSDT', aiScore: 99 }] }),
      getVirtualTrades: () => [],
      pushVirtualTrade: vi.fn(),
      getVirtualBalance: () => 500,
      setVirtualBalance: vi.fn(),
      getStartOfDayBalance: () => 500,
      getGlobalCcxtTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({}),
      getGlobalAdx: () => ({}),
      getGlobalAtr: () => ({}),
      getGlobalOrderBookHistory: () => ({}),
      getOrderBookImbalance: () => ({}),
      getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
      getProlivPeaks: () => [],
      getAutopilotFailedSymbols: () => new Set(),
      getAiKnowledgeBase: () => [],
      readLocalDB: () => ({}),
      isCircuitBreakerActive: () => false,
      acquireExecutionLock: () => true,
      isWeexApiSupported: () => true,
      getCcxtClient: vi.fn(),
      fetchCachedRealBalance: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn(),
      saveTradeDB: vi.fn(),
      saveBalanceDB: vi.fn(),
      saveSettings: vi.fn(),
      sendTelegramMessage: vi.fn(),
      emitSignalsUpdated: vi.fn(),
      runAiGeneration: vi.fn(),
      getWallAdjustedTp: vi.fn()
    };

    const service = new AutopilotEngineService(mockDeps);
    await service.runAutopilotAndVirtualTradeEntry();
    expect(mockDeps.pushVirtualTrade).not.toHaveBeenCalled();
  });
});
