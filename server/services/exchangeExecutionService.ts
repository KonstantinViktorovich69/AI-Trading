import { logStructured } from '../utils/logger.ts';
import { type RealTradeEngineDependencies, executeWithRetry as engineExecuteWithRetry, getAllConfiguredExchangeAccounts as engineGetAllConfiguredExchangeAccounts, executeRealOpenOnExchange as engineExecuteRealOpenOnExchange, setRealTradeSlTpOnExchange as engineSetRealTradeSlTpOnExchange, cancelAllOrdersAndTriggers as engineCancelAllOrdersAndTriggers, executeRealPartialCloseOnExchange as engineExecuteRealPartialCloseOnExchange, executeRealCloseOnExchange as engineExecuteRealCloseOnExchange, getCcxtClient as engineGetCcxtClient, getCcxtClientConstructionCount as engineGetCcxtClientConstructionCount, type RealTradeExecutionResult } from './realTradeEngine.ts';

export interface ExchangeExecutionServiceDependencies {
  isRealTradingAllowed: () => boolean;
  getGlobalSettings: () => any;
  saveSettings?: () => Promise<void> | void;
  autopilotFailedSymbols: Set<string>;
  isWeexApiSupported: (symbol: string) => boolean;
  formatFuturesSymbol: (symbol: string, exchange?: string) => string;
  enrichExchangeError: (err: any) => string;
  onTradePermissionDenied?: (symbol: string, errMsg: string) => Promise<void> | void;
}

export class ExchangeExecutionService {
  private deps: ExchangeExecutionServiceDependencies;
  private currentExchangePingMs = 50;
  private exchangePingHistory: { timestamp: number; pingMs: number }[] = [];
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(deps: ExchangeExecutionServiceDependencies) {
    this.deps = deps;
  }

  public getRealTradeEngineDeps(): RealTradeEngineDependencies {
    return {
      isRealTradingAllowed: this.deps.isRealTradingAllowed,
      getGlobalSettings: this.deps.getGlobalSettings,
      saveSettings: this.deps.saveSettings,
      autopilotFailedSymbols: this.deps.autopilotFailedSymbols,
      isWeexApiSupported: this.deps.isWeexApiSupported,
      formatFuturesSymbol: this.deps.formatFuturesSymbol,
      enrichExchangeError: this.deps.enrichExchangeError,
      onTradePermissionDenied: this.deps.onTradePermissionDenied
    };
  }

  public getCurrentExchangePingMs(): number {
    return this.currentExchangePingMs;
  }

  public getExchangePingHistory(): { timestamp: number; pingMs: number }[] {
    return this.exchangePingHistory;
  }

  public getCcxtClient(config: { exchange: string; apiKey: string; apiSecret?: string; password?: string; passphrase?: string }) {
    return engineGetCcxtClient(config, this.deps.isRealTradingAllowed());
  }

  public getCcxtClientConstructionCount(): number {
    return engineGetCcxtClientConstructionCount();
  }

  public getAllConfiguredExchangeAccounts() {
    return engineGetAllConfiguredExchangeAccounts(this.deps.getGlobalSettings());
  }

  public async executeWithRetry(fn: () => Promise<any>, desc: string, retries = 3, initialDelay = 1000): Promise<any> {
    return engineExecuteWithRetry(fn, desc, this.getRealTradeEngineDeps(), retries, initialDelay);
  }

  public async executeRealOpenOnExchange(
    symbol: string,
    side: string,
    amount: number,
    leverage: number,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<RealTradeExecutionResult> {
    return engineExecuteRealOpenOnExchange(symbol, side, amount, leverage, stopLoss, takeProfit, this.getRealTradeEngineDeps());
  }

  public async setRealTradeSlTpOnExchange(
    symbol: string,
    side: string,
    stopLoss?: number | null,
    takeProfit?: number | null
  ): Promise<boolean> {
    return engineSetRealTradeSlTpOnExchange(symbol, side, stopLoss, takeProfit, this.getRealTradeEngineDeps());
  }

  public async cancelAllOrdersAndTriggers(client: any, formattedSymbol: string, force = false): Promise<void> {
    return engineCancelAllOrdersAndTriggers(client, formattedSymbol, this.getRealTradeEngineDeps(), force);
  }

  public async executeRealPartialCloseOnExchange(symbol: string, side: string, ratio: number): Promise<RealTradeExecutionResult> {
    return engineExecuteRealPartialCloseOnExchange(symbol, side, ratio, this.getRealTradeEngineDeps());
  }

  public async executeRealCloseOnExchange(symbol: string, side: string): Promise<RealTradeExecutionResult> {
    return engineExecuteRealCloseOnExchange(symbol, side, this.getRealTradeEngineDeps());
  }

  public async pingExchangeServer(): Promise<void> {
    try {
      const config = this.deps.getGlobalSettings()?.exchangeApiConfig;
      if (config && config.isEnabled && config.apiKey) {
        const client = this.getCcxtClient(config);
        if (client) {
          const start = Date.now();
          if (client.has['fetchTime']) {
            await client.fetchTime();
          } else if (client.has['fetchStatus']) {
            await client.fetchStatus().catch(() => {});
          } else {
            await client.fetchBalance().catch(() => {});
          }
          const diff = Date.now() - start;
          this.currentExchangePingMs = diff;
          this.exchangePingHistory.push({ timestamp: Date.now(), pingMs: diff });
          if (this.exchangePingHistory.length > 200) this.exchangePingHistory.shift();

          if (diff > 300) {
            logStructured('warn', 'LATENCY', `High execution latency detected: ${diff}ms. Autopilot orders may experience slippage!`, undefined, { pingMs: diff });
          } else {
            logStructured('info', 'LATENCY', `Raw connection response delay: ${diff}ms`, undefined, { pingMs: diff });
          }
        }
      }
    } catch (err: any) {
      logStructured('warn', 'LATENCY', `Unable to estimate API ping response: ${err.message || err}`);
    }
  }

  public startPingMonitor(intervalMs = 15000): void {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      this.pingExchangeServer();
    }, intervalMs);
  }

  public stopPingMonitor(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
