import { describe, it, expect, vi } from 'vitest';
import { ScannerWorkerManager, ScannerWorkerManagerContext } from './scannerWorkerManager.ts';

describe('scannerWorkerManager', () => {
  it('correctly handles SYNC_STATE payload from worker thread', () => {
    const globalTrueOhlcv: Record<string, any> = {};
    const orderBookImbalance: Record<string, any> = {};
    const globalOrderBookHistory: Record<string, any> = {};
    const globalCcxtTickers: Record<string, any> = {};
    const globalWhales: Record<string, any> = {};
    const globalPumps = new Set<string>();
    const globalCvd: Record<string, any> = {};
    const globalAtr: Record<string, any> = {};
    const globalAiCommitteeCache: Record<string, any> = {};
    let cachedSignals: any = null;
    let emitCount = 0;

    const ctx: ScannerWorkerManagerContext = {
      isMainThread: true,
      getGlobalSettings: () => ({}),
      getVirtualTrades: () => [],
      getAiKnowledgeBase: () => [],
      getGlobalTrueOhlcv: () => globalTrueOhlcv,
      getOrderBookImbalance: () => orderBookImbalance,
      getGlobalOrderBookHistory: () => globalOrderBookHistory,
      getGlobalCcxtTickers: () => globalCcxtTickers,
      getGlobalWhales: () => globalWhales,
      getGlobalPumps: () => globalPumps,
      getGlobalCvd: () => globalCvd,
      getGlobalAtr: () => globalAtr,
      getCacheSignals: () => cachedSignals,
      setCacheSignals: (sig) => { cachedSignals = sig; },
      getGlobalAiCommitteeCache: () => globalAiCommitteeCache,
      emitSignalsUpdated: () => { emitCount++; },
      runAiGeneration: vi.fn().mockResolvedValue('OK')
    };

    const manager = new ScannerWorkerManager(ctx);
    const mockWorker: any = { postMessage: vi.fn() };

    manager.handleWorkerMessage({
      type: 'SYNC_STATE',
      payload: {
        GLOBAL_TRUE_OHLCV: { 'BTCUSDT': [{ open: 60000 }] },
        GLOBAL_PUMPS: ['BTCUSDT-12345'],
        CACHE_SIGNALS: { data: [{ symbol: 'BTCUSDT' }] },
        GLOBAL_AI_COMMITTEE_CACHE: { 'BTCUSDT': { score: 90 } }
      }
    }, mockWorker);

    expect(globalTrueOhlcv['BTCUSDT']).toBeDefined();
    expect(globalPumps.has('BTCUSDT-12345')).toBe(true);
    expect(cachedSignals.data.length).toBe(1);
    expect(globalAiCommitteeCache['BTCUSDT'].score).toBe(90);
    expect(emitCount).toBe(1);
  });

  it('correctly dispatches RUN_AI_GENERATION to AI generator and responds back to worker', async () => {
    const aiGenSpy = vi.fn().mockResolvedValue('AI Response text');
    const postMessageSpy = vi.fn();
    const mockWorker: any = { postMessage: postMessageSpy };

    const ctx: ScannerWorkerManagerContext = {
      isMainThread: true,
      getGlobalSettings: () => ({}),
      getVirtualTrades: () => [],
      getAiKnowledgeBase: () => [],
      getGlobalTrueOhlcv: () => ({}),
      getOrderBookImbalance: () => ({}),
      getGlobalOrderBookHistory: () => ({}),
      getGlobalCcxtTickers: () => ({}),
      getGlobalWhales: () => ({}),
      getGlobalPumps: () => new Set(),
      getGlobalCvd: () => ({}),
      getGlobalAtr: () => ({}),
      getCacheSignals: () => null,
      setCacheSignals: () => {},
      getGlobalAiCommitteeCache: () => ({}),
      emitSignalsUpdated: () => {},
      runAiGeneration: aiGenSpy
    };

    const manager = new ScannerWorkerManager(ctx);

    manager.handleWorkerMessage({
      type: 'RUN_AI_GENERATION',
      payload: { id: 'task-1', params: { prompt: 'Analyze' } }
    }, mockWorker);

    expect(aiGenSpy).toHaveBeenCalledWith({ prompt: 'Analyze' });
    await Promise.resolve();

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'AI_GENERATION_RESPONSE',
      payload: { id: 'task-1', result: 'AI Response text' }
    });
  });
});
