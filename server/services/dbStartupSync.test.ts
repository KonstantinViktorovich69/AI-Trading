import { describe, it, expect, vi } from 'vitest';
import { serviceLoadStateFromDB, type DbStartupSyncContext } from './dbStartupSync.ts';

describe('dbStartupSync stale trade cleanup', () => {
  it('preserves realized Multi-TP partial closes when force-closing stale trades older than 48h', async () => {
    const virtualTrades: any[] = [];
    const now = Date.now();
    const staleOpenTime = now - 50 * 3600 * 1000;

    // Trade opened at 100 with initialAmount 100 (leverage 5x):
    // TP1 partially closed 50 at 104 (+20% leveraged before 0.1% fee => ~+$9.75),
    // remaining amount 50 now stale at currentPrice 99 (-5% leveraged before fee => ~-$2.75).
    // Combined total PnL must remain positive (~+$7.00), NOT overwritten with only residual -$2.75!
    const staleTrade = {
      id: 'STALE-MTP-1',
      symbol: 'ETH/USDT:USDT',
      side: 'LONG',
      entryPrice: 100,
      currentPrice: 99,
      amount: 50,
      initialAmount: 100,
      leverage: 5,
      status: 'OPEN',
      openTime: staleOpenTime,
      history: [
        { time: staleOpenTime, type: 'OPEN', price: 100, amount: 100 },
        { time: staleOpenTime + 10000, type: 'CLOSE', price: 104, amount: 50 }
      ]
    };

    const localDbData: any = {
      trades: [staleTrade],
      knowledge: [],
      settings: { main: { virtualBalance: 500, startOfDayBalance: 500 } }
    };

    const ctx: DbStartupSyncContext = {
      readLocalDB: () => localDbData,
      setCachedDBData: vi.fn(),
      getCachedDB: () => localDbData,
      flushDB: vi.fn().mockResolvedValue(undefined),
      isPostgresConfigured: () => false,
      OWNER_ID: 'default_user',
      getDb: () => null,
      isFirebaseFirestoreDisabled: true,
      isMainThread: true,
      getGlobalSettings: () => ({ virtualBalance: 500 }),
      getVirtualTrades: () => virtualTrades,
      setVirtualTrades: vi.fn(),
      getAiKnowledgeBase: () => [],
      setAiKnowledgeBase: vi.fn(),
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
      getOpenTradesCache: () => [],
      setOpenTradesCache: vi.fn(),
      ADVANCED_RULES: () => [],
      handleFirestoreError: vi.fn(),
      syncToFirebase: vi.fn().mockResolvedValue(undefined),
      streamEmitter: { emit: vi.fn(() => true) },
      getSyncedTradesCache: () => new Map(),
      getSyncedKnowledgeCache: () => new Map(),
      getLastSyncedSettingsStr: () => '',
      setLastSyncedSettingsStr: vi.fn()
    };

    await serviceLoadStateFromDB(ctx);

    const closed = virtualTrades.find(t => t.id === 'STALE-MTP-1');
    expect(closed).toBeDefined();
    expect(closed.status).toBe('CLOSED');
    // Partial TP1 profit (+10 gross - 0.25 fee = +9.75) + residual (-2.50 gross - 0.25 fee = -2.75) = +7.00
    expect(closed.pnl).toBeCloseTo(7.0, 2);
    expect(closed.pnlPercent).toBeCloseTo(7.0, 2);
    expect(closed.history.filter((h: any) => h.type === 'CLOSE')).toHaveLength(2);
  });
});
