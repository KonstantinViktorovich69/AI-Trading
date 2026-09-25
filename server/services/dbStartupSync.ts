import { processIncomingStateMessage } from './stateSync.ts';
import { withFirestoreTimeout } from './dbStorageService.ts';
import { ensureHistoricalDataSeeded } from '../db/seedData.ts';
import { partitionTradesForArchive, appendTradesToArchive } from './tradeArchive.ts';
import { updatePatternBlacklistFromStats } from './signalEngine.ts';

export interface AgentExchangeLog {
  id: string;
  timestamp: number;
  fromAgent: string;
  toAgent: string;
  message: string;
  details?: string;
  type?: 'info' | 'warning' | 'error' | 'success';
}

export interface DbStartupSyncContext {
  readLocalDB: () => any;
  setCachedDBData: (data: any) => void;
  getCachedDB: () => any;
  flushDB: () => Promise<void>;
  isPostgresConfigured: () => boolean;
  loadAllFromPg?: () => Promise<any>;
  OWNER_ID: string;
  getDb: () => any;
  isFirebaseFirestoreDisabled: boolean;
  isMainThread: boolean;
  getGlobalSettings: () => any;
  getVirtualTrades: () => any[];
  setVirtualTrades: (trades: any[]) => void;
  getAiKnowledgeBase: () => any[];
  setAiKnowledgeBase: (kb: any[]) => void;
  getProlivPeaks: () => any[];
  getAgentExchangeLogs: () => AgentExchangeLog[];
  getVirtualBalance: () => number;
  setVirtualBalance: (bal: number) => void;
  getStartOfDayBalance: () => number;
  setStartOfDayBalance: (bal: number) => void;
  getStartOfDayRealBalance: () => number;
  setStartOfDayRealBalance: (bal: number) => void;
  getStartOfWeekBalance: () => number;
  setStartOfWeekBalance: (bal: number) => void;
  getLastWeekCheckTime: () => number;
  setLastWeekCheckTime: (time: number) => void;
  getOpenTradesCache: () => any[];
  setOpenTradesCache: (trades: any[]) => void;
  ADVANCED_RULES: (ownerId: string) => any[];
  handleFirestoreError: (err: any, context: string) => void;
  syncToFirebase: (dbData: any) => Promise<any>;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  getSyncedTradesCache: () => Map<string, string>;
  getSyncedKnowledgeCache: () => Map<string, string>;
  getLastSyncedSettingsStr: () => string;
  setLastSyncedSettingsStr: (str: string) => void;
}

export async function serviceLoadStateFromDB(ctx: DbStartupSyncContext): Promise<void> {
  if (!ctx.isMainThread) return;
  try {
    const dbData = ctx.readLocalDB();
    ctx.setCachedDBData(dbData);

    if (ctx.isPostgresConfigured() && typeof ctx.loadAllFromPg === 'function') {
      try {
        console.log("[STARTUP] Checking PostgreSQL database for remote backup...");
        const pgData = await ctx.loadAllFromPg();
        let pgModified = false;
        if (pgData) {
          if (Array.isArray(pgData.trades) && pgData.trades.length > 0) {
            const tradeMap = new Map();
            (dbData.trades || []).forEach((t: any) => tradeMap.set(t.id, t));
            pgData.trades.forEach((t: any) => tradeMap.set(t.id, t));
            dbData.trades = Array.from(tradeMap.values());
            pgModified = true;
          }
          if (Array.isArray(pgData.knowledge) && pgData.knowledge.length > 0) {
            const kbMap = new Map();
            (dbData.knowledge || []).forEach((k: any) => kbMap.set(k.id, k));
            pgData.knowledge.forEach((k: any) => kbMap.set(k.id, k));
            dbData.knowledge = Array.from(kbMap.values());
            pgModified = true;
          }
        }
        if (pgModified) {
          await ctx.flushDB();
        }
      } catch (pgErr: any) {
        console.error("[STARTUP] Error loading state from PostgreSQL:", pgErr.message);
      }
    }

    const ownerId = ctx.OWNER_ID || "default_user";
    const db = ctx.getDb();

    // Asynchronously restore settings, trades, knowledge, reports and logs on server start if Firebase is enabled
    if (db && !ctx.isFirebaseFirestoreDisabled) {
      try {
        console.log("[STARTUP] Checking Cloud Firestore for remote backup (parallel fetch)...");
        
        const [settingsRes, tradesRes, kbRes, reportsRes, logsRes] = await Promise.allSettled([
          withFirestoreTimeout(
            db.collection('users').doc(ownerId).collection('settings').doc('main').get(),
            2500,
            "startupLoadSettings"
          ),
          withFirestoreTimeout(
            db.collection('users').doc(ownerId).collection('trades').limit(500).get(),
            2500,
            "startupLoadTrades"
          ),
          withFirestoreTimeout(
            db.collection('users').doc(ownerId).collection('knowledge').get(),
            2500,
            "startupLoadKnowledge"
          ),
          withFirestoreTimeout(
            db.collection('users').doc(ownerId).collection('reports').doc('performance').get(),
            2500,
            "startupLoadReports"
          ),
          withFirestoreTimeout(
            db.collection('users').doc(ownerId).collection('logs').doc('exchange').get(),
            2500,
            "startupLoadLogs"
          )
        ]);

        // 1. Process Settings
        if (settingsRes.status === 'fulfilled' && settingsRes.value && (settingsRes.value as any).exists) {
          const settingsDoc = settingsRes.value as any;
          const remoteSettings = settingsDoc.data();
          const localUpdatedAt = dbData.settings?.main?.updatedAt || 0;
          const remoteUpdatedAt = remoteSettings?.main?.updatedAt || 0;
          
          if (remoteUpdatedAt > localUpdatedAt) {
            const preservedLocalBalance = dbData.settings?.main?.virtualBalance;
            dbData.settings = remoteSettings ? { ...dbData.settings, ...remoteSettings } : dbData.settings;
            if (typeof preservedLocalBalance === 'number' && !isNaN(preservedLocalBalance) && (typeof dbData.settings?.main?.virtualBalance !== 'number' || isNaN(dbData.settings.main.virtualBalance))) {
              if (!dbData.settings) dbData.settings = {};
              if (!dbData.settings.main) dbData.settings.main = {};
              dbData.settings.main.virtualBalance = preservedLocalBalance;
            }
            console.log(`[STARTUP] Restored settings from Firestore (remote is newer: ${remoteUpdatedAt} vs local ${localUpdatedAt}).`);
          } else {
            console.log(`[STARTUP] Kept local settings (local is newer or equal: ${localUpdatedAt} vs remote ${remoteUpdatedAt}).`);
            if (db && !ctx.isFirebaseFirestoreDisabled) {
              db.collection('users').doc(ownerId).collection('settings').doc('main')
                .set(dbData.settings, { merge: true })
                .then(() => console.log("[STARTUP] Uploaded newer local settings to Firestore successfully."))
                .catch((err: any) => ctx.handleFirestoreError(err, "startupSettingsSync"));
            }
          }
        }

        // 2. Process Trades
        if (tradesRes.status === 'fulfilled' && tradesRes.value && !(tradesRes.value as any).empty) {
          const tradesSnap = tradesRes.value as any;
          const remoteTrades: any[] = [];
          tradesSnap.forEach((doc: any) => remoteTrades.push(doc.data()));
          
          const localTradesMap = new Map();
          if (Array.isArray(dbData.trades)) {
            dbData.trades.forEach((t: any) => { if (t && t.id) localTradesMap.set(String(t.id), t); });
          }
          remoteTrades.forEach((t: any) => { if (t && t.id) localTradesMap.set(String(t.id), t); });
          dbData.trades = Array.from(localTradesMap.values());
          console.log(`[STARTUP] Merged Firestore trades backup. Total trades: ${dbData.trades.length} (Restored ${remoteTrades.length} from Cloud).`);
        }

        // 3. Process Knowledge
        if (kbRes.status === 'fulfilled' && kbRes.value && !(kbRes.value as any).empty) {
          const kbSnap = kbRes.value as any;
          const remoteKnowledge: any[] = [];
          kbSnap.forEach((doc: any) => remoteKnowledge.push(doc.data()));
          
          const localKbMap = new Map();
          if (Array.isArray(dbData.knowledge)) {
            dbData.knowledge.forEach((r: any) => { if (r && r.id) localKbMap.set(String(r.id), r); });
          }
          remoteKnowledge.forEach((r: any) => { if (r && r.id) localKbMap.set(String(r.id), r); });
          dbData.knowledge = Array.from(localKbMap.values());
          console.log(`[STARTUP] Merged Firestore knowledge backup. Total rules: ${dbData.knowledge.length} (Restored ${remoteKnowledge.length} from Cloud).`);
        }

        // 4. Process Reports
        if (reportsRes.status === 'fulfilled' && reportsRes.value && (reportsRes.value as any).exists) {
          const reportsDoc = reportsRes.value as any;
          const data = reportsDoc.data();
          if (data && Array.isArray(data.reports)) {
            dbData.aiPerformanceReports = data.reports;
            console.log(`[STARTUP] Restored ${data.reports.length} AI Performance Reports (Virtual Memory) from Firestore.`);
          }
        }

        // 5. Process Logs
        if (logsRes.status === 'fulfilled' && logsRes.value && (logsRes.value as any).exists) {
          const logsDoc = logsRes.value as any;
          const data = logsDoc.data();
          if (data && Array.isArray(data.logs)) {
            dbData.agentExchangeLogs = data.logs;
            console.log(`[STARTUP] Restored ${data.logs.length} agent exchange logs from Firestore.`);
          }
        }
      } catch (fbErr: any) {
        ctx.handleFirestoreError(fbErr, "startupRestore");
      }
    }

    // Ensure baseline historical trades, memory stats, and knowledge rules are present
    ensureHistoricalDataSeeded(dbData, ownerId);

    if (!dbData.settings) dbData.settings = {};
    if (!dbData.settings.main) dbData.settings.main = {};

    const virtualTrades = ctx.getVirtualTrades();
    virtualTrades.length = 0;
    if (Array.isArray(dbData.trades)) {
      dbData.trades.forEach((trade: any) => {
        if (!trade.side) {
          trade.side = 'SHORT';
        }
        virtualTrades.push(trade);
      });
    }

    // Инициализация адаптивного блэклиста паттернов на основе исторических данных сделок
    try {
      updatePatternBlacklistFromStats(virtualTrades);
    } catch (e) {
      console.warn('[STARTUP BLACKLIST REFRESH ERROR]', e);
    }

    const globalSettings = ctx.getGlobalSettings();
    const savedVirtualBalance = (typeof dbData.settings?.main?.virtualBalance === 'number' && !isNaN(dbData.settings.main.virtualBalance) && dbData.settings.main.virtualBalance >= 0)
      ? dbData.settings.main.virtualBalance 
      : ((typeof dbData.settings?.virtualBalance === 'number' && !isNaN(dbData.settings.virtualBalance) && dbData.settings.virtualBalance >= 0)
          ? dbData.settings.virtualBalance
          : ((typeof globalSettings?.virtualBalance === 'number' && !isNaN(globalSettings.virtualBalance) && globalSettings.virtualBalance >= 0)
              ? globalSettings.virtualBalance 
              : 500));

    console.log(`[STARTUP] 💰 Restored saved virtualBalance: $${savedVirtualBalance} (from dbData.settings.main: ${dbData.settings?.main?.virtualBalance}, dbData.settings: ${dbData.settings?.virtualBalance}, globalSettings: ${globalSettings?.virtualBalance})`);

    // Calculate Equity = virtualBalance + Sum(Margin of open trades) + Unrealized PnL
    const openUserTrades = virtualTrades.filter((t: any) => t.status === 'OPEN' && !t.isReal && !t.isAutoLearning);
    const totalOpenMargin = openUserTrades.reduce((sum: number, t: any) => {
      const m = Number(t.margin || t.initialMargin || (t.amount ? t.amount / (t.leverage || 1) : 0));
      return sum + (isNaN(m) ? 0 : m);
    }, 0);
    const totalUnrealizedPnl = openUserTrades.reduce((sum: number, t: any) => {
      const p = Number(t.pnl || 0);
      return sum + (isNaN(p) ? 0 : p);
    }, 0);

    const calculatedEquity = Number((savedVirtualBalance + totalOpenMargin + totalUnrealizedPnl).toFixed(2));

    ctx.setVirtualBalance(savedVirtualBalance);
    dbData.settings.main.virtualBalance = savedVirtualBalance;
    dbData.settings.main.virtualEquity = calculatedEquity;
    if (typeof globalSettings === 'object' && globalSettings !== null) {
      globalSettings.virtualBalance = savedVirtualBalance;
      globalSettings.virtualEquity = calculatedEquity;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const lastResetDate = dbData.settings.main.lastResetDate;
    if (lastResetDate !== todayStr) {
      ctx.setStartOfDayBalance(calculatedEquity);
      dbData.settings.main.startOfDayBalance = calculatedEquity;
      dbData.settings.main.lastResetDate = todayStr;
      console.log(`[STARTUP] 📅 New day detected on startup. Resetting startOfDayBalance to Equity $${calculatedEquity.toFixed(2)} (Cash: $${savedVirtualBalance.toFixed(2)}, Open Margin: $${totalOpenMargin.toFixed(2)}, PnL: $${totalUnrealizedPnl.toFixed(2)})`);
    } else {
      const sodb = (typeof dbData.settings.main.startOfDayBalance === 'number' && !isNaN(dbData.settings.main.startOfDayBalance))
        ? dbData.settings.main.startOfDayBalance 
        : ((typeof globalSettings?.startOfDayBalance === 'number' && !isNaN(globalSettings.startOfDayBalance))
            ? globalSettings.startOfDayBalance 
            : calculatedEquity);
      ctx.setStartOfDayBalance(sodb);
    }
    
    const sowb = (typeof dbData.settings.main.startOfWeekBalance === 'number' && !isNaN(dbData.settings.main.startOfWeekBalance))
      ? dbData.settings.main.startOfWeekBalance 
      : calculatedEquity;
    ctx.setStartOfWeekBalance(sowb);
    ctx.setLastWeekCheckTime(dbData.settings.main.lastWeekCheckTime ?? Date.now());

    console.log(`[STARTUP BALANCE] 💰 Баланс инициализирован: Cash $${savedVirtualBalance.toFixed(2)} USDT | Equity $${calculatedEquity.toFixed(2)} USDT (Открытых позиций: ${openUserTrades.length}, Margin в рынке: $${totalOpenMargin.toFixed(2)}, Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}).`);
    
    const prolivPeaks = ctx.getProlivPeaks();
    prolivPeaks.length = 0;
    if (Array.isArray(dbData.prolivPeaks)) {
      dbData.prolivPeaks.forEach((p: any) => prolivPeaks.push(p));
    }
    
    const agentExchangeLogs = ctx.getAgentExchangeLogs();
    agentExchangeLogs.length = 0;
    if (Array.isArray(dbData.agentExchangeLogs)) {
      dbData.agentExchangeLogs.forEach((log: any) => agentExchangeLogs.push(log));
    } else {
      const systemTimeNow = Date.now();
      const seeds: AgentExchangeLog[] = [
        {
          id: 'seed_1',
          timestamp: systemTimeNow - 3600000,
          fromAgent: 'RETROSPECTIVE',
          toAgent: 'ARCHIVIST',
          message: 'Рекомендация по дедупликации правил индикаторов',
          details: 'Обнаружен избыток правил по индикатору RSI на таймфрейме 1m. Рекомендую заархивировать устаревшие версии со средним винрейтом < 48%.',
          type: 'warning'
        },
        {
          id: 'seed_2',
          timestamp: systemTimeNow - 3400000,
          fromAgent: 'ARCHIVIST',
          toAgent: 'RETROSPECTIVE',
          message: 'Системный клининг базы знаний завершен',
          details: 'Выполнен аудит: заархивировано 3 правила серии auto_rsi. Спецификации структуры Lean сохранены (активно: 14 правил).',
          type: 'success'
        },
        {
          id: 'seed_3',
          timestamp: systemTimeNow - 3000000,
          fromAgent: 'RETROSPECTIVE',
          toAgent: 'EXPERT',
          message: 'Анализ эффективности: Выявлены сильные паттерны шорта',
          details: 'Паттерны "1m Spire Pump Climax" и "Wick Zone Retest" показали винрейт 84.5% на последних 18 сделках по токенам PUMP. Рекомендую приоритезировать Sell Limit ордера на вершине тени.',
          type: 'success'
        },
        {
          id: 'seed_4',
          timestamp: systemTimeNow - 2500000,
          fromAgent: 'EXPERT',
          toAgent: 'RISK_MANAGER',
          message: 'Корректировка DCA коэффициентов под волатильность',
          details: 'Формирую сетку Sell Limit под ретест фитиля. В связи с аномальной волатильностью MEXC, прошу расширить шаг страховочных ордеров до 4.5%.',
          type: 'info'
        },
        {
          id: 'seed_5',
          timestamp: systemTimeNow - 2000000,
          fromAgent: 'RISK_MANAGER',
          toAgent: 'SCANNER',
          message: 'Адаптивный лимит просадки на сделку',
          details: 'На основе высокого винрейта ретеста шортов, увеличиваю максимальную загрузку депо на подтвержденный паттерн с 10% до 12%, но ввожу фильтр по объему торгов ($100k+ за 24ч).',
          type: 'info'
        }
      ];
      seeds.forEach(l => agentExchangeLogs.push(l));
      dbData.agentExchangeLogs = agentExchangeLogs;
    }
    
    // Initialize open trades cache and cleanup stale ones
    const now = Date.now();
    virtualTrades.forEach(t => {
      if (t.status === 'OPEN' && (now - t.openTime > 48 * 60 * 60 * 1000)) {
         t.status = 'CLOSED';
         t.closeReason = 'System Cleanup (Stale/Ghost)';
         t.closeTime = now;
         
         const fallbackClosePrice = t.currentPrice || t.entryPrice;
         t.closePrice = fallbackClosePrice;
         
         const unleveragedPct = t.side === 'SHORT'
           ? ((t.entryPrice - fallbackClosePrice) / t.entryPrice) * 100
           : ((fallbackClosePrice - t.entryPrice) / t.entryPrice) * 100;
         const leveragedPct = unleveragedPct * t.leverage;
         const feePercent = 0.1 * t.leverage;
         t.pnlPercent = leveragedPct - feePercent;
         t.pnl = t.amount * (t.pnlPercent / 100);
         
         if (!t.history) t.history = [];
         t.history.push({ time: now, type: 'CLOSE', price: fallbackClosePrice, amount: t.amount });
      }
    });

    let healedTradesCount = 0;
    virtualTrades.forEach(t => {
      if (t.status === 'CLOSED') {
        const hasValidPnl = typeof t.pnl === 'number' && !isNaN(t.pnl);
        const hasValidPnlPercent = typeof t.pnlPercent === 'number' && !isNaN(t.pnlPercent);
        const hasValidClosePrice = typeof t.closePrice === 'number' && !isNaN(t.closePrice) && t.closePrice > 0;

        if (!hasValidClosePrice) {
          t.closePrice = t.closePrice || t.currentPrice || t.entryPrice;
        }

        if (!hasValidPnl || !hasValidPnlPercent) {
          const fallbackClosePrice = t.closePrice || t.currentPrice || t.entryPrice;
          const unleveragedPct = t.side === 'SHORT'
            ? ((t.entryPrice - fallbackClosePrice) / t.entryPrice) * 100
            : ((fallbackClosePrice - t.entryPrice) / t.entryPrice) * 100;
          const leveragedPct = unleveragedPct * (t.leverage || 1);
          const feePercent = 0.1 * (t.leverage || 1);
          
          if (!hasValidPnlPercent) {
            t.pnlPercent = leveragedPct - feePercent;
          }
          if (!hasValidPnl) {
            t.pnl = (t.amount || 10) * ((t.pnlPercent || 0) / 100);
          }
          healedTradesCount++;
        }
      }
    });
    if (healedTradesCount > 0) {
      console.log(`[STARTUP REPAIR] Repaired PnL and closePrice variables for ${healedTradesCount} closed trades.`);
    }

    ctx.setOpenTradesCache(virtualTrades.filter(t => t.status === 'OPEN'));

    if (!dbData.aiCommitteeHistory) {
      dbData.aiCommitteeHistory = [];
    }
    
    if (Array.isArray(dbData.trades)) {
      const partitioned = partitionTradesForArchive(dbData.trades);
      dbData.trades = partitioned.keep;
      appendTradesToArchive(partitioned.toArchive);

      if (dbData.trades.length > 1000) {
        const active = dbData.trades.filter((t: any) => t.status === 'OPEN');
        const closed = dbData.trades.filter((t: any) => t.status !== 'OPEN')
          .sort((a: any, b: any) => (b.closeTime || 0) - (a.closeTime || 0))
          .slice(0, 500);
        dbData.trades = [...active, ...closed];
      }
      virtualTrades.length = 0;
      dbData.trades.forEach((t: any) => virtualTrades.push(t));
    }
    
    const mandatoryIds = ['26', '27', '28'];
    const aiKnowledgeBase = ctx.getAiKnowledgeBase();
    mandatoryIds.forEach(id => {
      const knowledge = dbData.knowledge || [];
      if (!knowledge.find((r: any) => r.id === id)) {
        const mandatoryRule = aiKnowledgeBase.find(r => r.id === id);
        if (mandatoryRule) {
          if (!dbData.knowledge) dbData.knowledge = [];
          dbData.knowledge.push(mandatoryRule);
        }
      }
    });

    const advancedRules = ctx.ADVANCED_RULES(ownerId);

    if (!Array.isArray(dbData.knowledge)) {
      dbData.knowledge = [];
    }

    const existingKnowledgeMap = new Map<string, any>();
    dbData.knowledge.forEach((r: any) => {
      if (r && r.id) {
        existingKnowledgeMap.set(String(r.id), r);
      }
    });

    advancedRules.forEach((advRule: any) => {
      const existing = existingKnowledgeMap.get(advRule.id);
      if (existing) {
        existingKnowledgeMap.set(advRule.id, {
          ...advRule,
          ...existing,
          text: advRule.text,
          agent: advRule.agent,
          userId: ownerId
        });
      } else {
        existingKnowledgeMap.set(advRule.id, { ...advRule, userId: ownerId });
      }
    });

    dbData.knowledge = Array.from(existingKnowledgeMap.values());
    aiKnowledgeBase.length = 0;
    dbData.knowledge.forEach((r: any) => aiKnowledgeBase.push(r));
    await ctx.flushDB();

    if (db && !ctx.isFirebaseFirestoreDisabled && ctx.isMainThread) {
      console.log(`[FIRESTORE INIT] isMainThread=${ctx.isMainThread}: Initializing remote synchronization...`);
      ctx.syncToFirebase(dbData).catch(fbErr => {
        console.warn("[STARTUP] Initial Firebase auto-sync postponed:", fbErr.message);
      });

      try {
        console.log("[STARTUP] Initializing real-time Firestore synchronization listeners...");

        // 1. Settings live listener
        db.collection('users').doc(ownerId).collection('settings').doc('main').onSnapshot((doc: any) => {
          try {
            if (doc.exists) {
              const remoteSettings = doc.data();
              const remoteStr = JSON.stringify(remoteSettings);
              if (ctx.getLastSyncedSettingsStr() !== remoteStr) {
                const updatedDbData = ctx.getCachedDB();
                
                const localUpdatedAt = updatedDbData.settings?.main?.updatedAt || 0;
                const remoteUpdatedAt = remoteSettings?.main?.updatedAt || 0;

                if (remoteUpdatedAt > localUpdatedAt) {
                  const oldLocalBalance = ctx.getVirtualBalance();
                  const incomingRemoteBalance = remoteSettings?.main?.virtualBalance;
                  if (typeof incomingRemoteBalance === 'number' && Math.abs(incomingRemoteBalance - oldLocalBalance) > 0.01) {
                    console.warn(`[BALANCE SYNC CONFLICT] Локальный баланс $${oldLocalBalance.toFixed(2)} (updatedAt=${localUpdatedAt}) будет заменён на значение из Firestore $${incomingRemoteBalance.toFixed(2)} (updatedAt=${remoteUpdatedAt}).`);
                  }
                  updatedDbData.settings = remoteSettings ? { ...updatedDbData.settings, ...remoteSettings } : updatedDbData.settings;
                  ctx.setLastSyncedSettingsStr(remoteStr);

                  if (updatedDbData.settings && updatedDbData.settings.main) {
                    const incomingBal = updatedDbData.settings.main.virtualBalance;
                    if (typeof incomingBal === 'number' && !isNaN(incomingBal) && incomingBal >= 0) {
                      ctx.setVirtualBalance(incomingBal);
                      ctx.setStartOfDayBalance(updatedDbData.settings.main.startOfDayBalance ?? incomingBal);
                      ctx.setStartOfWeekBalance(updatedDbData.settings.main.startOfWeekBalance ?? incomingBal);
                    }
                  }

                  console.log(`[FIRESTORE LIVESYNC] Settings synchronized from Firestore.`);
                  ctx.flushDB();
                  ctx.streamEmitter.emit('signals_updated');
                }
              }
            }
          } catch (settingsListenErr: any) {
            console.error("[FIRESTORE LIVESYNC] Error in settings doc listener:", settingsListenErr.message);
          }
        }, (err: any) => {
          ctx.handleFirestoreError(err, "settingsLiveListener");
        });

        // 2. Trades live listener
        const syncedTradesCache = ctx.getSyncedTradesCache();
        db.collection('users').doc(ownerId).collection('trades').onSnapshot((snapshot: any) => {
          try {
            if (snapshot.empty) return;
            let hasChanges = false;
            snapshot.docChanges().forEach((change: any) => {
              if (change.type === 'added' || change.type === 'modified') {
                const remoteTrade = change.doc.data();
                if (remoteTrade && remoteTrade.id) {
                  const localTrade = virtualTrades.find(t => String(t.id) === String(remoteTrade.id));
                  const remoteTradeStr = JSON.stringify(remoteTrade);
                  
                  if (!localTrade) {
                    if (!remoteTrade.side) remoteTrade.side = 'SHORT';
                    virtualTrades.push(remoteTrade as any);
                    syncedTradesCache.set(String(remoteTrade.id), remoteTradeStr);
                    hasChanges = true;
                  } else if (JSON.stringify(localTrade) !== remoteTradeStr) {
                    if (localTrade.status === 'CLOSED' && remoteTrade.status === 'OPEN') {
                      console.log(`[FIRESTORE LIVESYNC] Предотвращено перезаписывание закрытой локально сделки ${localTrade.id} удаленным статусом OPEN.`);
                      syncedTradesCache.set(String(remoteTrade.id), JSON.stringify(localTrade));
                    } else {
                      const localRev = (localTrade as any).stateRevision || 0;
                      const remoteRev = (remoteTrade as any).stateRevision || (localRev + 1);
                      const syncResult = processIncomingStateMessage(localTrade as any, {
                        type: 'STATE_UPDATE',
                        entity: 'trades',
                        revision: remoteRev,
                        emittedAt: (remoteTrade as any).updatedAt || Date.now(),
                        sender: 'FIRESTORE_LIVESYNC',
                        payload: remoteTrade
                      });
                      if (syncResult.accepted && syncResult.updatedState) {
                        Object.assign(localTrade, syncResult.updatedState);
                        if (!localTrade.side) localTrade.side = 'SHORT';
                        syncedTradesCache.set(String(remoteTrade.id), remoteTradeStr);
                        hasChanges = true;
                      }
                    }
                  }
                }
              }
            });

            if (hasChanges) {
              console.log("[FIRESTORE LIVESYNC] Trade updates detected, rebuilding memory caches...");
              ctx.setOpenTradesCache(virtualTrades.filter(t => t.status === 'OPEN'));
              const updatedDbData = ctx.getCachedDB();
              updatedDbData.trades = virtualTrades;
              ctx.flushDB();
              ctx.streamEmitter.emit('signals_updated');
            }
          } catch (tradesListenErr: any) {
            console.error("[FIRESTORE LIVESYNC] Error in trades snapshot listener:", tradesListenErr.message);
          }
        }, (err: any) => {
          ctx.handleFirestoreError(err, "tradesLiveListener");
        });

        // 3. Knowledge base live listener
        const syncedKnowledgeCache = ctx.getSyncedKnowledgeCache();
        db.collection('users').doc(ownerId).collection('knowledge').onSnapshot((snapshot: any) => {
          try {
            if (snapshot.empty) return;
            let hasChanges = false;
            snapshot.docChanges().forEach((change: any) => {
              if (change.type === 'added' || change.type === 'modified') {
                const remoteRule = change.doc.data();
                if (remoteRule && remoteRule.id) {
                  const localRule = aiKnowledgeBase.find(r => String(r.id) === String(remoteRule.id));
                  const remoteStr = JSON.stringify(remoteRule);

                  if (!localRule) {
                    aiKnowledgeBase.push(remoteRule as any);
                    syncedKnowledgeCache.set(String(remoteRule.id), remoteStr);
                    hasChanges = true;
                  } else if (JSON.stringify(localRule) !== remoteStr) {
                    const localRev = (localRule as any).stateRevision || 0;
                    const remoteRev = (remoteRule as any).stateRevision || (localRev + 1);
                    const syncResult = processIncomingStateMessage(localRule as any, {
                      type: 'STATE_UPDATE',
                      entity: 'knowledge',
                      revision: remoteRev,
                      emittedAt: (remoteRule as any).updatedAt || Date.now(),
                      sender: 'FIRESTORE_LIVESYNC',
                      payload: remoteRule
                    });
                    if (syncResult.accepted && syncResult.updatedState) {
                      Object.assign(localRule, syncResult.updatedState);
                      syncedKnowledgeCache.set(String(remoteRule.id), remoteStr);
                      hasChanges = true;
                    }
                  }
                }
              }
            });

            if (hasChanges) {
              console.log("[FIRESTORE LIVESYNC] Knowledge base updates detected in Cloud, reloading...");
              const updatedDbData = ctx.getCachedDB();
              updatedDbData.knowledge = aiKnowledgeBase;
              ctx.flushDB();
              ctx.streamEmitter.emit('signals_updated');
            }
          } catch (kbListenErr: any) {
            console.error("[FIRESTORE LIVESYNC] Error in knowledge live snap handler:", kbListenErr.message);
          }
        }, (err: any) => {
          ctx.handleFirestoreError(err, "knowledgeLiveListener");
        });

      } catch (listenerInitErr: any) {
        console.error("[STARTUP] Failed to initialize Firestore real-time snap-listeners:", listenerInitErr?.message);
      }
    }
    
    console.log(`Loaded Local Data: ${virtualTrades.length} trades, ${aiKnowledgeBase.length} rules.`);
  } catch(e) {
    console.error("Local sync error", e);
  }
}
