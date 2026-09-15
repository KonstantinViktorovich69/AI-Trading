import { fetchMexcTickersDirect, fetchWeexTickersDirect } from './directExchangeFetchers.ts';

export interface TickerSyncContext {
  getCcxtExchanges: () => Record<string, any>;
  getRestBlockedExchanges: () => Set<string>;
  isBinanceGeoblocked: () => boolean;
  setBinanceGeoblocked: (val: boolean) => void;
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getWsTickers: () => { Weex: Record<string, any>; Binance: Record<string, any>; Bybit: Record<string, any>; Mexc: Record<string, any> };
  getApiHealth: () => Record<string, { latency: number; status: 'online' | 'degraded' | 'offline'; lastCheck: number }>;
  safeRedisSet?: (key: string, val: string, mode?: string, duration?: number) => void;
  updateSignalsCache: () => void;
  updateTrueOHLCV: () => void;
  emitPriceUpdate: () => void;
  captureException?: (err: any, context?: any) => void;
  isFetching: () => boolean;
  setIsFetching: (val: boolean) => void;
  isInitialOhlcvFetched: () => boolean;
  setInitialOhlcvFetched: (val: boolean) => void;
}

/**
 * Формирование прямой веб-ссылки на торговую пару биржи
 */
export function getExchangeLink(exchange: string, symbol: string): string {
  const normEx = (exchange || '').toLowerCase();
  const base = (symbol || '').split(/[\/:-]/)[0].toUpperCase();
  const quote = (symbol || '').split(/[\/:-]/)[1]?.toUpperCase() || 'USDT';
  const clean = `${base}${quote}`;
  
  if (normEx.includes('binance')) return `https://www.binance.com/en/futures/${clean}`;
  if (normEx.includes('bybit')) return `https://www.bybit.com/en-US/trade/futures/${quote.toLowerCase()}/${clean}`;
  if (normEx.includes('okx')) return `https://www.okx.com/trade-swap/${base}-${quote}-SWAP`;
  if (normEx.includes('mexc')) {
    return `https://futures.mexc.com/exchange/${base}_${quote}`;
  }
  if (normEx.includes('weex')) {
    let weexBase = base;
    if (['PEPE', 'BONK', 'SHIB', 'FLOKI'].includes(base)) {
      weexBase = `1000${base}`;
    }
    return `https://www.weex.com/trade/${weexBase}_USDT`;
  }
  if (normEx.includes('bitget')) return `https://www.bitget.com/mix/${quote.toLowerCase()}/${clean}_UMCBL`;
  return `https://www.tradingview.com/symbols/${clean}/`;
}

/**
 * Генерация карты символов для бирж
 */
export function buildExchangeSymbolsMap(pairs: string[]): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {
    binance: {}, kraken: {}, kucoin: {}, bybit: {}, okx: {}, gateio: {}, mexc: {}, htx: {}, bitget: {}, weex: {}
  };

  for (const pair of pairs) {
    map.binance[pair] = pair.replace('/', '');
    let krakenSymbol = pair.replace('/', '');
    if (pair.startsWith('BTC/')) krakenSymbol = krakenSymbol.replace('BTC', 'XBT');
    if (pair.startsWith('DOGE/')) krakenSymbol = krakenSymbol.replace('DOGE', 'XDG');
    map.kraken[pair] = krakenSymbol;
    map.kucoin[pair] = pair.replace('/', '-');
    map.bybit[pair] = pair.replace('/', '');
    map.okx[pair] = pair.replace('/', '-');
    map.gateio[pair] = pair.replace('/', '_');
    map.mexc[pair] = pair.replace('/', '');
    map.htx[pair] = pair.replace('/', '').toLowerCase();
    map.bitget[pair] = pair.replace('/', '');
    map.weex[pair] = pair.replace('/', '_');
  }

  return map;
}

/**
 * Получение торгового совета по сигналу
 */
export function getTradingAdvice(signal: string, type: string): string {
  const isShort = signal.includes('SELL');
  
  if (isShort) {
    if (type.includes('Парабола') || type.includes('Squeeze ВНИЗ')) {
      return "📉 <b>Совет по SHORT (заработок на падении):</b>\nЦена сильно перегрета. Ожидается обвал к VWAP. Входите частями, стоп за локальный хай. Цель: 1-2% профита.";
    }
    if (type.includes('Stop Hunt')) {
      return "📉 <b>Совет по SHORT:</b>\nЭто ложный пробой. Крупный игрок собрал ликвидность и готов толкать цену вниз. Идеально для быстрого шорта.";
    }
    return "📉 <b>Совет по SHORT:</b>\nТренд сменился на медвежий. Ищите точку входа после небольшого отскока вверх. Не забывайте про стоп-лосс!";
  } else {
    if (type.includes('Пролив') || type.includes('Oversold')) {
      return "📈 <b>Совет по LONG (покупка):</b>\nПаническая распродажа завершена. Хорошая точка для подбора на отскок. Первый тейк на 0.5% - 1%.";
    }
    return "📈 <b>Совет по LONG:</b>\nСильный импульс. Если BTC стабилен, монета может пойти выше. Входите при подтверждении объемов.";
  }
}

/**
 * Основной процесс синхронизации котировок с бирж (REST API)
 */
export async function syncGlobalTickers(ctx: TickerSyncContext, forceFullScan = false): Promise<void> {
  if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
    return;
  }
  if (ctx.isFetching()) return;
  ctx.setIsFetching(true);

  try {
    const ccxtExchanges = ctx.getCcxtExchanges();
    const restBlockedExchanges = ctx.getRestBlockedExchanges();
    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    const wsTickers = ctx.getWsTickers();
    const apiHealth = ctx.getApiHealth();

    // Работаем исключительно с биржей WEEX для сканирования и генерации торговых сигналов
    const exchanges = ['weex'].filter(ex => !restBlockedExchanges.has(ex.toLowerCase())); 

    console.log(`[SCANNER] Starting syncGlobalTickers. Mode: WEEX EXCLUSIVE. Running for: ${exchanges.join(', ')}`);

    for (let i = 0; i < exchanges.length; i += 2) {
      const chunk = exchanges.slice(i, i + 2);
      await Promise.all(chunk.map(async (exName) => {
        try {
          const ex = ccxtExchanges[exName];
          if (!ex) return;
          const startTime = Date.now();
          
          if (['binance', 'bybit', 'okx', 'gateio', 'mexc', 'weex'].includes(exName)) {
            ex.options = ex.options || {};
            ex.options['defaultType'] = 'swap';
          }
          
          let _tickers: any = {};
          try {
            const fetchTimeout = exName === 'mexc' ? 30000 : (exName === 'weex' ? 35000 : 20000);
            let success = false;
            let attempt = 0;
            const maxAttempts = exName === 'weex' ? 2 : 1;
            
            while (!success && attempt < maxAttempts) {
              try {
                const fetchPromise = exName === 'mexc' 
                  ? fetchMexcTickersDirect() 
                  : (exName === 'weex' ? fetchWeexTickersDirect() : ex.fetchTickers());
                _tickers = await Promise.race([
                  fetchPromise,
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), fetchTimeout))
                ]);
                success = true;
              } catch (innerErr: any) {
                attempt++;
                if (attempt >= maxAttempts) {
                  throw innerErr;
                }
                console.warn(`[SCANNER] Soft retry ${attempt}/${maxAttempts} for ${exName} tickers fetch due to: ${innerErr.message || innerErr}`);
                await new Promise(resolve => setTimeout(resolve, 1500));
              }
            }
          } catch (err: any) {
            const errMsg = err.message || err.toString();
            const isGeoBlocked = errMsg.includes('403') || errMsg.includes('451') || errMsg.includes('Forbidden') || errMsg.includes('DDoS') || errMsg.includes('restricted location') || errMsg.includes('Eligibility');
            const isTimeoutOrNetwork = errMsg.includes('timed out') || errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNREFUSED') || errMsg.includes('NetworkError');

            if (isGeoBlocked || isTimeoutOrNetwork) {
              if (exName.toLowerCase() !== 'weex') {
                restBlockedExchanges.add(exName.toLowerCase());
                if (exName.toLowerCase() === 'binance') {
                  ctx.setBinanceGeoblocked(true);
                }
                if (isGeoBlocked) {
                  console.warn(`[SCANNER] ${exName} REST API is blocked by CloudFront/geo-firewall (${errMsg.includes('451') || errMsg.includes('restricted') ? '451 Restricted Location' : '403 Forbidden'}). Added to REST blocklist.`);
                } else {
                  console.warn(`[SCANNER] ${exName} REST API timed out or is unreachable. Added to REST blocklist.`);
                }
              } else {
                console.warn(`[SCANNER] WEEX REST API returned error (${errMsg}). NOT adding to blocklist because it has no WebSocket fallback. Retrying on next interval.`);
              }
            } else {
              console.error(`[ERROR] Fetching tickers for ${exName}:`, errMsg);
            }
            apiHealth[exName] = { latency: 0, status: 'offline', lastCheck: Date.now() };
            if (ctx.captureException && !isGeoBlocked && !isTimeoutOrNetwork) {
              ctx.captureException(err, { extra: { exchange: exName } });
            }
          }
          
          let tickers = _tickers || {};
          if (Object.keys(tickers).length === 0) {
            if (GLOBAL_CCXT_TICKERS[exName] && Object.keys(GLOBAL_CCXT_TICKERS[exName]).length > 0) {
              tickers = GLOBAL_CCXT_TICKERS[exName];
            } else if (exName === 'weex' && (globalThis as any).WEEX_CACHED_TICKERS && Object.keys((globalThis as any).WEEX_CACHED_TICKERS).length > 0) {
              tickers = (globalThis as any).WEEX_CACHED_TICKERS;
            }
          }
          if (exName === 'weex') {
            for (const sym of Object.keys(tickers)) {
              if (tickers[sym] && tickers[sym].percentage !== undefined) {
                tickers[sym].percentage = tickers[sym].percentage * 100;
              }
            }
          }
          const count = Object.keys(tickers).length;
          if (count > 0) {
            GLOBAL_CCXT_TICKERS[exName] = tickers;
            if (ctx.safeRedisSet) {
              ctx.safeRedisSet(`tickers:${exName}`, JSON.stringify(tickers), 'EX', 120);
            }
            console.log(`[SCANNER] ${exName}: successfully fetched ${count} tickers in ${Date.now() - startTime}ms`);
            
            if (exName === 'weex' && wsTickers && wsTickers.Weex) {
              for (const [pair, t] of Object.entries<any>(tickers)) {
                const cleanSym = pair.replace(/[\/:]/g, '').toUpperCase();
                const lastVal = t.last || 0;
                const tickerObj = {
                  exchange: 'WEEX',
                  pair,
                  bid: t.bid || lastVal || 0,
                  bidQty: t.bidVolume || 0,
                  ask: t.ask || lastVal || 0,
                  askQty: t.askVolume || 0,
                  url: getExchangeLink('weex', pair),
                  timestamp: t.timestamp || Date.now(),
                  last: lastVal
                };
                wsTickers.Weex[pair] = tickerObj as any;
                wsTickers.Weex[cleanSym] = tickerObj as any;
              }
            }
            if (exName === 'mexc') {
              console.log(`[SCANNER] MEXC first ticker example: ${Object.keys(tickers)[0]} -> ${JSON.stringify(tickers[Object.keys(tickers)[0]])}`);
            }
          }
          
          const latency = Date.now() - startTime;
          apiHealth[exName] = { latency, status: count > 0 ? (latency > 2000 ? 'degraded' : 'online') : 'offline', lastCheck: Date.now() };
        } catch (e) {
          console.error(`[ERROR] Critical error in ${exName} fetch:`, e);
          apiHealth[exName] = { latency: 0, status: 'offline', lastCheck: Date.now() };
        }
      }));
    }

    ctx.updateSignalsCache();
    ctx.emitPriceUpdate();

    if (!ctx.isInitialOhlcvFetched()) {
      ctx.setInitialOhlcvFetched(true);
      ctx.updateTrueOHLCV();
    }
  } finally {
    ctx.setIsFetching(false);
  }
}
