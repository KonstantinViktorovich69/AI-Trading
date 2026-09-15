import { Worker, MessagePort } from 'worker_threads';
import path from 'path';

export interface ScannerWorkerManagerContext {
  isMainThread: boolean;
  getGlobalSettings: () => any;
  getVirtualTrades: () => any[];
  getAiKnowledgeBase: () => any[];
  getGlobalTrueOhlcv: () => Record<string, any>;
  getOrderBookImbalance: () => Record<string, any>;
  getGlobalOrderBookHistory: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, any>;
  getGlobalWhales: () => Record<string, any>;
  getGlobalPumps: () => Set<string>;
  getGlobalCvd: () => Record<string, any>;
  getGlobalAtr: () => Record<string, any>;
  getCacheSignals: () => any;
  setCacheSignals: (signals: any) => void;
  getGlobalAiCommitteeCache: () => Record<string, any>;
  emitSignalsUpdated: () => void;
  runAiGeneration: (params: any) => Promise<any>;
  startMainThreadScannerFallback?: () => void;
}

export class ScannerWorkerManager {
  private ctx: ScannerWorkerManagerContext;
  private activeScannerWorker: Worker | null = null;
  private activeScannerInterval: NodeJS.Timeout | null = null;
  private currentFilename: string = '';

  constructor(ctx: ScannerWorkerManagerContext, currentFilename: string = '') {
    this.ctx = ctx;
    this.currentFilename = currentFilename;
  }

  public getWorker(): Worker | null {
    return this.activeScannerWorker;
  }

  public startScannerWorker(): void {
    if (!this.ctx.isMainThread) return;

    if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
      console.log('[WORKER_LAUNCHER] OFFLINE_MODE / TEST_MODE active: scanner background networking worker disabled.');
      return;
    }

    if (this.activeScannerInterval) {
      clearInterval(this.activeScannerInterval);
      this.activeScannerInterval = null;
    }

    console.log('[WORKER_LAUNCHER] Spawning background scanner worker thread...');
    let targetFile = this.currentFilename;
    if (!targetFile) {
      targetFile = path.join(process.cwd(), 'server.ts');
    }

    if (process.env.NODE_ENV === 'production' || targetFile.endsWith('.cjs')) {
      targetFile = path.join(process.cwd(), 'dist', 'server.cjs');
    }

    console.log(`[WORKER_LAUNCHER] Target file resolved to: ${targetFile}`);

    if (targetFile.endsWith('.ts')) {
      console.warn('[WORKER_LAUNCHER] TypeScript worker is unavailable; using main-thread scanner fallback.');
      if (this.ctx.startMainThreadScannerFallback) {
        this.ctx.startMainThreadScannerFallback();
      }
      return;
    }

    const workerOptions: any = {
      workerData: {
        globalSettings: this.ctx.getGlobalSettings()
      }
    };

    const scannerWorker = new Worker(targetFile, workerOptions);
    this.activeScannerWorker = scannerWorker;

    scannerWorker.on('message', (msg) => {
      this.handleWorkerMessage(msg, scannerWorker);
    });

    scannerWorker.on('error', (err) => {
      console.error('[WORKER_ERROR] Thread crashed:', err);
    });

    scannerWorker.on('exit', (code) => {
      console.warn(`[WORKER_EXIT] Worker shut down with exit code ${code}. Rebooting thread in 5s...`);
      this.activeScannerWorker = null;
      if (this.activeScannerInterval) {
        clearInterval(this.activeScannerInterval);
        this.activeScannerInterval = null;
      }
      setTimeout(() => this.startScannerWorker(), 5000);
    });

    // Periodically send settings, virtualTrades, and aiKnowledgeBase updates to the worker
    this.activeScannerInterval = setInterval(() => {
      this.sendStateToWorker();
    }, 10000);
  }

  public sendStateToWorker(): void {
    if (this.activeScannerWorker) {
      this.activeScannerWorker.postMessage({
        type: 'UPDATE_SETTINGS',
        payload: this.ctx.getGlobalSettings()
      });
      this.activeScannerWorker.postMessage({
        type: 'UPDATE_MAIN_STATE',
        payload: {
          virtualTrades: this.ctx.getVirtualTrades(),
          aiKnowledgeBase: this.ctx.getAiKnowledgeBase()
        }
      });
    }
  }

  public handleWorkerMessage(msg: any, workerInstance: Worker): void {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'SYNC_STATE') {
      const p = msg.payload || {};
      if (p.GLOBAL_TRUE_OHLCV) Object.assign(this.ctx.getGlobalTrueOhlcv(), p.GLOBAL_TRUE_OHLCV);
      if (p.orderBookImbalance) Object.assign(this.ctx.getOrderBookImbalance(), p.orderBookImbalance);
      if (p.GLOBAL_ORDER_BOOK_HISTORY) Object.assign(this.ctx.getGlobalOrderBookHistory(), p.GLOBAL_ORDER_BOOK_HISTORY);
      if (p.GLOBAL_CCXT_TICKERS) Object.assign(this.ctx.getGlobalCcxtTickers(), p.GLOBAL_CCXT_TICKERS);
      if (p.GLOBAL_WHALES) Object.assign(this.ctx.getGlobalWhales(), p.GLOBAL_WHALES);
      if (p.GLOBAL_CVD) Object.assign(this.ctx.getGlobalCvd(), p.GLOBAL_CVD);
      if (p.GLOBAL_ATR) Object.assign(this.ctx.getGlobalAtr(), p.GLOBAL_ATR);

      let hasUpdates = false;
      if (p.CACHE_SIGNALS) {
        this.ctx.setCacheSignals(p.CACHE_SIGNALS);
        hasUpdates = true;
      }
      if (p.GLOBAL_AI_COMMITTEE_CACHE) {
        Object.assign(this.ctx.getGlobalAiCommitteeCache(), p.GLOBAL_AI_COMMITTEE_CACHE);
        hasUpdates = true;
      }
      if (hasUpdates) {
        this.ctx.emitSignalsUpdated();
      }

      if (Array.isArray(p.GLOBAL_PUMPS)) {
        const globalPumps = this.ctx.getGlobalPumps();
        globalPumps.clear();
        p.GLOBAL_PUMPS.forEach((pump: string) => globalPumps.add(pump));
      }
    } else if (msg.type === 'LOG') {
      console.log(`[WORKER_LOG] ${msg.payload}`);
    } else if (msg.type === 'RUN_AI_GENERATION') {
      const { id, params } = msg.payload;
      this.ctx.runAiGeneration(params).then((result) => {
        workerInstance.postMessage({
          type: 'AI_GENERATION_RESPONSE',
          payload: { id, result }
        });
      }).catch((err) => {
        workerInstance.postMessage({
          type: 'AI_GENERATION_RESPONSE',
          payload: { id, error: err?.message || String(err) }
        });
      });
    }
  }

  public stop(): void {
    if (this.activeScannerInterval) {
      clearInterval(this.activeScannerInterval);
      this.activeScannerInterval = null;
    }
    if (this.activeScannerWorker) {
      try {
        this.activeScannerWorker.terminate();
      } catch (e) {}
      this.activeScannerWorker = null;
    }
  }
}
