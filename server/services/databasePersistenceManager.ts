import path from 'path';
import { readLocalDB as serviceReadLocalDB, writeLocalDB as serviceWriteLocalDB, getCachedDB as serviceGetCachedDB, flushDB as serviceFlushDB, requestDBSave as serviceRequestDBSave, syncToFirebase as serviceSyncToFirebase, createLocalBackup as serviceCreateLocalBackup, saveTradeToDB as serviceSaveTradeToDB, saveKnowledgeToDB as serviceSaveKnowledgeToDB, deleteKnowledgeFromDB as serviceDeleteKnowledgeFromDB, saveBalanceToDB as serviceSaveBalanceToDB, handleFirestoreError as serviceHandleFirestoreError, type DbStorageContext } from './dbStorageService.ts';
import { serviceLoadStateFromDB, type DbStartupSyncContext } from './dbStartupSync.ts';
import { ADVANCED_RULES } from '../db/seedData.ts';

export interface DatabasePersistenceManagerDependencies {
  dbAtomicStore: {
    loadState: <T>(fallback: T) => T;
    saveState: (data: any) => Promise<any>;
    getRevision: () => number;
  };
  getIsPostgresConfigured: () => boolean;
  syncTradesToPg?: (trades: any[]) => Promise<any>;
  syncKnowledgeToPg?: (kb: any[]) => Promise<any>;
  loadAllFromPg?: () => Promise<any>;
  getVirtualTrades: () => any[];
  getAiKnowledgeBase: () => any[];
  getProlivPeaks: () => any[];
  getAgentExchangeLogs: () => any[];
  getVirtualBalance: () => number;
  setVirtualBalance: (val: number) => void;
  getStartOfDayBalance: () => number;
  setStartOfDayBalance: (val: number) => void;
  getStartOfDayRealBalance: () => number;
  setStartOfDayRealBalance: (val: number) => void;
  getStartOfWeekBalance: () => number;
  setStartOfWeekBalance: (val: number) => void;
  getLastWeekCheckTime: () => number;
  setLastWeekCheckTime: (val: number) => void;
  getGlobalSettings: () => any;
  getOwnerId: () => string;
  getFirebaseDb: () => any;
  isMainThread: boolean;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  onTradeClosedIncremental?: (trade: any) => void;
  runRetrospectiveAnalysisBackground?: (trade: any) => Promise<void>;
  sendTelegramMessage?: (text: string) => void;
  atomicWriteJson?: (filePath: string, data: any) => void;
  settingsFilePath?: string;
}

export class DatabasePersistenceManager {
  private deps: DatabasePersistenceManagerDependencies;
  private cachedDBData: any = null;
  private dbWriteTimeout: NodeJS.Timeout | null = null;
  private isSyncingToFirebase = false;
  private isFirebaseFirestoreDisabled: boolean;
  private syncedTradesCache = new Map<string, string>();
  private syncedKnowledgeCache = new Map<string, string>();
  private lastSyncedSettingsStr = '';
  private lastSyncedReportsStr = '';
  private lastSyncedLogsStr = '';
  private openTradesCache: any[] = [];
  private startupLoadPromise: Promise<void> | null = null;

  constructor(deps: DatabasePersistenceManagerDependencies) {
    this.deps = deps;
    this.isFirebaseFirestoreDisabled = !deps.isMainThread;
  }

  public getOpenTradesCache(): any[] {
    return this.openTradesCache;
  }

  public setOpenTradesCache(trades: any[]): void {
    this.openTradesCache = trades;
  }

  public getIsFirebaseFirestoreDisabled(): boolean {
    return this.isFirebaseFirestoreDisabled;
  }

  public setIsFirebaseFirestoreDisabled(disabled: boolean): void {
    this.isFirebaseFirestoreDisabled = disabled;
  }

  public getDbStorageContext(): DbStorageContext {
    return {
      getAtomicStore: () => this.deps.dbAtomicStore,
      getCachedDBData: () => this.cachedDBData,
      setCachedDBData: (data: any) => { this.cachedDBData = data; },
      getDbWriteTimeout: () => this.dbWriteTimeout,
      setDbWriteTimeout: (timeout: NodeJS.Timeout | null) => { this.dbWriteTimeout = timeout; },
      getIsPostgresConfigured: () => this.deps.getIsPostgresConfigured(),
      syncTradesToPg: this.deps.syncTradesToPg,
      syncKnowledgeToPg: this.deps.syncKnowledgeToPg,
      getVirtualTrades: this.deps.getVirtualTrades,
      getAiKnowledgeBase: this.deps.getAiKnowledgeBase,
      getProlivPeaks: this.deps.getProlivPeaks,
      getAgentExchangeLogs: this.deps.getAgentExchangeLogs,
      getVirtualBalance: this.deps.getVirtualBalance,
      getStartOfDayBalance: this.deps.getStartOfDayBalance,
      getStartOfWeekBalance: this.deps.getStartOfWeekBalance,
      getLastWeekCheckTime: this.deps.getLastWeekCheckTime,
      getGlobalSettings: this.deps.getGlobalSettings,
      getOwnerId: () => this.deps.getOwnerId() || 'default_user',
      getFirebaseDb: this.deps.getFirebaseDb,
      getIsFirebaseFirestoreDisabled: () => this.isFirebaseFirestoreDisabled,
      setIsFirebaseFirestoreDisabled: (disabled: boolean) => { this.isFirebaseFirestoreDisabled = disabled; },
      getIsSyncingToFirebase: () => this.isSyncingToFirebase,
      setIsSyncingToFirebase: (syncing: boolean) => { this.isSyncingToFirebase = syncing; },
      getSyncedTradesCache: () => this.syncedTradesCache,
      getSyncedKnowledgeCache: () => this.syncedKnowledgeCache,
      getLastSyncedSettingsStr: () => this.lastSyncedSettingsStr,
      setLastSyncedSettingsStr: (str: string) => { this.lastSyncedSettingsStr = str; },
      getLastSyncedReportsStr: () => this.lastSyncedReportsStr,
      setLastSyncedReportsStr: (str: string) => { this.lastSyncedReportsStr = str; },
      getLastSyncedLogsStr: () => this.lastSyncedLogsStr,
      setLastSyncedLogsStr: (str: string) => { this.lastSyncedLogsStr = str; },
      onTradeClosedIncremental: this.deps.onTradeClosedIncremental,
      runRetrospectiveAnalysisBackground: this.deps.runRetrospectiveAnalysisBackground,
      sendTelegramMessage: this.deps.sendTelegramMessage,
      atomicWriteJson: this.deps.atomicWriteJson,
      getSettingsFilePath: () => this.deps.settingsFilePath || path.join(process.cwd(), 'settings.json')
    };
  }

  public getDbStartupSyncContext(): DbStartupSyncContext {
    return {
      readLocalDB: () => this.readLocalDB(),
      setCachedDBData: (data: any) => { this.cachedDBData = data; },
      getCachedDB: () => this.getCachedDB(),
      flushDB: () => this.flushDB(),
      isPostgresConfigured: () => this.deps.getIsPostgresConfigured(),
      loadAllFromPg: this.deps.loadAllFromPg,
      OWNER_ID: this.deps.getOwnerId() || 'default_user',
      getDb: this.deps.getFirebaseDb,
      isFirebaseFirestoreDisabled: this.isFirebaseFirestoreDisabled,
      isMainThread: this.deps.isMainThread,
      getGlobalSettings: this.deps.getGlobalSettings,
      getVirtualTrades: this.deps.getVirtualTrades,
      setVirtualTrades: (trades: any[]) => {
        const vt = this.deps.getVirtualTrades();
        vt.length = 0;
        trades.forEach((t: any) => vt.push(t));
      },
      getAiKnowledgeBase: this.deps.getAiKnowledgeBase,
      setAiKnowledgeBase: (kb: any[]) => {
        const k = this.deps.getAiKnowledgeBase();
        k.length = 0;
        kb.forEach((item: any) => k.push(item));
      },
      getProlivPeaks: this.deps.getProlivPeaks,
      getAgentExchangeLogs: this.deps.getAgentExchangeLogs,
      getVirtualBalance: this.deps.getVirtualBalance,
      setVirtualBalance: this.deps.setVirtualBalance,
      getStartOfDayBalance: this.deps.getStartOfDayBalance,
      setStartOfDayBalance: this.deps.setStartOfDayBalance,
      getStartOfDayRealBalance: this.deps.getStartOfDayRealBalance,
      setStartOfDayRealBalance: this.deps.setStartOfDayRealBalance,
      getStartOfWeekBalance: this.deps.getStartOfWeekBalance,
      setStartOfWeekBalance: this.deps.setStartOfWeekBalance,
      getLastWeekCheckTime: this.deps.getLastWeekCheckTime,
      setLastWeekCheckTime: this.deps.setLastWeekCheckTime,
      getOpenTradesCache: () => this.openTradesCache,
      setOpenTradesCache: (trades: any[]) => { this.openTradesCache = trades; },
      ADVANCED_RULES: (ownerId: string) => ADVANCED_RULES(ownerId),
      handleFirestoreError: (err: any, context: string) => this.handleFirestoreError(err, context),
      syncToFirebase: (dbData: any) => this.syncToFirebase(dbData),
      streamEmitter: this.deps.streamEmitter,
      getSyncedTradesCache: () => this.syncedTradesCache,
      getSyncedKnowledgeCache: () => this.syncedKnowledgeCache,
      getLastSyncedSettingsStr: () => this.lastSyncedSettingsStr,
      setLastSyncedSettingsStr: (str: string) => { this.lastSyncedSettingsStr = str; }
    };
  }

  public readLocalDB(): any {
    return serviceReadLocalDB(this.deps.dbAtomicStore);
  }

  public async writeLocalDB(data: any): Promise<void> {
    return serviceWriteLocalDB(data, this.deps.dbAtomicStore);
  }

  public getCachedDB(): any {
    return serviceGetCachedDB(this.getDbStorageContext());
  }

  public async flushDB(): Promise<void> {
    return serviceFlushDB(this.getDbStorageContext());
  }

  public async requestDBSave(): Promise<void> {
    return serviceRequestDBSave(this.getDbStorageContext());
  }

  public handleFirestoreError(err: any, context: string): void {
    return serviceHandleFirestoreError(err, context, this.getDbStorageContext());
  }

  public async syncToFirebase(dbData: any): Promise<void> {
    return serviceSyncToFirebase(dbData, this.getDbStorageContext());
  }

  public createLocalBackup(dbData: any): void {
    return serviceCreateLocalBackup(dbData);
  }

  public async loadStateFromDB(): Promise<void> {
    return serviceLoadStateFromDB(this.getDbStartupSyncContext());
  }

  public getStartupLoadPromise(): Promise<void> {
    if (!this.startupLoadPromise) {
      this.startupLoadPromise = this.loadStateFromDB();
    }
    return this.startupLoadPromise;
  }

  public async saveTradeDB(trade: any, immediate: boolean = false): Promise<void> {
    return serviceSaveTradeToDB(trade, immediate, this.getDbStorageContext());
  }

  public async saveKnowledgeDB(rule: any, immediate: boolean = false): Promise<void> {
    return serviceSaveKnowledgeToDB(rule, immediate, this.getDbStorageContext());
  }

  public async deleteKnowledgeDB(id: string): Promise<void> {
    return serviceDeleteKnowledgeFromDB(id, this.getDbStorageContext());
  }

  public async saveBalanceDB(): Promise<void> {
    return serviceSaveBalanceToDB(this.getDbStorageContext());
  }

  public runScheduledBackup(): void {
    console.log('[BACKUP] Running scheduled backups...');
    const dbData = this.getCachedDB();
    this.createLocalBackup(dbData);
    this.syncToFirebase(dbData);
  }
}
