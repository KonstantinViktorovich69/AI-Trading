import { describe, it, expect, vi } from 'vitest';
import { DatabasePersistenceManager } from './databasePersistenceManager.ts';

describe('DatabasePersistenceManager', () => {
  it('manages cache, context, and backup lifecycle correctly', async () => {
    let mockStoreData: any = {
      settings: { main: { virtualBalance: 500 } },
      trades: [],
      knowledge: []
    };

    const mockAtomicStore = {
      loadState: vi.fn((fallback: any) => mockStoreData || fallback),
      saveState: vi.fn(async (data: any) => { mockStoreData = data; return data; }),
      getRevision: vi.fn(() => 1)
    };

    const mockVirtualTrades: any[] = [];
    const mockKb: any[] = [];
    const mockPeaks: any[] = [];
    const mockLogs: any[] = [];

    const manager = new DatabasePersistenceManager({
      dbAtomicStore: mockAtomicStore,
      getIsPostgresConfigured: () => false,
      getVirtualTrades: () => mockVirtualTrades,
      getAiKnowledgeBase: () => mockKb,
      getProlivPeaks: () => mockPeaks,
      getAgentExchangeLogs: () => mockLogs,
      getVirtualBalance: () => 500,
      setVirtualBalance: vi.fn(),
      getStartOfDayBalance: () => 500,
      setStartOfDayBalance: vi.fn(),
      getStartOfDayRealBalance: () => 0,
      setStartOfDayRealBalance: vi.fn(),
      getStartOfWeekBalance: () => 500,
      setStartOfWeekBalance: vi.fn(),
      getLastWeekCheckTime: () => 1234567,
      setLastWeekCheckTime: vi.fn(),
      getGlobalSettings: () => ({}),
      getOwnerId: () => 'test_user',
      getFirebaseDb: () => null,
      isMainThread: true,
      streamEmitter: { emit: vi.fn() }
    });

    const localData = manager.readLocalDB();
    expect(localData).toBeDefined();
    expect(mockAtomicStore.loadState).toHaveBeenCalled();

    const cached = manager.getCachedDB();
    expect(cached).toBeDefined();

    await manager.saveKnowledgeDB({ id: 'rule_1', title: 'Test Rule' }, true);
    expect(mockKb.length).toBe(1);
    expect(mockKb[0].title).toBe('Test Rule');

    await manager.saveTradeDB({ id: 'trade_1', symbol: 'BTCUSDT', status: 'OPEN' }, true);
    expect(mockStoreData.trades.some((t: any) => t.id === 'trade_1')).toBe(true);

    await manager.deleteKnowledgeDB('rule_1');
    expect(mockKb.length).toBe(0);
  });
});
