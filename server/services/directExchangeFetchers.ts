import https from 'https';

/**
 * Прямой HTTP-парсер тикеров фьючерсов MEXC (в обход ограничений/задержек CCXT).
 */
export async function fetchMexcTickersDirect(attempt: number = 1): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const timeoutVal = 15000;
    let wasResolved = false;

    const options = {
      hostname: 'contract.mexc.com',
      port: 443,
      path: '/api/v1/contract/ticker',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Connection': 'close'
      }
    };

    const timeout = setTimeout(() => {
      if (wasResolved) return;
      wasResolved = true;
      console.warn(`[MEXC] Ticker fetch timed out (15s) - Attempt ${attempt}`);
      request.destroy();
      if (attempt < 3) {
        setTimeout(() => {
          fetchMexcTickersDirect(attempt + 1).then(resolve);
        }, 1000);
      } else {
        resolve({});
      }
    }, timeoutVal);

    const request = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (wasResolved) return;
        clearTimeout(timeout);
        wasResolved = true;
        try {
          const json = JSON.parse(data);
          if (json && json.success && json.data) {
             const result: Record<string, any> = {};
             const tickersForFallback: Record<string, any> = {};
             json.data.forEach((t: any) => {
                const symbol = t.symbol.replace('_', '/') + ':USDT';
                const tickerData = {
                   symbol, last: t.lastPrice, bid: t.bid1, ask: t.ask1,
                   baseVolume: t.volume24, quoteVolume: t.amount24,
                   high: t.high24Price, low: t.lower24Price,
                   percentage: t.riseFallRate * 100, change: t.riseFallRate * 100,
                   timestamp: Date.now()
                };
                result[symbol] = tickerData;
                tickersForFallback[t.symbol] = tickerData;
                tickersForFallback[t.symbol.replace('_', '')] = tickerData;
             });
             (globalThis as any).MEXC_SPOT_TICKERS = tickersForFallback;
             console.log(`[MEXC] Successfully fetched ${Object.keys(result).length} tickers on attempt ${attempt}.`);
             resolve(result);
          } else {
             console.warn(`[MEXC] API response success=false or missing data - Attempt ${attempt}`);
             if (attempt < 3) {
               setTimeout(() => {
                 fetchMexcTickersDirect(attempt + 1).then(resolve);
               }, 1000);
             } else {
               resolve({});
             }
          }
        } catch(e) { 
          console.warn(`[MEXC] JSON parse error - Attempt ${attempt}`);
          if (attempt < 3) {
            setTimeout(() => {
              fetchMexcTickersDirect(attempt + 1).then(resolve);
            }, 1000);
          } else {
            resolve({}); 
          }
        }
      });
    });

    request.on('error', (err) => {
      if (wasResolved) return;
      clearTimeout(timeout);
      wasResolved = true;
      console.warn(`[MEXC] HTTP Request error (${err.message}) on attempt ${attempt}`);
      if (attempt < 3) {
        setTimeout(() => {
          fetchMexcTickersDirect(attempt + 1).then(resolve);
        }, 1500);
      } else {
        console.error(`[MEXC] All 3 ticker fetch attempts failed: ${err.message}`);
        resolve({});
      }
    });
  });
}

// In-memory resilient cache for WEEX tickers to ensure 0 data loss during network spikes or transient timeouts
let cachedWeexTickers: Record<string, any> = {};

/**
 * Прямой HTTP-парсер тикеров фьючерсов WEEX (в обход ограничений/задержек CCXT).
 * Поддерживает локальный resilient кэш на случай сетевых таймаутов и мягкий ретрай.
 */
export async function fetchWeexTickersDirect(attempt: number = 1): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const timeoutVal = 10000;
    let wasResolved = false;

    const options = {
      hostname: 'api-contract.weex.com',
      port: 443,
      path: '/capi/v3/market/ticker/24hr',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    };

    const timeout = setTimeout(() => {
      if (wasResolved) return;
      wasResolved = true;
      console.warn(`[WEEX] Ticker fetch timed out (10s) - Attempt ${attempt}`);
      try { request.destroy(); } catch {}
      if (attempt < 2) {
        setTimeout(() => {
          fetchWeexTickersDirect(attempt + 1).then(resolve);
        }, 500);
      } else if (Object.keys(cachedWeexTickers).length > 0) {
        console.warn(`[WEEX] Timeout on attempt ${attempt}. Serving ${Object.keys(cachedWeexTickers).length} resilient cached tickers.`);
        resolve(cachedWeexTickers);
      } else {
        resolve({});
      }
    }, timeoutVal);

    const request = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (wasResolved) return;
        clearTimeout(timeout);
        wasResolved = true;
        try {
          const json = JSON.parse(data);
          if (Array.isArray(json)) {
            const result: Record<string, any> = {};
            json.forEach((t: any) => {
              if (t && t.symbol && t.symbol.endsWith('USDT')) {
                const base = t.symbol.slice(0, -4);
                const symbol = base + '/USDT:USDT';
                const lastVal = parseFloat(t.lastPrice) || 0;
                result[symbol] = {
                  symbol,
                  timestamp: t.closeTime || Date.now(),
                  high: parseFloat(t.highPrice) || 0,
                  low: parseFloat(t.lowPrice) || 0,
                  bid: lastVal,
                  bidVolume: undefined,
                  ask: lastVal,
                  askVolume: undefined,
                  open: parseFloat(t.openPrice) || 0,
                  close: lastVal,
                  last: lastVal,
                  percentage: parseFloat(t.priceChangePercent) || 0,
                  change: parseFloat(t.priceChange) || 0,
                  baseVolume: parseFloat(t.volume) || 0,
                  quoteVolume: parseFloat(t.quoteVolume) || 0,
                  markPrice: parseFloat(t.markPrice) || 0,
                  indexPrice: parseFloat(t.indexPrice) || 0,
                  info: t
                };
              }
            });
            cachedWeexTickers = result;
            (globalThis as any).WEEX_CACHED_TICKERS = result;
            console.log(`[WEEX] Successfully fetched ${Object.keys(result).length} tickers directly.`);
            resolve(result);
          } else {
            console.warn(`[WEEX] API response is not an array - Attempt ${attempt}`);
            if (attempt < 2) {
              setTimeout(() => {
                fetchWeexTickersDirect(attempt + 1).then(resolve);
              }, 500);
            } else if (Object.keys(cachedWeexTickers).length > 0) {
              resolve(cachedWeexTickers);
            } else {
              resolve({});
            }
          }
        } catch (e) {
          console.warn(`[WEEX] JSON parse error - Attempt ${attempt}`);
          if (attempt < 2) {
            setTimeout(() => {
              fetchWeexTickersDirect(attempt + 1).then(resolve);
            }, 500);
          } else if (Object.keys(cachedWeexTickers).length > 0) {
            resolve(cachedWeexTickers);
          } else {
            resolve({});
          }
        }
      });
    });

    request.on('error', (err) => {
      if (wasResolved) return;
      clearTimeout(timeout);
      wasResolved = true;
      console.warn(`[WEEX] HTTP Request error (${err.message}) on attempt ${attempt}`);
      if (attempt < 2) {
        setTimeout(() => {
          fetchWeexTickersDirect(attempt + 1).then(resolve);
        }, 500);
      } else if (Object.keys(cachedWeexTickers).length > 0) {
        resolve(cachedWeexTickers);
      } else {
        resolve({});
      }
    });
  });
}
