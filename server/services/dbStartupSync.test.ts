import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { serviceLoadStateFromDB, inspectStartupPersistenceDiagnostics, type DbStartupSyncContext } from './dbStartupSync.ts';

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

  it('logs would_restore_from when backup revision exceeds database.json without mutating or auto-restoring state (J2)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'j2-startup-diag-'));
    try {
      const backupsDir = path.join(tmpDir, 'data', 'backups');
      const kgDir = path.join(tmpDir, 'data', 'known_good');
      fs.mkdirSync(backupsDir, { recursive: true });
      fs.mkdirSync(kgDir, { recursive: true });

      const currentDbPayload = {
        stateRevision: 100,
        trades: [{ id: 'OLD-1', symbol: 'BTC/USDT', side: 'SHORT', status: 'CLOSED', openTime: Date.now() - 1000, closeTime: Date.now(), pnl: 1, pnlPercent: 1 }],
        knowledge: [],
        settings: { main: { virtualBalance: 500, startOfDayBalance: 500 } }
      };
      const newerBackupPayload = {
        stateRevision: 250,
        trades: [
          ...currentDbPayload.trades,
          { id: 'BACKUP-ONLY-2', symbol: 'ETH/USDT', side: 'LONG', status: 'CLOSED', openTime: Date.now() - 500, closeTime: Date.now(), pnl: 2, pnlPercent: 2 }
        ]
      };

      fs.writeFileSync(path.join(tmpDir, 'database.json'), JSON.stringify(currentDbPayload), 'utf8');
      fs.writeFileSync(path.join(kgDir, 'known-good-database-copy'), JSON.stringify(currentDbPayload), 'utf8');
      fs.writeFileSync(path.join(backupsDir, 'database.json.bak_latest.json'), JSON.stringify({ stateRevision: 99 }), 'utf8');
      fs.writeFileSync(path.join(backupsDir, 'backup_2026-11-17T03-39-12-220Z.json'), JSON.stringify(newerBackupPayload), 'utf8');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = inspectStartupPersistenceDiagnostics(currentDbPayload, { baseDir: tmpDir, log: true });

      expect(report.databaseJson.stateRevision).toBe(100);
      expect(report.bakLatestJson.stateRevision).toBe(99);
      expect(report.newestBackup.stateRevision).toBe(250);
      expect(report.databaseMatchesKnownGoodSha256).toBe(true);
      expect(report.wouldRestoreFrom).toEqual({
        file: 'backup_2026-11-17T03-39-12-220Z.json',
        rev: 250,
        currentRev: 100
      });

      const loggedLines = logSpy.mock.calls.map(c => c.join(' '));
      expect(loggedLines.some(l => l.includes('[STARTUP DB] would_restore_from=backup_2026-11-17T03-39-12-220Z.json rev=250 > current=100'))).toBe(true);
      expect(loggedLines.some(l => l.includes('[STARTUP DB FILES]'))).toBe(true);

      // database.json on disk must NOT be auto-restored or overwritten
      const diskAfter = JSON.parse(fs.readFileSync(path.join(tmpDir, 'database.json'), 'utf8'));
      expect(diskAfter.stateRevision).toBe(100);
      expect(diskAfter.trades.find((t: any) => t.id === 'BACKUP-ONLY-2')).toBeUndefined();
      logSpy.mockRestore();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
