export interface ExchangeWsManagerContext {
  getPairs: () => string[];
  getExchangeSymbols: () => Record<string, Record<string, string>>;
  getWsTickers: () => {
    Kraken: Record<string, any>;
    Kucoin: Record<string, any>;
    Bitget: Record<string, any>;
    Gateio: Record<string, any>;
    OKX: Record<string, any>;
    HTX: Record<string, any>;
    WEEX: Record<string, any>;
  };
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getGlobalLiquidations: () => Record<string, { shortsSq: number; longsSq: number; lastT: number }>;
  getGlobalWhales: () => Record<string, { amount: number; time: number }>;
  getGlobalPumps: () => Set<string>;
  getGlobalCvd: () => Record<string, { buyVol: number; sellVol: number; cvd: number }>;
  getCacheSignals: () => any;
  getVirtualTrades: () => any[];
  throttlePriceEmit: () => void;
  getExchangeLink: (exchange: string, pair: string) => string;
  updateLocalCandlesForSymbol: (cleanSym: string, finalPrice: number, volumeDelta: number) => void;
  updateSignalsCache: () => void | Promise<void>;
  logStructured?: (type: string, module: string, message: string) => void;
}

export class ExchangeWsManager {
  private ctx: ExchangeWsManagerContext;

  private liquidationsCleanupInterval: NodeJS.Timeout | null = null;

  constructor(context: ExchangeWsManagerContext) {
    this.ctx = context;
  }

  public startAll() {
    this.startCleanups();
  }

  public stopAll() {
    if (this.liquidationsCleanupInterval) clearInterval(this.liquidationsCleanupInterval);
  }

  public getWatchdogStatus() {
    return {};
  }


  private startCleanups() {
    this.liquidationsCleanupInterval = setInterval(() => {
      const now = Date.now();
      const globalLiquidations = this.ctx.getGlobalLiquidations();
      for (const sym in globalLiquidations) {
        if (now - globalLiquidations[sym].lastT > 15 * 60 * 1000) {
          delete globalLiquidations[sym];
        } else {
          globalLiquidations[sym].shortsSq *= 0.5;
          globalLiquidations[sym].longsSq *= 0.5;
        }
      }

      const globalWhales = this.ctx.getGlobalWhales();
      for (const sym in globalWhales) {
        if (now - globalWhales[sym].time > 5 * 60 * 1000) {
          delete globalWhales[sym];
        }
      }

      const globalPumps = this.ctx.getGlobalPumps();
      const toDelete = Array.from(globalPumps).filter((str) => {
        const ts = parseInt(str.split('-')[1]);
        return !ts || now - ts > 5 * 60 * 1000;
      });
      toDelete.forEach((x) => globalPumps.delete(x));
    }, 60000);
  }
}
