import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readLocalDB, writeLocalDB, getCachedDB, flushDB, requestDBSave, saveTradeToDB, saveKnowledgeToDB, deleteKnowledgeFromDB, saveBalanceToDB, type DbStorageContext } from './dbStorageService.ts';

describe('dbStorageService', () => {
  let mockAtomicStore: any;
  let mockContext: DbStorageContext;
  let cachedData: any = null;
  let virtualTrades: any[] = [];
  let aiKnowledgeBase: any[] = [];
  let prolivPeaks: any[] = [];
  let globalSettings: any = {};

  beforeEach(() => {
    cachedData = {
      settings: { main: { virtualBalance: 500 } },
      trades: [],
      knowledge: []
    };
    virtualTrades = [];
    aiKnowledgeBase = [];
    prolivPeaks = [];
    globalSettings = { virtualBalance: 500 };

    mockAtomicStore = {
      loadState: vi.fn(() => cachedData),
      saveState: vi.fn(async (data: any) => { cachedData = data; }),
      getRevision: vi.fn(() => 1)
    };

    mockContext = {
      getAtomicStore: () => mockAtomicStore,
      getCachedDBData: () => cachedData,
      setCachedDBData: (d: any) => { cachedData = d; },
      getDbWriteTimeout: () => null,
      setDbWriteTimeout: vi.fn(),
      getIsPostgresConfigured: () => false,
      getVirtualTrades: () => virtualTrades,
      getAiKnowledgeBase: () => aiKnowledgeBase,
      getProlivPeaks: () => prolivPeaks,
      getAgentExchangeLogs: () => [],
      getVirtualBalance: () => 650,
      getStartOfDayBalance: () => 500,
      getStartOfWeekBalance: () => 500,
      getLastWeekCheckTime: () => Date.now(),
      getGlobalSettings: () => globalSettings,
      getOwnerId: () => 'test_owner',
      getFirebaseDb: () => null,
      getIsFirebaseFirestoreDisabled: () => true,
      setIsFirebaseFirestoreDisabled: vi.fn(),
      getIsSyncingToFirebase: () => false,
      setIsSyncingToFirebase: vi.fn(),
      getSyncedTradesCache: () => new Map(),
      getSyncedKnowledgeCache: () => new Map(),
      getLastSyncedSettingsStr: () => '',
      setLastSyncedSettingsStr: vi.fn(),
      getLastSyncedReportsStr: () => '',
      setLastSyncedReportsStr: vi.fn(),
      getLastSyncedLogsStr: () => '',
      setLastSyncedLogsStr: vi.fn()
    };
  });

  it('reads local db via atomic store', () => {
    const data = readLocalDB(mockAtomicStore);
    expect(data).toBeDefined();
    expect(mockAtomicStore.loadState).toHaveBeenCalled();
  });

  it('gets cached db or initializes from local db', () => {
    const db = getCachedDB(mockContext);
    expect(db.settings.main.virtualBalance).toBe(500);
  });

  it('flushes DB immediately via atomic store', async () => {
    await flushDB(mockContext);
    expect(mockAtomicStore.saveState).toHaveBeenCalled();
  });

  it('saves new trade to DB and updates cache and memory state', async () => {
    const trade = {
      id: 'trade_123',
      symbol: 'BTCUSDT:mexc',
      side: 'SHORT',
      amount: 50,
      entryPrice: 65000,
      status: 'OPEN',
      history: [{ type: 'OPEN', price: 65000, time: Date.now() }]
    };

    await saveTradeToDB(trade, true, mockContext);

    expect(cachedData.trades).toHaveLength(1);
    expect(cachedData.trades[0].id).toBe('trade_123');
    expect(mockAtomicStore.saveState).toHaveBeenCalled();
  });

  it('prevents overwriting closed trade with stale open state', async () => {
    cachedData.trades = [
      { id: 'trade_123', symbol: 'BTCUSDT', status: 'CLOSED', pnl: 20 }
    ];

    const staleTrade = {
      id: 'trade_123',
      symbol: 'BTCUSDT',
      status: 'OPEN'
    };

    await saveTradeToDB(staleTrade, false, mockContext);

    expect(cachedData.trades[0].status).toBe('CLOSED');
  });

  it('saves knowledge rule and synchronizes memory array', async () => {
    const rule = {
      id: 'rule_99',
      text: 'Тестовое правило',
      filterIndicator: 'rsi'
    };

    await saveKnowledgeToDB(rule, true, mockContext);

    expect(cachedData.knowledge).toHaveLength(1);
    expect(cachedData.knowledge[0].id).toBe('rule_99');
    expect(aiKnowledgeBase).toHaveLength(1);
  });

  it('deletes knowledge rule from memory and cached DB', async () => {
    aiKnowledgeBase = [{ id: 'rule_99', text: 'Удаляемое правило' }];
    cachedData.knowledge = [{ id: 'rule_99', text: 'Удаляемое правило' }];

    await deleteKnowledgeFromDB('rule_99', mockContext);

    expect(aiKnowledgeBase).toHaveLength(0);
    expect(cachedData.knowledge).toHaveLength(0);
  });

  it('saves balance updates to settings and flushes to disk', async () => {
    await saveBalanceToDB(mockContext);

    expect(cachedData.settings.main.virtualBalance).toBe(650);
    expect(globalSettings.virtualBalance).toBe(650);
    expect(mockAtomicStore.saveState).toHaveBeenCalled();
  });
});
