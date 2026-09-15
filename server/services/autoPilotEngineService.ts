import { runAutopilotAndVirtualTradeEntry, type AutoPilotEngineDependencies } from './autoPilotEngine.ts';
import { runAiExpertTraderLoop, type ExpertAdvisorDependencies } from './expertAdvisorService.ts';
import { executeMainVirtualAutoEntry, executeMainRealAutoEntry } from './productionAutoEntryHandlers.ts';
import { getLossStreakSizeDampening } from '../quant.ts';

export interface AutopilotEngineServiceDependencies {
  getGlobalSettings: () => any;
  getCacheSignals: () => any;
  getVirtualTrades: () => any[];
  pushVirtualTrade: (trade: any) => void;
  getVirtualBalance: () => number;
  setVirtualBalance: (val: number) => void;
  getStartOfDayBalance: () => number;
  getGlobalCcxtTickers: () => Record<string, any>;
  getGlobalTrueOhlcv: () => Record<string, any>;
  getGlobalAdx: () => Record<string, number>;
  getGlobalAtr: () => Record<string, number>;
  getGlobalOrderBookHistory: () => Record<string, any[]>;
  getOrderBookImbalance: () => Record<string, any>;
  getGlobalMarketPulse: () => any;
  getProlivPeaks: () => any[];
  getAutopilotFailedSymbols: () => Set<string>;
  getAiKnowledgeBase: () => any[];
  readLocalDB: () => any;
  isCircuitBreakerActive: () => boolean;
  acquireExecutionLock: (symbol: string) => boolean;
  isWeexApiSupported: (symbol: string) => boolean;
  getCcxtClient: (config: any) => any;
  fetchCachedRealBalance: (client: any, type: string, force: boolean, context: string) => Promise<any>;
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number) => Promise<any>;
  executeRealCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT') => Promise<any>;
  executeRealPartialCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT', ratio: number) => Promise<any>;
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  saveBalanceDB: () => Promise<void>;
  saveSettings: () => Promise<void>;
  sendTelegramMessage: (text: string) => void;
  emitSignalsUpdated: () => void;
  runAiGeneration: (params: any) => Promise<{ text?: string }>;
  getAtomicStoreRevision?: () => number;
  getWallAdjustedTp: (symbol: string, isSell: boolean, entry: number, target: number) => number;
}

export class AutopilotEngineService {
  private deps: AutopilotEngineServiceDependencies;
  private symbolsUndergoingRealOpen = new Set<string>();
  private committeeVetoShadowStats = {
    wouldHaveBlockedCount: 0,
    totalRealEntriesChecked: 0,
    sinceTimestamp: Date.now()
  };

  constructor(deps: AutopilotEngineServiceDependencies) {
    this.deps = deps;
  }

  public getSymbolsUndergoingRealOpen(): Set<string> {
    return this.symbolsUndergoingRealOpen;
  }

  public getCommitteeVetoShadowStats() {
    return this.committeeVetoShadowStats;
  }

  public async runAutopilotAndVirtualTradeEntry(): Promise<void> {
    const autopilotDeps: AutoPilotEngineDependencies = {
      getGlobalSettings: this.deps.getGlobalSettings,
      getCacheSignals: this.deps.getCacheSignals,
      getVirtualTrades: this.deps.getVirtualTrades,
      pushVirtualTrade: this.deps.pushVirtualTrade,
      getVirtualBalance: this.deps.getVirtualBalance,
      setVirtualBalance: this.deps.setVirtualBalance,
      getStartOfDayBalance: this.deps.getStartOfDayBalance,
      getGlobalCcxtTickers: this.deps.getGlobalCcxtTickers,
      getGlobalTrueOhlcv: this.deps.getGlobalTrueOhlcv,
      getGlobalAdx: this.deps.getGlobalAdx,
      getGlobalAtr: this.deps.getGlobalAtr,
      getGlobalOrderBookHistory: this.deps.getGlobalOrderBookHistory,
      getOrderBookImbalance: this.deps.getOrderBookImbalance,
      getGlobalMarketPulse: this.deps.getGlobalMarketPulse,
      getProlivPeaks: this.deps.getProlivPeaks,
      getAutopilotFailedSymbols: this.deps.getAutopilotFailedSymbols,
      getSymbolsUndergoingRealOpen: () => this.symbolsUndergoingRealOpen,
      isCircuitBreakerActive: this.deps.isCircuitBreakerActive,
      committeeVetoShadowStats: this.committeeVetoShadowStats,
      acquireExecutionLock: this.deps.acquireExecutionLock,
      isWeexApiSupported: this.deps.isWeexApiSupported,
      getCcxtClient: this.deps.getCcxtClient,
      fetchCachedRealBalance: this.deps.fetchCachedRealBalance,
      executeRealOpenOnExchange: this.deps.executeRealOpenOnExchange,
      setRealTradeSlTpOnExchange: this.deps.setRealTradeSlTpOnExchange,
      saveTradeDB: this.deps.saveTradeDB,
      saveBalanceDB: this.deps.saveBalanceDB,
      saveSettings: this.deps.saveSettings,
      sendTelegramMessage: this.deps.sendTelegramMessage,
      getAtomicStoreRevision: this.deps.getAtomicStoreRevision || (() => 0),
      executeMainVirtualAutoEntry: (params: any, options: any) => executeMainVirtualAutoEntry(params, options),
      executeMainRealAutoEntry: (params: any, options: any) => executeMainRealAutoEntry(params, options),
      getLossStreakSizeDampening: (trades: any[]) => getLossStreakSizeDampening(trades),
      getWallAdjustedTp: this.deps.getWallAdjustedTp
    };

    await runAutopilotAndVirtualTradeEntry(autopilotDeps);
  }

  public async runAiExpertTraderLoop(): Promise<void> {
    const expertDeps: ExpertAdvisorDependencies = {
      getVirtualTrades: this.deps.getVirtualTrades,
      getGlobalSettings: this.deps.getGlobalSettings,
      getGlobalCcxtTickers: this.deps.getGlobalCcxtTickers,
      getGlobalTrueOhlcv: this.deps.getGlobalTrueOhlcv,
      getAiKnowledgeBase: this.deps.getAiKnowledgeBase,
      getVirtualBalance: this.deps.getVirtualBalance,
      readLocalDB: this.deps.readLocalDB,
      saveTradeDB: this.deps.saveTradeDB,
      emitSignalsUpdated: this.deps.emitSignalsUpdated,
      sendTelegramMessage: this.deps.sendTelegramMessage,
      executeRealCloseOnExchange: this.deps.executeRealCloseOnExchange,
      executeRealPartialCloseOnExchange: this.deps.executeRealPartialCloseOnExchange,
      executeRealOpenOnExchange: this.deps.executeRealOpenOnExchange,
      setRealTradeSlTpOnExchange: this.deps.setRealTradeSlTpOnExchange,
      runAiGeneration: this.deps.runAiGeneration
    };

    await runAiExpertTraderLoop(expertDeps);
  }
}
