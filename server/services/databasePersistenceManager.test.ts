import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabasePersistenceManager } from './databasePersistenceManager.ts';
import { AtomicStateStore } from '../atomicDbSaver.ts';

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

  it('сохранить, перезагрузить, найти сделку across fresh DatabasePersistenceManager instances on disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-trading-persist-'));
    const uniqueName = `test_persist_roundtrip_db_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
    try {
      const dbPath = path.join(tmpDir, uniqueName);
      const settingsPath = path.join(tmpDir, 'test_persist_roundtrip_settings.json');
      fs.writeFileSync(dbPath, JSON.stringify({
        settings: { main: { virtualBalance: 500 } },
        trades: [],
        knowledge: []
      }), 'utf8');
      const tradeId = 'TR-ROUNDTRIP-TEST-1';
      const now = Date.now();

      const createManager = (tradesRef: any[]) =>
        new DatabasePersistenceManager({
          dbAtomicStore: new AtomicStateStore(dbPath),
          getIsPostgresConfigured: () => false,
          getVirtualTrades: () => tradesRef,
          getAiKnowledgeBase: () => [],
          getProlivPeaks: () => [],
          getAgentExchangeLogs: () => [],
          getVirtualBalance: () => 500,
          setVirtualBalance: vi.fn(),
          getStartOfDayBalance: () => 500,
          setStartOfDayBalance: vi.fn(),
          getStartOfDayRealBalance: () => 0,
          setStartOfDayRealBalance: vi.fn(),
          getStartOfWeekBalance: () => 500,
          setStartOfWeekBalance: vi.fn(),
          getLastWeekCheckTime: () => now,
          setLastWeekCheckTime: vi.fn(),
          getGlobalSettings: () => ({ virtualBalance: 500 }),
          getOwnerId: () => 'test_owner',
          getFirebaseDb: () => null,
          isMainThread: true,
          streamEmitter: { emit: vi.fn(() => true) },
          settingsFilePath: settingsPath
        });

      const writerTrades: any[] = [];
      const writerManager = createManager(writerTrades);
      await writerManager.saveTradeDB({
        id: tradeId,
        symbol: 'ETH/USDT:USDT',
        side: 'SHORT',
        amount: 25,
        leverage: 5,
        entryPrice: 3200,
        status: 'OPEN',
        openTime: now,
        history: [{ time: now, type: 'OPEN', price: 3200, amount: 25 }]
      }, true);

      expect(fs.existsSync(dbPath)).toBe(true);

      // Fresh instance simulating process restart from empty in-memory arrays
      const readerTrades: any[] = [];
      const readerManager = createManager(readerTrades);
      await readerManager.loadStateFromDB();

      const reloaded = readerTrades.find(t => t.id === tradeId);
      expect(reloaded).toBeDefined();
      expect(reloaded.symbol).toBe('ETH/USDT:USDT');
      expect(reloaded.side).toBe('SHORT');
      expect(reloaded.entryPrice).toBe(3200);
      expect(reloaded.status).toBe('OPEN');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const bakPath = path.join(process.cwd(), 'data', 'backups', `${uniqueName}.bak_latest.json`);
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
    }
  });
});
