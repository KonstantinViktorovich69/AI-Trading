import ccxt, { Exchange } from 'ccxt';
import { manageActiveTrades, VirtualTradeEngineDependencies } from './virtualTradeEngine.ts';
import { getUnifiedTradeClosePnl } from '../quant.ts';

export interface TradeManagerServiceDependencies {
  getVirtualTrades: () => any[];
  getGlobalSettings: () => any;
  getGlobalCcxtTickers: () => Record<string, any>;
  getWsTickers: () => Record<string, any>;
  getGlobalTrueOhlcv: () => Record<string, any>;
  getGlobalMarketPulse: () => { sentiment: string; bias: number };
  getAiKnowledgeBase: () => any[];
  getCcxtClient: (config: any) => any;
  executeWithRetry: (fn: () => Promise<any>, desc: string, retries?: number, initialDelay?: number) => Promise<any>;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  saveBalanceDB: () => void;
  saveKnowledgeDB: (rule: any) => void;
  sendTelegramMessage: (text: string) => void;
  emitSignalsUpdated: () => void;
  executeRealCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT') => Promise<any>;
  executeRealPartialCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT', ratio: number) => Promise<any>;
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number) => Promise<any>;
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  runAiGeneration: (params: any) => Promise<{ text?: string }>;
  WEEX_HEADERS?: Record<string, string>;
  getVirtualBalance?: () => number;
  setVirtualBalance?: (val: number) => void;
  getStartOfDayBalance?: () => number;
  setStartOfDayBalance?: (val: number) => void;
  getStartOfDayRealBalance?: () => number;
  setStartOfDayRealBalance?: (val: number) => void;
  getStartOfWeekBalance?: () => number;
  setStartOfWeekBalance?: (val: number) => void;
  getIsCircuitBreakerActive?: () => boolean;
  setIsCircuitBreakerActive?: (val: boolean) => void;
}

export class TradeManagerService {
  private deps: TradeManagerServiceDependencies;
  private virtualBalance: number = 500;
  private startOfDayBalance: number = 500;
  private startOfDayRealBalance: number = 0;
  private startOfWeekBalance: number = 500;
  private isCircuitBreakerActive: boolean = false;
  private lastDayCheck: string = new Date().toISOString().split('T')[0];
  private cachedRealBalanceResult: any = null;
  private lastRealBalanceFetchTime: number = 0;
  private lastExchangeRateLimitTime: number = 0;

  constructor(deps: TradeManagerServiceDependencies, initialValues?: {
    virtualBalance?: number;
    startOfDayBalance?: number;
    startOfDayRealBalance?: number;
    startOfWeekBalance?: number;
  }) {
    this.deps = deps;
    if (initialValues) {
      if (typeof initialValues.virtualBalance === 'number') this.virtualBalance = initialValues.virtualBalance;
      if (typeof initialValues.startOfDayBalance === 'number') this.startOfDayBalance = initialValues.startOfDayBalance;
      if (typeof initialValues.startOfDayRealBalance === 'number') this.startOfDayRealBalance = initialValues.startOfDayRealBalance;
      if (typeof initialValues.startOfWeekBalance === 'number') this.startOfWeekBalance = initialValues.startOfWeekBalance;
    }
  }

  public getVirtualBalance(): number {
    if (this.deps.getVirtualBalance) {
      return this.deps.getVirtualBalance();
    }
    return this.virtualBalance;
  }

  public setVirtualBalance(val: number): void {
    this.virtualBalance = val;
    if (this.deps.setVirtualBalance) {
      this.deps.setVirtualBalance(val);
    }
  }

  public getStartOfDayBalance(): number {
    if (this.deps.getStartOfDayBalance) {
      return this.deps.getStartOfDayBalance();
    }
    return this.startOfDayBalance;
  }

  public setStartOfDayBalance(val: number): void {
    this.startOfDayBalance = val;
    if (this.deps.setStartOfDayBalance) {
      this.deps.setStartOfDayBalance(val);
    }
  }

  public getStartOfDayRealBalance(): number {
    if (this.deps.getStartOfDayRealBalance) {
      return this.deps.getStartOfDayRealBalance();
    }
    return this.startOfDayRealBalance;
  }

  public setStartOfDayRealBalance(val: number): void {
    this.startOfDayRealBalance = val;
    if (this.deps.setStartOfDayRealBalance) {
      this.deps.setStartOfDayRealBalance(val);
    }
  }

  public getStartOfWeekBalance(): number {
    if (this.deps.getStartOfWeekBalance) {
      return this.deps.getStartOfWeekBalance();
    }
    return this.startOfWeekBalance;
  }

  public setStartOfWeekBalance(val: number): void {
    this.startOfWeekBalance = val;
    if (this.deps.setStartOfWeekBalance) {
      this.deps.setStartOfWeekBalance(val);
    }
  }

  public getIsCircuitBreakerActive(): boolean {
    if (this.deps.getIsCircuitBreakerActive) {
      return this.deps.getIsCircuitBreakerActive();
    }
    return this.isCircuitBreakerActive;
  }

  public setIsCircuitBreakerActive(val: boolean): void {
    this.isCircuitBreakerActive = val;
    if (this.deps.setIsCircuitBreakerActive) {
      this.deps.setIsCircuitBreakerActive(val);
    }
  }

  public recordRateLimitHit(): void {
    this.lastExchangeRateLimitTime = Date.now();
  }

  public async fetchCachedRealBalance(client: any, type: string, force = false, desc = 'fetchBalance'): Promise<any> {
    const now = Date.now();
    
    // Если биржа вернула 429 в течение последних 5 минут, не трогаем ее API во избежание блокировки ключей
    if (now - this.lastExchangeRateLimitTime < 300000) {
      if (this.cachedRealBalanceResult) {
        console.log(`[BALANCE CACHE] Биржа временно на паузе после лимита (429), тихо возвращаем кэшированный баланс.`);
        return this.cachedRealBalanceResult;
      }
      console.log(`[BALANCE CACHE] Биржа на паузе после лимита (429), кэша нет, возвращаем null.`);
      return null;
    }

    const isWeex = client && (client.id === 'weex' || (client.constructor && client.constructor.name && client.constructor.name.toLowerCase().includes('weex')));
    // Кэшируем на 120 секунд для Weex и на 45 секунд для остальных бирж по умолчанию
    const cacheDuration = isWeex ? 120000 : 45000;
    if (!force && this.cachedRealBalanceResult && (now - this.lastRealBalanceFetchTime < cacheDuration)) {
      return this.cachedRealBalanceResult;
    }
    // Защита от слишком частых force-запросов (минимум 10 секунд между запросами на получение фактического баланса)
    if (force && this.cachedRealBalanceResult && (now - this.lastRealBalanceFetchTime < 10000)) {
      return this.cachedRealBalanceResult;
    }
    
    try {
      const balance = await this.deps.executeWithRetry(
        () => client.fetchBalance({ type }),
        desc,
        1 // Для баланса делаем максимум 1 попытку во избежание спама
      );
      if (balance) {
        this.cachedRealBalanceResult = balance;
        this.lastRealBalanceFetchTime = now;
      }
      return balance;
    } catch (err: any) {
      if (this.cachedRealBalanceResult) {
        console.log(`[BALANCE CACHE] Запрос fetchBalance не удался (${err.message || err}), тихо возвращаем закэшированный баланс.`);
        return this.cachedRealBalanceResult;
      }
      throw err;
    }
  }

  public checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastDayCheck) {
       this.setStartOfDayBalance(this.getVirtualBalance());
       this.setStartOfDayRealBalance(0);
       this.setIsCircuitBreakerActive(false);
       this.lastDayCheck = today;
       this.deps.saveBalanceDB();
    }
  }

  public async triggerCircuitBreaker(reason: string): Promise<void> {
    if (this.isCircuitBreakerActive) return;
    this.isCircuitBreakerActive = true;
    console.log(`[CIRCUIT BREAKER] 🛑 TRIGGERED: ${reason}`);
    
    const isRealDrawdown = reason.toLowerCase().includes('real') || reason.toLowerCase().includes('реальн');
    const alertText = isRealDrawdown 
      ? `💥 <b>CRITICAL CIRCUIT BREAKER TRIGGERED!</b>\n\nReason: ${reason}\n\nActions taken:\n1. All active REAL positions are being forcibly market-closed (virtual paper positions bypass this to protect simulator training).\n2. All limit and DCA grid orders on the exchange are being canceled.\n3. Trading has been completely locked until the daily reset.`
      : `💥 <b>CRITICAL CIRCUIT BREAKER TRIGGERED!</b>\n\nReason: ${reason}\n\nActions taken:\n1. All active paper and real positions are being forcibly market-closed.\n2. All limit and DCA grid orders on the exchange are being canceled.\n3. Trading has been completely locked until the daily reset.`;
    this.deps.sendTelegramMessage(alertText);
    
    // 1. Force close paper positions
    const virtualTrades = this.deps.getVirtualTrades();
    const currentSettings = this.deps.getGlobalSettings ? this.deps.getGlobalSettings() : {};
    for (const t of virtualTrades) {
      if (t.status === 'OPEN') {
        // Если включен режим виртуального баланса и автопилот, виртуальные позиции никогда не закрываются брейкером
        if (currentSettings?.isAutopilotEnabled && currentSettings?.tradingMode === 'virtual' && !t.isReal) {
           console.log(`[CB] Пропуск принудительного закрытия для виртуальной сделки ${t.symbol}: активен режим виртуального баланса и автопилот.`);
           continue;
        }

        // АДДИТИВНО: Проверяем, если просадка была спровоцирована реальным аккаунтом,
        // мы НЕ трогаем виртуальные/обучающиеся сделки, чтобы не искажать симулятор и RL-обучение.
        if (isRealDrawdown && !t.isReal) {
           console.log(`[CB] Пропуск принудительного закрытия для виртуальной сделки ${t.symbol}, т.к. брейкер вызван просадкой РЕАЛЬНОГО баланса.`);
           continue;
        }
        
        if (t.isAutoLearning) {
           console.log(`[CB] Пропуск принудительного закрытия для AUTO-LEARNING сделки ${t.symbol} для защиты данных обучения с подкреплением.`);
           continue;
        }

        t.status = 'CLOSED';
        // АДДИТИВНО: Расчет реального PnL вместо фиксированных -100%, если доступна текущая цена
        const lastPrice = t.currentPrice || t.entryPrice;
        t.closePrice = lastPrice;
        t.closeTime = Date.now();
        
        const { pnlUsd, leveragedPct } = getUnifiedTradeClosePnl(t.side, t.entryPrice, lastPrice, t.amount || 0, t.leverage || 1);
        t.pnl = pnlUsd;
        t.pnlPercent = (t.amount || 0) > 0 ? (t.pnl / t.amount) * 100 : Math.max(-100, leveragedPct);
        
        t.closeReason = `Forced close by Circuit Breaker: ${reason}`;
        t.notes = t.closeReason;
        this.deps.saveTradeDB(t);
      }
    }
    
    // 2. Force close real positions & cancel orders
    try {
      const globalSettings = this.deps.getGlobalSettings();
      const config = globalSettings?.exchangeApiConfig;
      if (config && config.isEnabled && config.apiKey) {
        const exClass = (ccxt as any)[config.exchange] as typeof ccxt.Exchange;
        if (exClass) {
          const defaultOptions = { defaultType: config.exchange === 'weex' ? 'swap' : 'future' };
          const client = new exClass({
            apiKey: config.apiKey,
            secret: config.apiSecret,
            password: config.password,
            enableRateLimit: true,
            options: defaultOptions,
            headers: config.exchange === 'weex' ? this.deps.WEEX_HEADERS : undefined
          });
          
          await client.loadMarkets().catch(() => {});
          
          // 1. Cancel all open orders on the exchange
          try {
            const openOrders = await client.fetchOpenOrders().catch(() => []);
            for (const order of openOrders) {
               const orderSymbol = order.symbol || '';
               const isSanctioned = virtualTrades.some(t => t.status === 'OPEN' && t.isReal && !t.isExternal && !t.isExchangeManual && t.mode !== 'EXTERNAL' && t.symbol.replace(/[\/:]/g, '').toUpperCase() === orderSymbol.replace(/[\/:]/g, '').toUpperCase());
               if (!isSanctioned) {
                  console.log(`[CB] Skipping order cancellation for manual external symbol: ${orderSymbol}`);
                  continue;
               }
               await client.cancelOrder(order.id, order.symbol).catch((oErr) => console.log(`[CB] Failed to cancel order ${order.id}: ${oErr.message}`));
            }
          } catch (oE: any) {
            console.log(`[CB] Cancel orders failure: ${oE?.message}`);
          }
          
          // 2. Close active futures positions
          try {
            const positions = await client.fetchPositions().catch(() => []);
            for (const pos of positions) {
               const amt = Number(pos.contracts || pos.amount || 0);
               if (amt > 0) {
                 const symbol = pos.symbol;
                 const isSanctioned = virtualTrades.some(t => t.status === 'OPEN' && t.isReal && !t.isExternal && !t.isExchangeManual && t.mode !== 'EXTERNAL' && t.symbol.replace(/[\/:]/g, '').toUpperCase() === symbol.replace(/[\/:]/g, '').toUpperCase());
                 if (!isSanctioned) {
                    console.log(`[CB] Skipping force-close for manual external symbol position: ${symbol}`);
                    continue;
                 }
                 const side = (pos.side === 'long' || pos.side === 'buy') ? 'sell' : 'buy';
                 console.log(`[CB] Closing active position: ${symbol} ${side} ${amt}`);
                 await client.createOrder(symbol, 'market', side, amt).catch((e: any) => console.log(`[CB] Failed to close position ${symbol}:`, e.message));
               }
            }
          } catch (pE: any) {
            console.log(`[CB] Positions close failure: ${pE?.message}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[CIRCUIT BREAKER] Error during exchange force-action execution:`, err.message);
    }
    
    this.deps.saveBalanceDB();
  }

  public async manageTradesServerSide(): Promise<void> {
    const deps: VirtualTradeEngineDependencies = {
      getVirtualTrades: this.deps.getVirtualTrades,
      getGlobalSettings: this.deps.getGlobalSettings,
      getGlobalCcxtTickers: this.deps.getGlobalCcxtTickers,
      getWsTickers: this.deps.getWsTickers,
      getGlobalTrueOhlcv: this.deps.getGlobalTrueOhlcv,
      getGlobalMarketPulse: this.deps.getGlobalMarketPulse,
      getAiKnowledgeBase: this.deps.getAiKnowledgeBase,
      getVirtualBalance: () => this.getVirtualBalance(),
      setVirtualBalance: (val: number) => this.setVirtualBalance(val),
      getStartOfDayRealBalance: () => this.getStartOfDayRealBalance(),
      setStartOfDayRealBalance: (val: number) => this.setStartOfDayRealBalance(val),
      getStartOfWeekBalance: () => this.getStartOfWeekBalance(),
      setStartOfWeekBalance: (val: number) => this.setStartOfWeekBalance(val),
      isCircuitBreakerActive: () => this.getIsCircuitBreakerActive(),
      triggerCircuitBreaker: (reason: string) => this.triggerCircuitBreaker(reason),
      getCcxtClient: this.deps.getCcxtClient,
      fetchCachedRealBalance: (client: any, type: string, force: boolean, context: string) => this.fetchCachedRealBalance(client, type, force, context),
      saveTradeDB: this.deps.saveTradeDB,
      saveBalanceDB: this.deps.saveBalanceDB,
      saveKnowledgeDB: this.deps.saveKnowledgeDB,
      sendTelegramMessage: this.deps.sendTelegramMessage,
      emitSignalsUpdated: this.deps.emitSignalsUpdated,
      executeRealCloseOnExchange: this.deps.executeRealCloseOnExchange,
      executeRealPartialCloseOnExchange: this.deps.executeRealPartialCloseOnExchange,
      executeRealOpenOnExchange: this.deps.executeRealOpenOnExchange,
      setRealTradeSlTpOnExchange: this.deps.setRealTradeSlTpOnExchange,
      runAiGeneration: this.deps.runAiGeneration
    };

    await manageActiveTrades(deps);
  }
}
