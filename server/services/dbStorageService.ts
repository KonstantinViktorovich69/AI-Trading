import fs from 'fs';
import path from 'path';
import { inferDataOrigin, inferDecisionSource, inferCloseReasonCode } from './tradeSchema.ts';
import { processIncomingStateMessage } from './stateSync.ts';

export interface DbStorageContext {
  getAtomicStore: () => { loadState: <T>(fallback: T) => T; saveState: (data: any) => Promise<any>; getRevision: () => number };
  getCachedDBData: () => any;
  setCachedDBData: (data: any) => void;
  getDbWriteTimeout: () => NodeJS.Timeout | null;
  setDbWriteTimeout: (timeout: NodeJS.Timeout | null) => void;
  getIsPostgresConfigured: () => boolean;
  syncTradesToPg?: (trades: any[]) => Promise<any>;
  syncKnowledgeToPg?: (kb: any[]) => Promise<any>;
  getVirtualTrades: () => any[];
  getAiKnowledgeBase: () => any[];
  getProlivPeaks: () => any[];
  getAgentExchangeLogs: () => any[];
  getVirtualBalance: () => number;
  getStartOfDayBalance: () => number;
  getStartOfWeekBalance: () => number;
  getLastWeekCheckTime: () => number;
  getGlobalSettings: () => any;
  getOwnerId: () => string;
  getFirebaseDb: () => any;
  getIsFirebaseFirestoreDisabled: () => boolean;
  setIsFirebaseFirestoreDisabled: (disabled: boolean) => void;
  getIsSyncingToFirebase: () => boolean;
  setIsSyncingToFirebase: (syncing: boolean) => void;
  getSyncedTradesCache: () => Map<string, string>;
  getSyncedKnowledgeCache: () => Map<string, string>;
  getLastSyncedSettingsStr: () => string;
  setLastSyncedSettingsStr: (str: string) => void;
  getLastSyncedReportsStr: () => string;
  setLastSyncedReportsStr: (str: string) => void;
  getLastSyncedLogsStr: () => string;
  setLastSyncedLogsStr: (str: string) => void;
  onTradeClosedIncremental?: (trade: any) => void;
  runRetrospectiveAnalysisBackground?: (trade: any) => Promise<void>;
  sendTelegramMessage?: (text: string) => void;
  atomicWriteJson?: (filePath: string, data: any) => void;
  getSettingsFilePath?: () => string;
}

export function readLocalDB(atomicStore: { loadState: <T>(fallback: T) => T }): any {
  return atomicStore.loadState<any>({ settings: {}, trades: [], knowledge: [] });
}

export async function writeLocalDB(data: any, atomicStore: { saveState: (data: any) => Promise<any> }): Promise<void> {
  try {
    await atomicStore.saveState(data);
  } catch (e) {
    console.error('[ATOMIC DB ERROR] Failed to write local DB via atomic store:', e);
    throw e;
  }
}

export function getCachedDB(ctx: DbStorageContext): any {
  let cached = ctx.getCachedDBData();
  if (!cached) {
    cached = readLocalDB(ctx.getAtomicStore());
    ctx.setCachedDBData(cached);
  }
  return cached;
}

export async function flushDB(ctx: DbStorageContext): Promise<void> {
  const cachedDBData = ctx.getCachedDBData();
  if (cachedDBData) {
    const timeout = ctx.getDbWriteTimeout();
    if (timeout) {
      clearTimeout(timeout);
      ctx.setDbWriteTimeout(null);
    }
    await writeLocalDB(cachedDBData, ctx.getAtomicStore());
    if (ctx.getIsPostgresConfigured() && ctx.syncTradesToPg && ctx.syncKnowledgeToPg) {
      await Promise.allSettled([
        ctx.syncTradesToPg(cachedDBData.trades || []),
        ctx.syncKnowledgeToPg(cachedDBData.knowledge || [])
      ]);
    }
  }
}

export async function requestDBSave(ctx: DbStorageContext): Promise<void> {
  const cachedDBData = ctx.getCachedDBData();
  if (!cachedDBData) return;
  if (cachedDBData.trades && cachedDBData.trades.length > 600) {
    const active = cachedDBData.trades.filter((t: any) => t.status === 'OPEN');
    const closed = cachedDBData.trades.filter((t: any) => t.status !== 'OPEN')
      .sort((a: any, b: any) => (b.closeTime || 0) - (a.closeTime || 0))
      .slice(0, 500);
    cachedDBData.trades = [...active, ...closed];
  }
  await ctx.getAtomicStore().saveState(cachedDBData);
}

export function withFirestoreTimeout<T>(promise: Promise<T>, ms: number, desc: string): Promise<T> {
  let timeoutId: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Firestore operation "${desc}" timed out after ${ms}ms (Likely Quota Exceeded or RESOURCE_EXHAUSTED)`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function handleFirestoreError(err: any, context: string, ctx: DbStorageContext): void {
  const errMsg = err?.message || err?.toString() || '';
  const isQuota =
    errMsg.includes('RESOURCE_EXHAUSTED') ||
    errMsg.includes('Quota') ||
    errMsg.includes('limit') ||
    errMsg.includes('timeout') ||
    errMsg.includes('Timeout') ||
    errMsg.includes('exceeded') ||
    errMsg.includes('PERMISSION_DENIED') ||
    errMsg.includes('disabled');

  if (isQuota) {
    if (!ctx.getIsFirebaseFirestoreDisabled()) {
      ctx.setIsFirebaseFirestoreDisabled(true);
      console.log(`[FIRESTORE STATUS] Paused synchronization for "${context}" (Heuristics: Quota limit reached). Operating in 100% offline-first mode.`);
    }
  } else {
    console.log(`[FIRESTORE STATUS] Notice for "${context}": system is currently operating in offline-first mode.`);
  }
}

export async function syncToFirebase(dbData: any, ctx: DbStorageContext): Promise<void> {
  const db = ctx.getFirebaseDb();
  if (!db || ctx.getIsFirebaseFirestoreDisabled()) return;
  if (ctx.getIsSyncingToFirebase()) return;
  ctx.setIsSyncingToFirebase(true);

  try {
    const ownerId = ctx.getOwnerId() || 'default_user';
    let totalWritesCalculated = 0;

    // 1. Settings
    if (dbData.settings) {
      const settingsStr = JSON.stringify(dbData.settings);
      if (ctx.getLastSyncedSettingsStr() !== settingsStr) {
        await withFirestoreTimeout(
          db.collection('users').doc(ownerId).collection('settings').doc('main').set(dbData.settings, { merge: true }),
          5000,
          'setSettings'
        );
        ctx.setLastSyncedSettingsStr(settingsStr);
        totalWritesCalculated++;
        console.log('[BACKUP] Synced modified settings to Firebase.');
      }
    }

    // 2. Trades
    if (Array.isArray(dbData.trades)) {
      const tradesRef = db.collection('users').doc(ownerId).collection('trades');
      const syncedTradesCache = ctx.getSyncedTradesCache();
      const unsyncedTrades = dbData.trades.filter((trade: any) => {
        if (!trade || !trade.id) return false;
        const tradeStr = JSON.stringify(trade);
        return syncedTradesCache.get(String(trade.id)) !== tradeStr;
      });

      if (unsyncedTrades.length > 0) {
        const tradesToSync = unsyncedTrades.slice(-200);
        const batch = db.batch();
        let batchCount = 0;
        for (const trade of tradesToSync) {
          const tradeStr = JSON.stringify(trade);
          batch.set(tradesRef.doc(String(trade.id)), trade, { merge: true });
          syncedTradesCache.set(String(trade.id), tradeStr);
          batchCount++;
        }
        if (batchCount > 0) {
          await withFirestoreTimeout(batch.commit(), 5000, 'commitTradesBatch');
          totalWritesCalculated += batchCount;
          console.log(`[BACKUP] Synced ${batchCount} modified/new trades to Firebase.`);
        }
      }
    }

    // 3. Knowledge
    if (Array.isArray(dbData.knowledge)) {
      const batch = db.batch();
      const kbRef = db.collection('users').doc(ownerId).collection('knowledge');
      const syncedKnowledgeCache = ctx.getSyncedKnowledgeCache();
      let batchCount = 0;
      for (const rule of dbData.knowledge) {
        if (rule && rule.id) {
          const ruleStr = JSON.stringify(rule);
          if (syncedKnowledgeCache.get(String(rule.id)) !== ruleStr) {
            batch.set(kbRef.doc(String(rule.id)), rule, { merge: true });
            syncedKnowledgeCache.set(String(rule.id), ruleStr);
            batchCount++;
          }
        }
      }
      if (batchCount > 0) {
        await withFirestoreTimeout(batch.commit(), 5000, 'commitKnowledgeBatch');
        totalWritesCalculated += batchCount;
        console.log(`[BACKUP] Synced ${batchCount} modified/new knowledge rules to Firebase.`);
      }
    }

    // 4. Reports
    if (Array.isArray(dbData.aiPerformanceReports)) {
      const reportsStr = JSON.stringify(dbData.aiPerformanceReports);
      if (ctx.getLastSyncedReportsStr() !== reportsStr) {
        await withFirestoreTimeout(
          db.collection('users').doc(ownerId).collection('reports').doc('performance').set({ reports: dbData.aiPerformanceReports }, { merge: true }),
          5000,
          'setPerformanceReports'
        );
        ctx.setLastSyncedReportsStr(reportsStr);
        totalWritesCalculated++;
        console.log('[BACKUP] Synced modified AI Performance Reports to Firebase.');
      }
    }

    // 5. Logs
    if (Array.isArray(dbData.agentExchangeLogs)) {
      const recentLogs = dbData.agentExchangeLogs.slice(-200);
      const logsStr = JSON.stringify(recentLogs);
      if (ctx.getLastSyncedLogsStr() !== logsStr) {
        await withFirestoreTimeout(
          db.collection('users').doc(ownerId).collection('logs').doc('exchange').set({ logs: recentLogs }, { merge: true }),
          5000,
          'setExchangeLogs'
        );
        ctx.setLastSyncedLogsStr(logsStr);
        totalWritesCalculated++;
        console.log('[BACKUP] Synced modified Agent Exchange Logs to Firebase.');
      }
    }

    if (totalWritesCalculated > 0) {
      console.log(`[BACKUP] Successfully synced state updates to Firebase Firestore (${totalWritesCalculated} writes).`);
    }
  } catch (e: any) {
    handleFirestoreError(e, 'syncToFirebase', ctx);
  } finally {
    ctx.setIsSyncingToFirebase(false);
  }
}

export function createLocalBackup(dbData: any, customBackupDir?: string): void {
  try {
    const backupDir = customBackupDir || path.join(process.cwd(), 'data', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup_')).sort();
    if (files.length >= 5) {
      fs.unlinkSync(path.join(backupDir, files[0]));
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `backup_${timestamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(dbData, null, 2));
    console.log(`[BACKUP] Local backup created: ${backupFile}`);
  } catch (e) {
    console.error('[BACKUP] Local backup failed:', e);
  }
}

export async function saveTradeToDB(trade: any, immediate: boolean = false, ctx: DbStorageContext): Promise<void> {
  try {
    const dbData = getCachedDB(ctx);
    if (!dbData.settings) dbData.settings = {};
    if (!dbData.settings.main) dbData.settings.main = {};

    const virtualBalance = ctx.getVirtualBalance();
    const startOfDayBalance = ctx.getStartOfDayBalance();
    const startOfWeekBalance = ctx.getStartOfWeekBalance();
    const globalSettings = ctx.getGlobalSettings();

    dbData.settings.main.virtualBalance = virtualBalance;
    dbData.settings.main.startOfDayBalance = startOfDayBalance;
    dbData.settings.main.startOfWeekBalance = startOfWeekBalance;
    dbData.settings.main.updatedAt = Date.now();
    if (typeof globalSettings === 'object' && globalSettings !== null) {
      globalSettings.virtualBalance = virtualBalance;
      globalSettings.startOfDayBalance = startOfDayBalance;
    }

    if (trade) {
      if (!trade.dataOrigin) trade.dataOrigin = inferDataOrigin(trade);
      if (!trade.decisionSource) trade.decisionSource = inferDecisionSource(trade);
      if (trade.status === 'CLOSED' && (!trade.closeReasonCode || trade.closeReasonCode === 'UNKNOWN')) {
        trade.closeReasonCode = inferCloseReasonCode(trade);
      }
      trade.strategyId = trade.strategyId || 'ADAPTIVE_DYNAMIC';
      trade.strategyVersion = trade.strategyVersion || '1.0.0';
      trade.stateRevision = trade.stateRevision || ctx.getAtomicStore().getRevision();

      const existingIndex = dbData.trades.findIndex((t: any) => t.id === trade.id);

      if (existingIndex !== -1 && dbData.trades[existingIndex].status === 'CLOSED' && trade.status === 'OPEN') {
        console.warn(`[SAVE-TRADE-DB GUARD] Попытка перезаписать уже ЗАКРЫТУЮ сделку ${trade.id} (${trade.symbol}) устаревшей версией со статусом OPEN — запись отклонена, сохранено закрытое состояние.`);
        return;
      }

      const ownerId = ctx.getOwnerId();
      if (existingIndex !== -1) {
        dbData.trades[existingIndex] = { ...trade, userId: ownerId };
      } else {
        dbData.trades.push({ ...trade, userId: ownerId });
      }

      if (trade.status === 'CLOSED') {
        if (ctx.onTradeClosedIncremental) ctx.onTradeClosedIncremental(trade);
        if (!trade.hasRetrospectiveAnalysis && ctx.runRetrospectiveAnalysisBackground) {
          trade.hasRetrospectiveAnalysis = true;
          ctx.runRetrospectiveAnalysisBackground(trade).catch(() => {});
        }
      }

      if (trade.status === 'CLOSED' && trade.side === 'SHORT' && trade.pnlPercent > 1.0) {
        const peakPrice = Math.max(trade.highestPrice || 0, trade.entryPrice);
        if (peakPrice > 0) {
          const cleanSym = trade.symbol.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
          dbData.prolivPeaks = dbData.prolivPeaks || [];

          const isDup = dbData.prolivPeaks.find((p: any) => p.symbol === cleanSym && Math.abs(p.peakPrice - peakPrice) / peakPrice < 0.005);
          if (!isDup) {
            const newPeak = {
              id: `peak_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
              symbol: cleanSym,
              rawSymbol: trade.symbol,
              exchange: trade.exchange || 'mexc',
              peakPrice,
              dumpTime: Date.now(),
              pnlPercent: trade.pnlPercent,
              status: 'SAVED'
            };
            dbData.prolivPeaks.push(newPeak);
            if (dbData.prolivPeaks.length > 100) {
              dbData.prolivPeaks = dbData.prolivPeaks.slice(-100);
            }

            const prolivPeaks = ctx.getProlivPeaks();
            prolivPeaks.length = 0;
            dbData.prolivPeaks.forEach((p: any) => prolivPeaks.push(p));

            console.log(`[PEAK TRACKER] Successfully recorded successful dump peak for ${cleanSym} at $${peakPrice}`);
            if (trade.isReal && ctx.sendTelegramMessage) {
              ctx.sendTelegramMessage(`💾 <b>Пролив зафиксирован (${trade.symbol})</b>\n\nМонета успешно пролилась! Сделка принесла +${trade.pnlPercent.toFixed(2)}% прибыли (с плечом).\nПиковое значение цены $${peakPrice} сохранено в памяти системы.\nПри возврате цены к этому пику будет выдан приоритетный сигнал на повторный шорт.`);
            }
          }
        }
      }
    }

    if (dbData.trades.length > 2000) {
      dbData.trades = dbData.trades.sort((a: any, b: any) => b.openTime - a.openTime).slice(0, 2000);
      const virtualTrades = ctx.getVirtualTrades();
      virtualTrades.length = 0;
      dbData.trades.forEach((t: any) => virtualTrades.push(t));
    }

    if (immediate || !trade || trade.status === 'CLOSED' || (trade.history && trade.history.length === 1 && trade.history[0].type === 'OPEN')) {
      await flushDB(ctx);
    } else {
      await requestDBSave(ctx);
    }

    const db = ctx.getFirebaseDb();
    if (db && !ctx.getIsFirebaseFirestoreDisabled()) {
      syncToFirebase(dbData, ctx).catch(() => {});
    }
  } catch (e) {
    console.error('[DATABASE SAVE ERROR] Failed to save trade to DB:', e);
    throw e;
  }
}

export async function saveKnowledgeToDB(rule: any, immediate: boolean = false, ctx: DbStorageContext): Promise<void> {
  try {
    const dbData = getCachedDB(ctx);
    if (!dbData.knowledge) dbData.knowledge = [];

    const ownerId = ctx.getOwnerId();
    if (rule) {
      rule.stateRevision = rule.stateRevision || ctx.getAtomicStore().getRevision();
      const existingIndex = dbData.knowledge.findIndex((r: any) => String(r.id) === String(rule.id));
      if (existingIndex !== -1) {
        dbData.knowledge[existingIndex] = { ...rule, userId: ownerId };
      } else {
        dbData.knowledge.push({ ...rule, userId: ownerId });
      }
    }

    const aiKnowledgeBase = ctx.getAiKnowledgeBase();
    aiKnowledgeBase.length = 0;
    dbData.knowledge.forEach((r: any) => aiKnowledgeBase.push(r));

    if (immediate) {
      await flushDB(ctx);
    } else {
      await requestDBSave(ctx);
    }

    const db = ctx.getFirebaseDb();
    if (db && !ctx.getIsFirebaseFirestoreDisabled()) {
      syncToFirebase(dbData, ctx).catch(() => {});
    }
  } catch (e) {
    console.error('[DATABASE SAVE ERROR] Failed to save knowledge to DB:', e);
    throw e;
  }
}

export async function deleteKnowledgeFromDB(id: string, ctx: DbStorageContext): Promise<void> {
  try {
    const aiKnowledgeBase = ctx.getAiKnowledgeBase();
    const updatedKb = aiKnowledgeBase.filter(r => String(r.id) !== String(id));
    aiKnowledgeBase.length = 0;
    updatedKb.forEach(r => aiKnowledgeBase.push(r));

    const dbData = getCachedDB(ctx);
    dbData.knowledge = aiKnowledgeBase;
    await flushDB(ctx);

    const db = ctx.getFirebaseDb();
    if (db && !ctx.getIsFirebaseFirestoreDisabled()) {
      syncToFirebase(dbData, ctx).catch(() => {});
    }
  } catch (e) {
    console.error('[DATABASE DELETE ERROR] Failed to delete knowledge rule:', e);
  }
}

export async function saveBalanceToDB(ctx: DbStorageContext): Promise<void> {
  try {
    const dbData = getCachedDB(ctx);
    if (!dbData.settings) dbData.settings = {};
    if (!dbData.settings.main) dbData.settings.main = {};

    const virtualBalance = ctx.getVirtualBalance();
    const startOfDayBalance = ctx.getStartOfDayBalance();
    const startOfWeekBalance = ctx.getStartOfWeekBalance();
    const lastWeekCheckTime = ctx.getLastWeekCheckTime();
    const ownerId = ctx.getOwnerId();
    const globalSettings = ctx.getGlobalSettings();

    dbData.settings.main.virtualBalance = virtualBalance;
    dbData.settings.main.startOfDayBalance = startOfDayBalance;
    dbData.settings.main.startOfWeekBalance = startOfWeekBalance;
    dbData.settings.main.lastWeekCheckTime = lastWeekCheckTime;
    dbData.settings.main.userId = ownerId;
    dbData.settings.main.lastResetDate = new Date().toISOString().split('T')[0];
    dbData.settings.main.updatedAt = Date.now();

    if (globalSettings) {
      globalSettings.virtualBalance = virtualBalance;
      globalSettings.startOfDayBalance = startOfDayBalance;
    }

    if (ctx.atomicWriteJson && ctx.getSettingsFilePath) {
      try {
        const dataToSave = { ...globalSettings, virtualBalance, startOfDayBalance };
        ctx.atomicWriteJson(ctx.getSettingsFilePath(), dataToSave);
      } catch (err) {}
    }

    await flushDB(ctx);
    const db = ctx.getFirebaseDb();
    if (db && !ctx.getIsFirebaseFirestoreDisabled()) {
      syncToFirebase(dbData, ctx).catch(() => {});
    }
  } catch (e) {
    console.error('Failed to save balance', e);
  }
}
