import { cleanSymbol } from '../utils/symbolUtils.ts';

export interface BackgroundSchedulerContext {
  isMainThread: boolean;
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getFundingRates: () => Record<string, number>;
  getHistoryData: () => Record<string, Array<{ price: number; volume: number; timestamp: number }>>;
  getGlobalFundingHistory: () => Record<string, Array<{ rate: number; time: number }>>;
  manageTradesServerSide?: () => Promise<void>;
  runAiExpertTraderLoop?: () => Promise<void>;
  runAutopilotAndVirtualTradeEntry?: () => Promise<void>;
  syncWorkerStateToMain?: () => void;
  sendSettingsToWorker?: () => void;
}

export function recordMarketHistory(ctx: BackgroundSchedulerContext, now = Date.now()): void {
  const globalTickers = ctx.getGlobalCcxtTickers();
  const fundingRates = ctx.getFundingRates();
  const historyData = ctx.getHistoryData();
  const globalFundingHistory = ctx.getGlobalFundingHistory();

  for (const exName in globalTickers) {
    const tickers = globalTickers[exName];
    if (!tickers) continue;
    for (const [symbol, ticker] of Object.entries(tickers)) {
      const sClean = cleanSymbol(symbol);
      if (!historyData[sClean]) historyData[sClean] = [];
      historyData[sClean].push({
        price: ticker.last || 0,
        volume: ticker.quoteVolume ?? ticker.volume ?? 0,
        timestamp: now
      });
      if (historyData[sClean].length > 400) {
        historyData[sClean].shift();
      }

      // Track Funding History
      const filterKey = `${exName}-${sClean}`;
      const fRate = fundingRates[sClean] ?? fundingRates[filterKey];
      if (fRate !== undefined) {
        if (!globalFundingHistory[sClean]) globalFundingHistory[sClean] = [];
        globalFundingHistory[sClean].push({ rate: fRate, time: now });
        if (globalFundingHistory[sClean].length > 48) {
          globalFundingHistory[sClean].shift();
        }
      }
    }
  }

  // Active garbage collection for stale memory elements (older than 2 hours)
  const activeCleanupThreshold = now - 2 * 60 * 60 * 1000;
  for (const key in historyData) {
    const list = historyData[key];
    if (list && list.length > 0) {
      if (list[list.length - 1].timestamp < activeCleanupThreshold) {
        delete historyData[key];
      }
    }
  }

  for (const key in globalFundingHistory) {
    const list = globalFundingHistory[key];
    if (list && list.length > 0) {
      if (list[list.length - 1].time < activeCleanupThreshold) {
        delete globalFundingHistory[key];
      }
    }
  }
}

export class BackgroundSchedulerService {
  private ctx: BackgroundSchedulerContext;
  private intervals: NodeJS.Timeout[] = [];

  constructor(ctx: BackgroundSchedulerContext) {
    this.ctx = ctx;
  }

  public recordHistory(now?: number): void {
    recordMarketHistory(this.ctx, now);
  }

  public start(): void {
    this.stop();

    // History record interval (runs every 10s)
    const histTimer = setInterval(() => {
      try {
        this.recordHistory();
      } catch (err) {
        console.error('[SCHEDULER] Error in recordHistory:', err);
      }
    }, 10000);
    this.intervals.push(histTimer);

    if (this.ctx.isMainThread) {
      if (this.ctx.manageTradesServerSide) {
        const tradeTimer = setInterval(async () => {
          try {
            await this.ctx.manageTradesServerSide?.();
          } catch (err) {
            console.error('[SCHEDULER] Error in manageTradesServerSide:', err);
          }
        }, 1000);
        this.intervals.push(tradeTimer);
      }

      if (this.ctx.runAiExpertTraderLoop) {
        const aiExpertTimer = setInterval(async () => {
          try {
            await this.ctx.runAiExpertTraderLoop?.();
          } catch (err) {
            console.error('[SCHEDULER] Error in runAiExpertTraderLoop:', err);
          }
        }, 10000);
        this.intervals.push(aiExpertTimer);
      }

      if (this.ctx.runAutopilotAndVirtualTradeEntry) {
        const autopilotTimer = setInterval(async () => {
          try {
            await this.ctx.runAutopilotAndVirtualTradeEntry?.();
          } catch (err) {
            console.error('[SCHEDULER] Error in runAutopilotAndVirtualTradeEntry:', err);
          }
        }, 4000);
        this.intervals.push(autopilotTimer);
      }

      if (this.ctx.sendSettingsToWorker) {
        const settingsSyncTimer = setInterval(() => {
          try {
            this.ctx.sendSettingsToWorker?.();
          } catch (err) {
            console.error('[SCHEDULER] Error in sendSettingsToWorker:', err);
          }
        }, 10000);
        this.intervals.push(settingsSyncTimer);
      }
    }
  }

  public stop(): void {
    for (const t of this.intervals) {
      clearInterval(t);
    }
    this.intervals = [];
  }
}
