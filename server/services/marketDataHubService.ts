import ccxt, { Exchange } from 'ccxt';
import { syncGlobalTickers, type TickerSyncContext, getExchangeLink as serviceGetExchangeLink, buildExchangeSymbolsMap, getTradingAdvice as serviceGetTradingAdvice } from './tickerSyncService.ts';
import { ExchangeWsManager } from './exchangeWsManager.ts';
import { cleanSymbol as quantCleanSymbol, normalizeSymbol as quantNormalizeSymbol } from '../quant.ts';

export interface MarketDataHubDependencies {
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getWsTickers: () => any;
  getApiHealth: () => Record<string, { latency: number; status: 'online' | 'degraded' | 'offline'; lastCheck: number }>;
  getGlobalLiquidations: () => Record<string, { shortsSq: number; longsSq: number; lastT: number }>;
  getGlobalWhales: () => Record<string, { amount: number; time: number }>;
  getGlobalPumps: () => Set<string>;
  getGlobalCvd: () => Record<string, { buyVol: number; sellVol: number; cvd: number }>;
  getCacheSignals: () => any;
  getVirtualTrades: () => any[];
  updateSignalsCache: () => void;
  updateTrueOHLCV: () => void;
  updateLocalCandlesForSymbol: (cleanSym: string, finalPrice: number, volumeDelta: number) => void;
  emitPriceUpdate: () => void;
  logStructured: (type: 'info' | 'success' | 'warning' | 'error', mod: string, msg: string, symbol?: string, meta?: any) => void;
  safeRedisSet?: (key: string, val: string, mode?: string, duration?: number) => void;
  captureException?: (err: any, extra?: any) => void;
}

export function ensureExchangeMarket(ex: any, rawSymbol: string): any {
  if (!ex) return null;
  if (!ex.markets) ex.markets = {};
  if (!ex.markets_by_id) ex.markets_by_id = {};
  if (!ex.symbols) ex.symbols = [];

  const sym = (rawSymbol || '').trim();
  if (!sym) return null;
  if (ex.markets[sym]) return ex.markets[sym];

  const cleanSym = sym.split(':')[0];
  const parts = cleanSym.split('/');
  const base = parts[0] || cleanSym;
  const quote = parts[1] || 'USDT';
  const id = cleanSym.replace(/[\/_]/g, '');
  const unifiedSymbol = sym.includes(':') ? sym : `${cleanSym}:${quote}`;

  if (ex.markets[unifiedSymbol]) return ex.markets[unifiedSymbol];
  if (ex.markets[id]) return ex.markets[id];

  const market = {
    id,
    symbol: unifiedSymbol,
    base,
    quote,
    settle: quote,
    swap: true,
    future: false,
    spot: false,
    contract: true,
    linear: true,
    inverse: false,
    active: true,
    precision: { amount: 8, price: 8 },
    limits: { amount: { min: 0.0001, max: 1000000 }, price: { min: 0.00000001, max: 10000000 } }
  };

  ex.markets[unifiedSymbol] = market;
  ex.markets[cleanSym] = market;
  ex.markets[id] = market;
  if (!ex.markets_by_id[id]) ex.markets_by_id[id] = [];
  ex.markets_by_id[id].push(market);
  if (!ex.symbols.includes(unifiedSymbol)) ex.symbols.push(unifiedSymbol);
  return market;
}

export class MarketDataHubService {
  public static readonly WEEX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  public static readonly DEFAULT_PAIRS = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT', 'BNB/USDT', 'ADA/USDT', 'LINK/USDT', 'AVAX/USDT', 'NEAR/USDT',
    'RUNE/USDT', 'SUI/USDT', 'APT/USDT', 'AR/USDT', 'STX/USDT', 'INJ/USDT', 'FTM/USDT', 'RENDER/USDT', 'TAO/USDT', 'TIA/USDT',
    'FET/USDT', 'WIF/USDT', 'PEPE/USDT', 'FLOKI/USDT', 'BONK/USDT', 'JUP/USDT', 'PYTH/USDT', 'ORDI/USDT', 'SATS/USDT', 'MEME/USDT',
    'PEOPLE/USDT', 'NOT/USDT', 'ZRO/USDT', 'STRK/USDT', 'EIGEN/USDT', 'IO/USDT', 'ATH/USDT', 'ZRO/USDT', 'W/USDT', 'UXLINK/USDT',
    'BANANA/USDT', 'LUMIA/USDT', 'NEIRO/USDT', 'TURBO/USDT', 'POPCAT/USDT', 'BRETT/USDT', 'MOG/USDT', 'MYRO/USDT', 'BOME/USDT', 'XAN/USDT', 'XANA/USDT',
    'BTC/USDC', 'ETH/USDC', 'SOL/USDC'
  ];

  private deps: MarketDataHubDependencies;
  private ccxtExchanges: Record<string, Exchange>;
  private restBlockedExchanges: Set<string> = new Set<string>();
  private isBinanceGeoblocked: boolean = false;
  private pairs: string[];
  private exchangeSymbols: Record<string, Record<string, string>>;
  private isFetchingGlobalTickers: boolean = false;
  private lastPriceEmit: number = 0;
  private exchangeWsManager: ExchangeWsManager;

  constructor(deps: MarketDataHubDependencies, pairs: string[] = MarketDataHubService.DEFAULT_PAIRS) {
    this.deps = deps;
    this.pairs = pairs;
    this.exchangeSymbols = buildExchangeSymbolsMap(this.pairs);

    this.ccxtExchanges = {
      mexc: new ccxt.mexc({ enableRateLimit: true }),
      binance: new ccxt.binance({ enableRateLimit: true }),
      bybit: new ccxt.bybit({ enableRateLimit: true }),
      okx: new ccxt.okx({ enableRateLimit: true }),
      gateio: new ccxt.gate({ enableRateLimit: true }),
      kucoin: new ccxt.kucoin({ enableRateLimit: true, timeout: 8000 }),
      bitget: new ccxt.bitget({ enableRateLimit: true, timeout: 8000 }),
      htx: new ccxt.htx({ enableRateLimit: true, timeout: 5000 }),
      // ЛЕГАСИ-ТАЙМАУТ: timeout: 15000 был слишком узким для 4400+ рынков (spot + contract) Weex; увеличен до 35000 для надежной инициализации
      weex: new ccxt.weex({ enableRateLimit: true, rateLimit: 100, timeout: 35000, headers: MarketDataHubService.WEEX_HEADERS })
    };

    // Pre-seed swap contract markets for all exchanges immediately so all endpoints can be reached in 0-latency without loading 50,000+ markets
    Object.values(this.ccxtExchanges).forEach((ex) => {
      this.seedExchangeMarkets(ex, this.pairs);
    });

    // Deduplicate and protect weex.loadMarkets so concurrent callers never flood api-contract.weex.com
    let weexLoadMarketsPromise: Promise<any> | null = null;
    const weexEx = this.ccxtExchanges.weex as any;
    const originalWeexLoadMarkets = weexEx.loadMarkets.bind(weexEx);
    weexEx.loadMarkets = async (reload = false, params = {}) => {
      if (!reload && weexEx.markets && Object.keys(weexEx.markets).length > 20) {
        return weexEx.markets;
      }
      if (weexLoadMarketsPromise) {
        return weexLoadMarketsPromise;
      }
      weexLoadMarketsPromise = (async () => {
        try {
          return await originalWeexLoadMarkets(reload, params);
        } catch (err: any) {
          console.warn(`[WEEX] Background loadMarkets resilient fallback (${err?.message?.slice(0, 80) || err}). Using pre-seeded market catalogue.`);
          return weexEx.markets;
        } finally {
          weexLoadMarketsPromise = null;
        }
      })();
      return weexLoadMarketsPromise;
    };

    this.exchangeWsManager = new ExchangeWsManager({
      getPairs: () => this.pairs,
      getExchangeSymbols: () => this.exchangeSymbols,
      getWsTickers: () => this.deps.getWsTickers(),
      getGlobalCcxtTickers: () => this.deps.getGlobalCcxtTickers(),
      getGlobalLiquidations: () => this.deps.getGlobalLiquidations(),
      getGlobalWhales: () => this.deps.getGlobalWhales(),
      getGlobalPumps: () => this.deps.getGlobalPumps(),
      getGlobalCvd: () => this.deps.getGlobalCvd(),
      getCacheSignals: () => this.deps.getCacheSignals(),
      getVirtualTrades: () => this.deps.getVirtualTrades(),
      getIsBinanceGeoblocked: () => this.isBinanceGeoblocked,
      setIsBinanceGeoblocked: (val: boolean) => { this.isBinanceGeoblocked = val; },
      throttlePriceEmit: () => this.throttlePriceEmit(),
      getExchangeLink: (ex: string, pair: string) => this.getExchangeLink(ex, pair),
      updateLocalCandlesForSymbol: (cleanSym: string, price: number, vol: number) => this.deps.updateLocalCandlesForSymbol(cleanSym, price, vol),
      updateSignalsCache: () => this.deps.updateSignalsCache(),
      logStructured: (type: any, mod: string, msg: string) => this.deps.logStructured(type, mod, msg)
    });
  }

  public seedExchangeMarkets(ex: any, pairs: string[]): void {
    if (!ex) return;
    const extraTokens = ['1000PEPE/USDT', 'PEPE/USDT', 'DOGE/USDT', 'SHIB/USDT', '1000BONK/USDT', '1000FLOKI/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    const allPairs = Array.from(new Set([...pairs, ...extraTokens]));
    for (const p of allPairs) {
      ensureExchangeMarket(ex, p);
      ensureExchangeMarket(ex, p.includes(':') ? p : `${p}:USDT`);
    }
  }

  public getCcxtExchanges(): Record<string, Exchange> {
    return this.ccxtExchanges;
  }

  public getRestBlockedExchanges(): Set<string> {
    return this.restBlockedExchanges;
  }

  public getIsBinanceGeoblocked(): boolean {
    return this.isBinanceGeoblocked;
  }

  public setIsBinanceGeoblocked(val: boolean): void {
    this.isBinanceGeoblocked = val;
  }

  public getPairs(): string[] {
    return this.pairs;
  }

  public getExchangeSymbols(): Record<string, Record<string, string>> {
    return this.exchangeSymbols;
  }

  public getExchangeInstance(name: string): Exchange | null {
    const normName = (name || '').toLowerCase();
    return this.ccxtExchanges[normName] || null;
  }

  public getExchangeLink(exchange: string, symbol: string): string {
    return serviceGetExchangeLink(exchange, symbol);
  }

  public cleanSymbol(sym: string): string {
    return quantCleanSymbol(sym);
  }

  public normalizeSymbol(sym: string): string {
    return quantNormalizeSymbol(sym);
  }

  public getTradingAdvice(signal: string, type: string): string {
    return serviceGetTradingAdvice(signal, type);
  }

  public findTickerInMap(sym: string, tickers: Record<string, any>): any {
    if (!tickers || !sym) return null;
    const sClean = sym.replace(/[\/:]/g, '').toUpperCase();
    if (tickers[sym]) return tickers[sym];
    if (tickers[sClean]) return tickers[sClean];

    const variations = [
      sym.replace('/', '_'),
      sym.replace('_', '/'),
      sClean,
      sClean.replace('USDT', '/USDT'),
      sClean.replace('USDT', '_USDT'),
      sClean.replace('USDT', '/USDT:USDT'),
      sClean.replace('USDT', '_USDT:USDT'),
      sym + ':USDT',
      sym.split(':')[0]
    ];

    for (const v of variations) {
      if (tickers[v]) return tickers[v];
    }

    const base = sClean.replace('USDT', '');
    for (const k in tickers) {
      const kClean = k.replace(/[\/:]/g, '').toUpperCase();
      if (kClean === sClean) return tickers[k];
      if (kClean.startsWith(base) && kClean.endsWith('USDT')) return tickers[k];
    }

    return null;
  }

  public throttlePriceEmit(): void {
    const now = Date.now();
    if (now - this.lastPriceEmit > 500) {
      this.lastPriceEmit = now;
      this.deps.emitPriceUpdate();
    }
  }

  public async initMarkets(): Promise<void> {
    if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
      console.log('[OFFLINE/TEST MODE] Market loading bypassed. 0 external exchange adapter network calls.');
      return;
    }

    const loadExchangeWithRetry = async (ex: Exchange, maxRetries = 2) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (['binance', 'bybit', 'okx', 'gateio', 'gate', 'mexc', 'weex'].includes(ex.id)) {
            ex.options['defaultType'] = 'swap';
          }
          await ex.loadMarkets();
          console.log(`[INIT] Loaded markets for ${ex.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          return;
        } catch (e: any) {
          const errMsg = e.message || e.toString();
          const isWeex = ex.id.toLowerCase() === 'weex';
          if (isWeex && attempt < maxRetries) {
            console.log(`[INIT] Weex loadMarkets attempt ${attempt} delayed (${errMsg}). Retrying with 35s timeout in 2s...`);
            await new Promise(res => setTimeout(res, 2000));
            continue;
          }

          const isGeoBlocked = errMsg.includes('403') || errMsg.includes('451') || errMsg.includes('Forbidden') || errMsg.includes('restricted location') || errMsg.includes('Eligibility');
          const isTimeoutOrNetwork = errMsg.includes('timed out') || errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED') || errMsg.includes('NetworkError');

          if (isGeoBlocked || isTimeoutOrNetwork) {
            if (!isWeex) {
              this.restBlockedExchanges.add(ex.id.toLowerCase());
              if (ex.id.toLowerCase() === 'binance') {
                this.isBinanceGeoblocked = true;
              }
              if (isGeoBlocked) {
                console.warn(`[INIT] ${ex.id} is blocked by CloudFront/geo-firewall (${errMsg.includes('451') || errMsg.includes('restricted') ? '451 Restricted Location' : '403 Forbidden'}). Added to REST blocklist.`);
              } else {
                console.warn(`[INIT] ${ex.id} API unreachable / timed out during initialization. Added to REST blocklist.`);
              }
            } else {
              // ЛЕГАСИ-ОБРАБОТКА WEEX: Не блокируем WEEX, активируем устойчивый fallback-каталог рынков для бесперебойного квант-скальпинга
              if (!ex.markets || Object.keys(ex.markets).length === 0) {
                ex.markets = {};
                ex.symbols = [];
                for (const p of this.pairs) {
                  const s = p.includes(':') ? p : `${p}:USDT`;
                  ex.markets[s] = { id: p.replace(/[\/:]/g, ''), symbol: s, base: p.split('/')[0], quote: 'USDT', swap: true, contract: true } as any;
                  ex.symbols.push(s);
                }
              }
              console.log(`[INIT] Weex markets initialized in resilient mode (${errMsg}). Direct REST and WS ticker pipelines active.`);
            }
          } else {
            console.warn(`[INIT] Failed to load markets for ${ex.id}: ${errMsg}`);
          }
          break;
        }
      }
    };

    // Pre-seed all exchanges with default monitored pairs to guarantee 0-latency and lightweight memory footprint
    Object.values(this.ccxtExchanges).forEach((ex) => {
      this.seedExchangeMarkets(ex, this.pairs);
    });

    // Load full markets strictly for primary execution exchange (WEEX) and benchmark (Binance) sequentially.
    // Auxiliary exchanges remain active via the lightweight pre-seeded catalog, saving ~1.5GB RAM and preventing container OOM kills.
    const coreExchanges = [this.ccxtExchanges.weex, this.ccxtExchanges.binance].filter(Boolean);
    for (const ex of coreExchanges) {
      await loadExchangeWithRetry(ex).catch(() => {});
    }
  }

  public getTickerSyncContext(): TickerSyncContext {
    return {
      getCcxtExchanges: () => this.ccxtExchanges,
      getRestBlockedExchanges: () => this.restBlockedExchanges,
      isBinanceGeoblocked: () => this.isBinanceGeoblocked,
      setBinanceGeoblocked: (val: boolean) => { this.isBinanceGeoblocked = val; },
      getGlobalCcxtTickers: () => this.deps.getGlobalCcxtTickers(),
      getWsTickers: () => this.deps.getWsTickers(),
      getApiHealth: () => this.deps.getApiHealth(),
      safeRedisSet: this.deps.safeRedisSet,
      updateSignalsCache: () => this.deps.updateSignalsCache(),
      updateTrueOHLCV: () => this.deps.updateTrueOHLCV(),
      emitPriceUpdate: () => this.deps.emitPriceUpdate(),
      captureException: this.deps.captureException,
      isFetching: () => this.isFetchingGlobalTickers,
      setIsFetching: (val: boolean) => { this.isFetchingGlobalTickers = val; },
      isInitialOhlcvFetched: () => Boolean((globalThis as any)._initialOhlcvFetched),
      setInitialOhlcvFetched: (val: boolean) => { (globalThis as any)._initialOhlcvFetched = val; }
    };
  }

  public async updateGlobalTickers(forceFullScan = false) {
    return syncGlobalTickers(this.getTickerSyncContext(), forceFullScan);
  }

  public startMexcWS(retryCount = 0) {
    this.exchangeWsManager.startMexcWS(retryCount);
  }

  public startBinanceWS(retryCount = 0) {
    this.exchangeWsManager.startBinanceWS(retryCount);
  }

  public startBybitWS(retryCount = 0) {
    this.exchangeWsManager.startBybitWS(retryCount);
  }

  public getExchangeWsManager(): ExchangeWsManager {
    return this.exchangeWsManager;
  }
}
