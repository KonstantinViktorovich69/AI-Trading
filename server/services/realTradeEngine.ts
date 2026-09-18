import ccxt from 'ccxt';
import { logStructured } from '../utils/logger.ts';
import { DEFAULT_OTE_TIMEOUT_MS, hasOteEntryTimedOut } from './oteEntryCalculator.ts';

export interface ExchangeApiConfig {
  id?: string;
  name?: string;
  exchange: string;
  apiKey: string;
  apiSecret?: string;
  secretKey?: string;
  password?: string;
  passphrase?: string;
  isEnabled: boolean;
  multiAccounts?: ExchangeApiConfig[];
}

export interface RealTradeExecutionResult {
  accountName?: string;
  success: boolean;
  data?: any;
  entryPrice?: number;
  error?: string;
  warning?: string;
  closedContracts?: number;
  multiAccountExecutedCount?: number;
  totalConfiguredAccounts?: number;
}

export interface RealTradeEngineDependencies {
  isRealTradingAllowed: () => boolean;
  getGlobalSettings: () => any;
  saveSettings?: () => void;
  autopilotFailedSymbols?: Set<string>;
  isWeexApiSupported?: (symbol: string) => boolean;
  formatFuturesSymbol: (symbol: string, exchange?: string) => string;
  enrichExchangeError: (err: any) => string;
  onTradePermissionDenied?: (symbol: string, errMsg: string) => Promise<void> | void;
}

export const WEEX_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'application/json, text/plain, */*'
};

export let ccxtClientConstructionCount = 0;
const ccxtClientPool: Record<string, any> = {};

const configuredMarginSymbols = new Set<string>();
const configuredLeverageSymbols = new Map<string, number>();
const lastCancelAllOrdersAndTriggers = new Map<string, number>();
let lastExchangeRateLimitTime = 0;

export function getCcxtClientConstructionCount(): number {
  return ccxtClientConstructionCount;
}

export function resetCcxtClientPool(): void {
  for (const k in ccxtClientPool) {
    delete ccxtClientPool[k];
  }
  ccxtClientConstructionCount = 0;
  configuredMarginSymbols.clear();
  configuredLeverageSymbols.clear();
  lastCancelAllOrdersAndTriggers.clear();
  lastExchangeRateLimitTime = 0;
}

export function getCcxtClient(
  config: { exchange: string; apiKey: string; apiSecret?: string; secretKey?: string; password?: string; passphrase?: string },
  isRealAllowed = true
): any | null {
  if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1' || !isRealAllowed) {
    return null;
  }
  if (!config || !config.apiKey) return null;
  const exchange = (config.exchange || '').toLowerCase();
  let cleanPassword = config.password || config.passphrase;
  if (['bybit', 'binance', 'mexc'].includes(exchange)) {
    cleanPassword = undefined;
  }
  const secret = config.apiSecret || config.secretKey || '';
  const key = `${exchange}:${config.apiKey}:${secret ? secret.slice(-6) : ''}:${cleanPassword ? cleanPassword.slice(-4) : ''}`;
  if (ccxtClientPool[key]) {
    return ccxtClientPool[key];
  }
  const exClass = (ccxt as any)[exchange] as typeof ccxt.Exchange;
  if (!exClass) return null;

  ccxtClientConstructionCount++;
  const defaultOptions = { defaultType: exchange === 'weex' ? 'swap' : 'future' };
  const clientOptions: any = {
    apiKey: config.apiKey,
    secret: secret,
    enableRateLimit: true,
    options: defaultOptions,
    headers: exchange === 'weex' ? WEEX_HEADERS : undefined
  };
  if (cleanPassword) {
    clientOptions.password = cleanPassword;
  }
  const client = new exClass(clientOptions);
  ccxtClientPool[key] = client;
  return client;
}

export async function executeWithRetry(
  fn: () => Promise<any>,
  desc: string,
  deps: RealTradeEngineDependencies,
  retries = 3,
  initialDelay = 1000
): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const errMsg = err?.message || String(err);

      // Intercept false positive success responses incorrectly thrown by CCXT (e.g., Code 200/Success from Weex)
      const isWeexFalsePositiveSuccess =
        (errMsg.includes('"msg":"success"') || errMsg.includes('"code":"200"') || errMsg.includes('"code":200')) &&
        (errMsg.toLowerCase().includes('weex') || errMsg.toLowerCase().includes('success') || errMsg.includes('200'));
      if (
        isWeexFalsePositiveSuccess &&
        !errMsg.includes('"code":-') &&
        !errMsg.includes('"code":"-') &&
        !errMsg.toLowerCase().includes('rate limit') &&
        !errMsg.includes('429')
      ) {
        logStructured('success', 'CCXT', `Intercepted Weex success response during ${desc}`, undefined, { response: errMsg });
        return { success: true, code: '200', msg: 'success' };
      }

      // Check for non-retryable errors such as missing permission for trading pair (WEEX -1058), invalid API keys, signature issues, etc.
      const isPermissionOrNoPairError =
        errMsg.includes('-1058') ||
        errMsg.toLowerCase().includes('no permission') ||
        errMsg.includes('-1052') ||
        errMsg.includes('-1053') ||
        errMsg.includes('-1055') ||
        errMsg.includes('-1056') ||
        errMsg.includes('-1057') ||
        errMsg.toLowerCase().includes('permissiondenied') ||
        errMsg.toLowerCase().includes('permission denied') ||
        errMsg.toLowerCase().includes('invalid api') ||
        errMsg.toLowerCase().includes('apikey') ||
        errMsg.toLowerCase().includes('signature');

      const isInsufficientFunds =
        err?.name?.includes('InsufficientFunds') ||
        errMsg.includes('-1054') ||
        errMsg.toLowerCase().includes('insufficient funds') ||
        errMsg.toLowerCase().includes('not enough') ||
        errMsg.toLowerCase().includes('margin available amount not enough') ||
        errMsg.toLowerCase().includes('margin not enough');

      if (isInsufficientFunds) {
        logStructured('error', 'CCXT', `Stop retrying because account has insufficient funds/margin for ${desc}: ${errMsg}`);
        throw err;
      }

      if (isPermissionOrNoPairError) {
        try {
          const match = desc.match(/for\s+([A-Z0-9_\/:-]+)/i);
          if (match && match[1]) {
            const rawSymbol = match[1];
            const symbolToBlacklist = rawSymbol.split('/')[0].split(':')[0].toUpperCase().trim();
            if (symbolToBlacklist && deps.autopilotFailedSymbols) {
              if (!deps.autopilotFailedSymbols.has(symbolToBlacklist)) {
                logStructured('warn', 'AUTOPILOT', `Heuristically blacklisting coin due to API permission restriction on ${desc}`, symbolToBlacklist, { error: errMsg, operation: desc });
                deps.autopilotFailedSymbols.add(symbolToBlacklist);
                if (deps.saveSettings) {
                  deps.saveSettings();
                }
              }
              if (deps.onTradePermissionDenied) {
                await deps.onTradePermissionDenied(symbolToBlacklist, errMsg);
              }
            }
          }
        } catch (blacklistErr: any) {
          logStructured('error', 'SYSTEM', `Fail setting failover auto-blacklist: ${blacklistErr.message || blacklistErr}`);
        }

        if (desc.toLowerCase().includes('cancelallorders') || desc.toLowerCase().includes('cancelorder') || desc.toLowerCase().includes('cleanup')) {
          return null;
        }
        throw err;
      }

      const isRateLimit = err?.name?.includes('RateLimit') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('429');
      if (isRateLimit) {
        lastExchangeRateLimitTime = Date.now();
      }

      let maxRetries = retries;
      const isBalanceOrNonCritical = desc.toLowerCase().includes('balance') || desc.toLowerCase().includes('drawdown') || desc.toLowerCase().includes('stats') || desc.toLowerCase().includes('telemetry') || desc.toLowerCase().includes('ping') || desc.toLowerCase().includes('advisor');
      if (isRateLimit) {
        if (isBalanceOrNonCritical) {
          maxRetries = retries;
        } else {
          maxRetries = Math.max(retries, 6);
        }
      }

      if (attempt >= maxRetries) {
        throw err;
      }

      const backoffFactor = isRateLimit ? 3.5 : 2.0;
      const baseDelay = isRateLimit ? 2500 : initialDelay;
      const delay = baseDelay * Math.pow(backoffFactor, attempt - 1) * (0.8 + Math.random() * 0.4);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export function getAllConfiguredExchangeAccounts(globalSettings: any): Array<ExchangeApiConfig> {
  const primary = globalSettings?.exchangeApiConfig;
  const accounts: Array<ExchangeApiConfig> = [];

  if (primary && primary.isEnabled && primary.apiKey) {
    accounts.push({
      id: 'primary',
      name: primary.name || `Основной (${(primary.exchange || 'weex').toUpperCase()})`,
      exchange: primary.exchange || 'weex',
      apiKey: primary.apiKey?.trim(),
      apiSecret: (primary.apiSecret || primary.secretKey)?.trim(),
      secretKey: (primary.secretKey || primary.apiSecret)?.trim(),
      password: (primary.password || primary.passphrase)?.trim(),
      passphrase: (primary.passphrase || primary.password)?.trim(),
      isEnabled: true
    });
  }

  if (primary && Array.isArray(primary.multiAccounts)) {
    primary.multiAccounts.forEach((acc: any, idx: number) => {
      if (acc && acc.isEnabled && acc.apiKey) {
        if (!accounts.some(a => a.apiKey === acc.apiKey?.trim())) {
          accounts.push({
            id: acc.id || `multi_${idx}_${Date.now()}`,
            name: acc.name || `Копи-аккаунт #${idx + 1} (${(acc.exchange || 'weex').toUpperCase()})`,
            exchange: acc.exchange || 'weex',
            apiKey: acc.apiKey?.trim(),
            apiSecret: (acc.apiSecret || acc.secretKey)?.trim(),
            secretKey: (acc.secretKey || acc.apiSecret)?.trim(),
            password: (acc.password || acc.passphrase)?.trim(),
            passphrase: (acc.passphrase || acc.password)?.trim(),
            isEnabled: true
          });
        }
      }
    });
  }

  return accounts;
}

export async function cancelAllOrdersAndTriggers(
  client: any,
  formattedSymbol: string,
  deps: RealTradeEngineDependencies,
  force = false
): Promise<void> {
  const isWeex = client.id === 'weex';
  const cacheKey = `${client.id}:${formattedSymbol}`;
  const now = Date.now();
  const lastTime = lastCancelAllOrdersAndTriggers.get(cacheKey) || 0;

  if (!force && now - lastTime < 10000) {
    return;
  }
  lastCancelAllOrdersAndTriggers.set(cacheKey, now);

  let cancelAllSucceeded = false;
  let cancelTriggerSucceeded = false;

  try {
    if (client.has['cancelAllOrders']) {
      await executeWithRetry(
        () => client.cancelAllOrders(formattedSymbol),
        `cancelAllOrders for ${formattedSymbol}`,
        deps
      ).then(() => {
        cancelAllSucceeded = true;
      }).catch(() => {});

      const triggerBulkParams = [
        { trigger: true },
        { stop: true },
        { planType: 'plan' },
        { planType: 'profit_loss' }
      ];

      for (const params of triggerBulkParams) {
        try {
          await executeWithRetry(
            () => client.cancelAllOrders(formattedSymbol, params),
            `cancelAllOrders with params ${JSON.stringify(params)} for ${formattedSymbol}`,
            deps
          );
          cancelTriggerSucceeded = true;
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (!force && cancelAllSucceeded && cancelTriggerSucceeded) {
    return;
  }

  try {
    if (client.has['fetchOpenOrders']) {
      const openOrders = await executeWithRetry(
        () => client.fetchOpenOrders(formattedSymbol),
        `fetchOpenOrders for cleanup of ${formattedSymbol}`,
        deps
      ).catch(() => []);

      for (const ord of openOrders) {
        await executeWithRetry(
          () => client.cancelOrder(ord.id, formattedSymbol),
          `cancelOrder ${ord.id} for cleanup of ${formattedSymbol}`,
          deps
        ).catch(() => {});
      }

      const needsTriggerCleanup = isWeex || client.id === 'mexc' || client.id === 'bybit' || client.id === 'okx' || client.id === 'bingx' || force;
      if (needsTriggerCleanup) {
        const triggerParamsList = [
          { trigger: true },
          { stop: true },
          { planType: 'plan' },
          { planType: 'profit_loss' }
        ];

        const seenTriggerOrderIds = new Set<string>();

        for (const params of triggerParamsList) {
          try {
            const openTriggers = await executeWithRetry(
              () => client.fetchOpenOrders(formattedSymbol, undefined, undefined, params),
              `fetchOpenOrders with ${JSON.stringify(params)} for cleanup of ${formattedSymbol}`,
              deps
            ).catch(() => []);

            for (const ord of openTriggers) {
              if (seenTriggerOrderIds.has(ord.id)) continue;
              seenTriggerOrderIds.add(ord.id);

              await executeWithRetry(
                () => client.cancelOrder(ord.id, formattedSymbol, params),
                `cancelOrder trigger ${ord.id} for cleanup of ${formattedSymbol}`,
                deps
              ).catch(() => {});
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

export async function executeSingleAccountOpen(
  config: ExchangeApiConfig,
  symbol: string,
  side: string,
  amount: number,
  leverage: number,
  stopLoss?: number,
  takeProfit?: number,
  deps?: RealTradeEngineDependencies
): Promise<RealTradeExecutionResult> {
  const isRealAllowed = deps ? deps.isRealTradingAllowed() : true;
  try {
    const client = getCcxtClient(config, isRealAllowed);
    if (!client) {
      return { accountName: config.name, success: false, error: 'Не удалось инициализировать CCXT клиент' };
    }

    const formattedSymbol = deps?.formatFuturesSymbol ? deps.formatFuturesSymbol(symbol, config.exchange) : symbol;
    const upperSym = symbol.toUpperCase().trim();
    const base = upperSym.split(/[\/:-]/)[0];
    if (config.exchange === 'weex' && deps) {
      if ((deps.isWeexApiSupported && !deps.isWeexApiSupported(symbol)) || deps.autopilotFailedSymbols?.has(base)) {
        return { accountName: config.name, success: false, error: `Пара ${symbol} не поддерживается для API-торговли на бирже WEEX.` };
      }
    }

    const effectiveDeps = deps || {
      isRealTradingAllowed: () => isRealAllowed,
      getGlobalSettings: () => ({}),
      formatFuturesSymbol: (s) => s,
      enrichExchangeError: (e) => e?.message || String(e)
    };

    const market = await executeWithRetry(
      async () => {
        if (!client.markets || Object.keys(client.markets).length === 0) {
          await client.loadMarkets();
        }
        return client.market(formattedSymbol);
      },
      `loadMarkets for ${formattedSymbol}`,
      effectiveDeps
    );

    const marginCacheKey = `${config.exchange}:${formattedSymbol}`;
    if (!configuredMarginSymbols.has(marginCacheKey)) {
      try {
        if (client.has['setMarginMode']) {
          await executeWithRetry(
            () => client.setMarginMode('isolated', formattedSymbol),
            `setMarginMode to isolated for ${formattedSymbol}`,
            effectiveDeps
          ).then(() => {
            configuredMarginSymbols.add(marginCacheKey);
          }).catch(() => {
            configuredMarginSymbols.add(marginCacheKey);
          });
        } else {
          configuredMarginSymbols.add(marginCacheKey);
        }
      } catch (_) {}
    }

    const leverageCacheKey = `${config.exchange}:${formattedSymbol}`;
    if (leverage && configuredLeverageSymbols.get(leverageCacheKey) !== leverage) {
      if (client.has['setLeverage']) {
        const levParams = config.exchange === 'weex' ? { marginMode: 'isolated' } : {};
        await executeWithRetry(
          () => client.setLeverage(leverage, formattedSymbol, levParams),
          `setLeverage to ${leverage}x for ${formattedSymbol}`,
          effectiveDeps
        ).then(() => {
          configuredLeverageSymbols.set(leverageCacheKey, leverage);
        }).catch(() => {
          configuredLeverageSymbols.set(leverageCacheKey, leverage);
        });
      }
    }

    const orderSide = side === 'BUY' || side === 'LONG' ? 'buy' : 'sell';
    const ticker = await executeWithRetry(
      () => client.fetchTicker(formattedSymbol),
      `fetchTicker for ${formattedSymbol}`,
      effectiveDeps
    );
    const price = ticker.last || 1;
    if (!isFinite(price) || isNaN(price) || price <= 0) {
      return { accountName: config.name, success: false, error: 'Некорректная рыночная цена (NaN или <= 0)' };
    }
    let contracts = (amount * (leverage || 1)) / price;
    if (config.exchange !== 'weex' && market.contractSize) {
      contracts = contracts / market.contractSize;
    }

    if (market.limits?.amount?.min !== undefined) {
      if (contracts < market.limits.amount.min) {
        contracts = market.limits.amount.min;
      }
    }

    try {
      const precisionStr = client.amountToPrecision(formattedSymbol, contracts);
      contracts = parseFloat(precisionStr);
    } catch (_) {
      contracts = Number(contracts.toFixed(4));
    }

    if (!isFinite(contracts) || isNaN(contracts) || contracts <= 0) {
      return { accountName: config.name, success: false, error: 'Некорректный объем позиции (NaN или <= 0)' };
    }

    const params: any = {};
    if (stopLoss && isFinite(stopLoss) && stopLoss > 0) params.stopLossPrice = stopLoss;
    if (takeProfit && isFinite(takeProfit) && takeProfit > 0) params.takeProfitPrice = takeProfit;

    const order = await executeWithRetry(
      () => client.createOrder(formattedSymbol, 'market', orderSide, contracts, undefined, params),
      `createOrder (${orderSide}) for ${formattedSymbol}`,
      effectiveDeps
    );
    const entryPrice = order.average || order.price || price;
    return { accountName: config.name, success: true, data: order, entryPrice };
  } catch (err: any) {
    const errorMsg = deps?.enrichExchangeError ? deps.enrichExchangeError(err) : (err.message || String(err));
    return { accountName: config.name, success: false, error: errorMsg };
  }
}

export async function executeRealOpenOnExchange(
  symbol: string,
  side: string,
  amount: number,
  leverage: number,
  stopLoss?: number,
  takeProfit?: number,
  deps?: RealTradeEngineDependencies
): Promise<RealTradeExecutionResult> {
  try {
    if (deps && !deps.isRealTradingAllowed()) {
      return { success: false, error: 'Реальная торговля заблокирована системным флагом ENABLE_REAL_TRADING=false' };
    }

    const settings = deps ? deps.getGlobalSettings() : {};
    const activeAccounts = getAllConfiguredExchangeAccounts(settings);
    if (activeAccounts.length === 0) {
      return { success: false, error: 'API биржи не настроено' };
    }

    const results = await Promise.allSettled(
      activeAccounts.map(acc => executeSingleAccountOpen(acc, symbol, side, amount, leverage, stopLoss, takeProfit, deps))
    );

    const successfulRuns = results
      .filter((r): r is PromiseFulfilledResult<RealTradeExecutionResult> => r.status === 'fulfilled' && r.value.success)
      .map(r => r.value);

    if (successfulRuns.length > 0) {
      const primaryRun = successfulRuns[0];
      return {
        success: true,
        data: primaryRun.data,
        entryPrice: primaryRun.entryPrice,
        multiAccountExecutedCount: successfulRuns.length,
        totalConfiguredAccounts: activeAccounts.length
      };
    } else {
      const firstError = results.find(r => r.status === 'fulfilled' && !r.value.success) as any;
      const errorMsg = firstError ? firstError.value.error : 'Не удалось исполнить ордер ни на одном аккаунте';
      return { success: false, error: errorMsg };
    }
  } catch (err: any) {
    const errorMsg = deps?.enrichExchangeError ? deps.enrichExchangeError(err) : (err.message || String(err));
    return { success: false, error: errorMsg };
  }
}

export async function setRealTradeSlTpOnExchange(
  symbol: string,
  side: string,
  stopLoss: number | null | undefined,
  takeProfit: number | null | undefined,
  deps: RealTradeEngineDependencies
): Promise<boolean> {
  try {
    const config = deps.getGlobalSettings()?.exchangeApiConfig;
    if (!config || !config.isEnabled) return true;

    const upperSym = symbol.toUpperCase().trim();
    const base = upperSym.split(/[\/:-]/)[0];
    if (config.exchange === 'weex' && ((deps.isWeexApiSupported && !deps.isWeexApiSupported(symbol)) || deps.autopilotFailedSymbols?.has(base))) {
      return true;
    }

    const client = getCcxtClient(config, deps.isRealTradingAllowed());
    if (!client) return false;

    const formattedSymbol = deps.formatFuturesSymbol(symbol, config.exchange);

    try {
      await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true);
    } catch (_) {}

    const positions = await executeWithRetry(
      () => client.fetchPositions([formattedSymbol]),
      `fetchPositions for ${formattedSymbol}`,
      deps
    ).catch(() => []);
    const pos = positions.find((p: any) => p.contracts > 0 && p.symbol === formattedSymbol);
    if (!pos) {
      return false;
    }

    const qty = pos.contracts;
    if (!isFinite(qty) || isNaN(qty) || qty <= 0) {
      return false;
    }
    const orderSide = side === 'buy' || side === 'long' || side === 'LONG' || side === 'BUY' ? 'sell' : 'buy';
    let slSuccess = true;
    let tpSuccess = true;

    if (stopLoss && isFinite(stopLoss) && stopLoss > 0) {
      const spParams: any = { reduceOnly: true, stopLossPrice: stopLoss };
      if (config.exchange === 'mexc') {
        spParams.stopPrice = stopLoss;
        spParams.triggerPrice = stopLoss;
      }
      try {
        await executeWithRetry(
          () => client.createOrder(formattedSymbol, 'market', orderSide, qty, undefined, spParams),
          `create SL Order at ${stopLoss} for ${formattedSymbol}`,
          deps
        );
      } catch (_) {
        slSuccess = false;
      }
    }

    if (takeProfit && isFinite(takeProfit) && takeProfit > 0) {
      const tpParams: any = { reduceOnly: true, takeProfitPrice: takeProfit };
      if (config.exchange === 'mexc') {
        tpParams.stopPrice = takeProfit;
        tpParams.triggerPrice = takeProfit;
      }
      try {
        await executeWithRetry(
          () => client.createOrder(formattedSymbol, 'market', orderSide, qty, undefined, tpParams),
          `create TP Order at ${takeProfit} for ${formattedSymbol}`,
          deps
        );
      } catch (_) {
        tpSuccess = false;
      }
    }
    return slSuccess && tpSuccess;
  } catch (_) {
    return false;
  }
}

export async function executeRealPartialCloseOnExchange(
  symbol: string,
  side: string,
  ratio: number,
  deps: RealTradeEngineDependencies
): Promise<RealTradeExecutionResult> {
  try {
    const config = deps.getGlobalSettings()?.exchangeApiConfig;
    if (!config || !config.isEnabled) {
      return { success: false, error: 'API биржи не активировано' };
    }

    const upperSym = symbol.toUpperCase().trim();
    const base = upperSym.split(/[\/:-]/)[0];
    if (config.exchange === 'weex' && ((deps.isWeexApiSupported && !deps.isWeexApiSupported(symbol)) || deps.autopilotFailedSymbols?.has(base))) {
      return { success: false, error: `Пара ${symbol} не поддерживается для API-торговли на бирже WEEX.` };
    }

    const client = getCcxtClient(config, deps.isRealTradingAllowed());
    if (!client) {
      return { success: false, error: 'Не удалось инициализировать CCXT клиент' };
    }

    const formattedSymbol = deps.formatFuturesSymbol(symbol, config.exchange);
    const market = await executeWithRetry(
      async () => {
        if (!client.markets || Object.keys(client.markets).length === 0) {
          await client.loadMarkets();
        }
        return client.market(formattedSymbol);
      },
      `loadMarkets for partial close ${formattedSymbol}`,
      deps
    );
    const closeSide = side === 'buy' || side === 'long' || side === 'LONG' ? 'sell' : 'buy';

    const positions = await executeWithRetry(
      () => client.fetchPositions([formattedSymbol]),
      `fetchPositions for partial close ${formattedSymbol}`,
      deps
    );
    const pos = positions.find((p: any) => p.contracts > 0 && p.symbol === formattedSymbol);
    if (!pos) {
      return { success: false, error: 'Позиция не найдена на бирже' };
    }

    let contractsToClose = pos.contracts * ratio;
    if (market.limits?.amount?.min !== undefined) {
      if (contractsToClose < market.limits.amount.min) {
        contractsToClose = market.limits.amount.min;
      }
    }
    if (contractsToClose > pos.contracts) {
      contractsToClose = pos.contracts;
    }

    try {
      const precisionStr = client.amountToPrecision(formattedSymbol, contractsToClose);
      contractsToClose = parseFloat(precisionStr);
    } catch (_) {
      contractsToClose = Number(contractsToClose.toFixed(4));
    }

    if (contractsToClose <= 0) {
      return { success: false, error: 'Слишком мелкий контракт для закрытия' };
    }

    try {
      await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true);
    } catch (_) {}

    const params: any = { reduceOnly: true };
    let order: any = null;
    try {
      order = await executeWithRetry(
        () => client.createOrder(formattedSymbol, 'market', closeSide, contractsToClose, undefined, params),
        `partial close order (${closeSide}) for ${formattedSymbol}`,
        deps
      );
    } catch (orderErr: any) {
      const errMsg = orderErr.message || String(orderErr);
      if (errMsg.includes('-1054') || errMsg.includes('FAILED_PRECONDITION')) {
        const match = errMsg.match(/(?:order|id)\s+(\d+)/i);
        if (match && match[1]) {
          const suspectOrderId = match[1];
          await client.cancelOrder(suspectOrderId, formattedSymbol).catch(() => {});
        }
        await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true).catch(() => {});
        order = await executeWithRetry(
          () => client.createOrder(formattedSymbol, 'market', closeSide, contractsToClose, undefined, params),
          `partial close order retry (${closeSide}) for ${formattedSymbol}`,
          deps
        );
      } else {
        throw orderErr;
      }
    }
    return { success: true, data: order, closedContracts: contractsToClose };
  } catch (err: any) {
    return { success: false, error: deps.enrichExchangeError(err) };
  }
}

export async function executeRealCloseOnExchange(
  symbol: string,
  side: string,
  deps: RealTradeEngineDependencies
): Promise<RealTradeExecutionResult> {
  try {
    const config = deps.getGlobalSettings()?.exchangeApiConfig;
    if (!config || !config.isEnabled) {
      return { success: false, error: 'API биржи не активировано' };
    }

    const upperSym = symbol.toUpperCase().trim();
    const base = upperSym.split(/[\/:-]/)[0];
    if (config.exchange === 'weex' && ((deps.isWeexApiSupported && !deps.isWeexApiSupported(symbol)) || deps.autopilotFailedSymbols?.has(base))) {
      return { success: false, error: `Пара ${symbol} не поддерживается для API-торговли на бирже WEEX.` };
    }

    const client = getCcxtClient(config, deps.isRealTradingAllowed());
    if (!client) {
      return { success: false, error: 'Не удалось инициализировать CCXT клиент' };
    }

    const formattedSymbol = deps.formatFuturesSymbol(symbol, config.exchange);
    if (!client.markets || Object.keys(client.markets).length === 0) {
      await executeWithRetry(
        () => client.loadMarkets(),
        `loadMarkets for close ${formattedSymbol}`,
        deps
      );
    }
    const closeSide = side === 'buy' || side === 'long' || side === 'LONG' ? 'sell' : 'buy';

    const positions = await executeWithRetry(
      () => client.fetchPositions([formattedSymbol]),
      `fetchPositions for close ${formattedSymbol}`,
      deps
    ).catch(() => []);
    const pos = positions.find((p: any) => p.contracts > 0 && p.symbol === formattedSymbol);

    let order: any = null;
    if (pos) {
      let contractsToClose = pos.contracts;
      try {
        const precisionStr = client.amountToPrecision(formattedSymbol, contractsToClose);
        contractsToClose = parseFloat(precisionStr);
      } catch (_) {}

      try {
        await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true);
      } catch (_) {}

      const params: any = { reduceOnly: true };
      try {
        order = await executeWithRetry(
          () => client.createOrder(formattedSymbol, 'market', closeSide, contractsToClose, undefined, params),
          `close position order (${closeSide}) for ${formattedSymbol}`,
          deps
        );
      } catch (orderErr: any) {
        const errMsg = orderErr.message || String(orderErr);
        if (errMsg.includes('-1054') || errMsg.includes('FAILED_PRECONDITION')) {
          const match = errMsg.match(/(?:order|id)\s+(\d+)/i);
          if (match && match[1]) {
            const suspectOrderId = match[1];
            await client.cancelOrder(suspectOrderId, formattedSymbol).catch(() => {});
          }
          await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true).catch(() => {});
          order = await executeWithRetry(
            () => client.createOrder(formattedSymbol, 'market', closeSide, contractsToClose, undefined, params),
            `close position order retry (${closeSide}) for ${formattedSymbol}`,
            deps
          );
        } else {
          throw orderErr;
        }
      }
    }

    try {
      await cancelAllOrdersAndTriggers(client, formattedSymbol, deps, true);
    } catch (_) {}

    if (!pos && !order) {
      return { success: true, warning: 'Позиция не найдена на бирже, но все связанные лимитные ордера и триггеры успешно отменены.' };
    }

    return { success: true, data: order };
  } catch (err: any) {
    return { success: false, error: deps.enrichExchangeError(err) };
  }
}

export interface LimitOrderWithTimeoutParams {
  client: any;                    // уже инициализированный ccxt-клиент
  formattedSymbol: string;
  orderSide: 'buy' | 'sell';
  contracts: number;               // уже посчитанный размер позиции
  targetPrice: number;             // цена лимитного ордера (из calculateOteEntryZone.targetPrice)
  timeoutMs?: number;              // по умолчанию DEFAULT_OTE_TIMEOUT_MS
  pollIntervalMs?: number;         // по умолчанию 5000 (5 секунд между проверками статуса)
  deps?: RealTradeEngineDependencies;
}

export type LimitOrderOutcome =
  | { status: 'filled'; order: any; entryPrice: number }
  | { status: 'timed_out' }
  | { status: 'error'; error: string };

export async function executeLimitOrderWithTimeout(
  params: LimitOrderWithTimeoutParams
): Promise<LimitOrderOutcome> {
  try {
    const { client, formattedSymbol, orderSide, contracts, targetPrice } = params;
    const timeoutMs = params.timeoutMs ?? DEFAULT_OTE_TIMEOUT_MS;
    const pollIntervalMs = params.pollIntervalMs ?? 5000;

    const defaultDeps: RealTradeEngineDependencies = {
      isRealTradingAllowed: () => true,
      getGlobalSettings: () => ({}),
      formatFuturesSymbol: (s: string) => s,
      enrichExchangeError: (err: any) => err?.message || String(err)
    };
    const effectiveDeps = params.deps || defaultDeps;

    let order: any;
    try {
      order = await executeWithRetry(
        () => client.createOrder(formattedSymbol, 'limit', orderSide, contracts, targetPrice, {}),
        `createLimitOrder (${orderSide}) for ${formattedSymbol}`,
        effectiveDeps
      );
    } catch (createErr: any) {
      const errMsg = effectiveDeps.enrichExchangeError
        ? effectiveDeps.enrichExchangeError(createErr)
        : (createErr?.message || String(createErr));
      return { status: 'error', error: errMsg };
    }

    const orderId = order?.id;
    if (!orderId) {
      return {
        status: 'error',
        error: 'Order was created but no order id returned by exchange'
      };
    }

    if (order.status === 'closed') {
      return {
        status: 'filled',
        order,
        entryPrice: order.average || order.price || targetPrice
      };
    }

    const startedAtMs = Date.now();

    while (true) {
      if (hasOteEntryTimedOut(startedAtMs, Date.now(), timeoutMs)) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      if (hasOteEntryTimedOut(startedAtMs, Date.now(), timeoutMs)) {
        break;
      }

      const fetchedOrder = await executeWithRetry(
        () => client.fetchOrder(orderId, formattedSymbol),
        `fetchOrder ${orderId} for ${formattedSymbol}`,
        effectiveDeps
      );

      if (fetchedOrder?.status === 'closed') {
        return {
          status: 'filled',
          order: fetchedOrder,
          entryPrice: fetchedOrder.average || fetchedOrder.price || targetPrice
        };
      }

      if (fetchedOrder?.status === 'canceled' || fetchedOrder?.status === 'rejected') {
        return {
          status: 'error',
          error: `Order ${orderId} was ${fetchedOrder.status} externally`
        };
      }
    }

    try {
      await executeWithRetry(
        () => client.cancelOrder(orderId, formattedSymbol),
        `cancelOrder ${orderId} for ${formattedSymbol} on OTE timeout`,
        effectiveDeps,
        1
      );
    } catch (_) {
      // Игнорируем ошибку отмены (ордер мог исполниться в последний момент)
    }

    return { status: 'timed_out' };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    return { status: 'error', error: errMsg };
  }
}

