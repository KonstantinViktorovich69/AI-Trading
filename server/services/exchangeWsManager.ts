import WebSocket from 'ws';

export interface ExchangeWsManagerContext {
  getPairs: () => string[];
  getExchangeSymbols: () => Record<string, Record<string, string>>;
  getWsTickers: () => {
    Binance: Record<string, any>;
    Mexc: Record<string, any>;
    Bybit: Record<string, any>;
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
  getIsBinanceGeoblocked: () => boolean;
  setIsBinanceGeoblocked: (val: boolean) => void;
  throttlePriceEmit: () => void;
  getExchangeLink: (exchange: string, pair: string) => string;
  updateLocalCandlesForSymbol: (cleanSym: string, finalPrice: number, volumeDelta: number) => void;
  updateSignalsCache: () => void | Promise<void>;
  logStructured?: (type: string, module: string, message: string) => void;
}

export class ExchangeWsManager {
  private ctx: ExchangeWsManagerContext;

  private binanceWSInstance: WebSocket | null = null;
  private mexcWSInstance: WebSocket | null = null;
  private bybitWSInstance: WebSocket | null = null;
  private futuresLiquidationWSInstance: WebSocket | null = null;
  private binanceScannerWSInstance: WebSocket | null = null;

  public lastBinanceWSActivity: number = Date.now();
  public lastMexcWSActivity: number = Date.now();
  public lastBybitWSActivity: number = Date.now();
  public lastWebSocketActivity: number = Date.now();

  private watchdogInterval: NodeJS.Timeout | null = null;
  private liquidationsCleanupInterval: NodeJS.Timeout | null = null;

  constructor(context: ExchangeWsManagerContext) {
    this.ctx = context;
  }

  public startAll() {
    this.startBinanceWS();
    this.startBybitWS();
    this.startFuturesLiquidationWS();
    this.startWatchdog();
    this.startCleanups();
  }

  public stopAll() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.liquidationsCleanupInterval) clearInterval(this.liquidationsCleanupInterval);
    try { this.binanceWSInstance?.terminate(); } catch (e) {}
    try { this.mexcWSInstance?.terminate(); } catch (e) {}
    try { this.bybitWSInstance?.terminate(); } catch (e) {}
    try { this.futuresLiquidationWSInstance?.terminate(); } catch (e) {}
    try { this.binanceScannerWSInstance?.terminate(); } catch (e) {}
  }

  public getWatchdogStatus() {
    const now = Date.now();
    return {
      mexcTimeSinceLastActivity: now - this.lastMexcWSActivity,
      binanceTimeSinceLastActivity: now - this.lastBinanceWSActivity,
      bybitTimeSinceLastActivity: now - this.lastBybitWSActivity,
    };
  }

  public startBinanceWS(retryCount = 0) {
    if (this.ctx.getIsBinanceGeoblocked()) return;

    try {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws');
      this.binanceWSInstance = ws;

      ws.on('open', () => {
        retryCount = 0;
        this.lastBinanceWSActivity = Date.now();
        const pairs = this.ctx.getPairs();
        const exchangeSymbols = this.ctx.getExchangeSymbols();

        const streams = pairs.map(p => {
          const sym = exchangeSymbols.binance?.[p] || p.replace('/', '');
          return `${sym.toLowerCase()}@bookTicker`;
        });

        for (let i = 0; i < streams.length; i += 50) {
          ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams.slice(i, i + 50), id: i }));
        }
      });

      ws.on('message', (data: any) => {
        this.lastWebSocketActivity = Date.now();
        this.lastBinanceWSActivity = Date.now();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.u && msg.s) {
            const symbol = msg.s;
            const exchangeSymbols = this.ctx.getExchangeSymbols();
            const pair = Object.keys(exchangeSymbols.binance || {}).find(k => exchangeSymbols.binance[k] === symbol);
            if (pair) {
              const wsTickers = this.ctx.getWsTickers();
              wsTickers.Binance[pair] = {
                exchange: 'Binance',
                pair,
                bid: parseFloat(msg.b),
                bidQty: parseFloat(msg.B),
                ask: parseFloat(msg.a),
                askQty: parseFloat(msg.A),
                url: `https://www.binance.com/en/trade/${pair.replace('/', '_')}?type=spot`,
                timestamp: Date.now()
              };
              this.ctx.throttlePriceEmit();
            }
          }
        } catch (e) {}
      });

      ws.on('error', (err: any) => {
        const errStr = err?.message || err?.toString() || '';
        if (errStr.includes('451') || errStr.includes('restricted location') || errStr.includes('Eligibility')) {
          this.ctx.setIsBinanceGeoblocked(true);
          console.warn('[WS] Binance WS is geoblocked in Cloud environment (HTTP 451). Disabling Binance WS reconnects.');
          if (this.binanceWSInstance === ws) this.binanceWSInstance = null;
          return;
        }
        console.error('Binance WS error:', errStr);
      });

      ws.on('close', () => {
        if (this.binanceWSInstance === ws) this.binanceWSInstance = null;
        if (this.ctx.getIsBinanceGeoblocked()) return;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
        setTimeout(() => this.startBinanceWS(retryCount + 1), delay);
      });
    } catch (err) {
      console.error('[WS] Failed to create Binance WS instance:', err);
    }
  }

  public startBybitWS(retryCount = 0) {
    try {
      const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
      this.bybitWSInstance = ws;
      let pingInterval: any;

      ws.on('open', () => {
        retryCount = 0;
        this.lastBybitWSActivity = Date.now();
        const pairs = this.ctx.getPairs();
        const exchangeSymbols = this.ctx.getExchangeSymbols();

        const args = pairs.map(p => {
          const sym = exchangeSymbols.bybit?.[p] || p.replace('/', '');
          return `orderbook.1.${sym}`;
        });

        for (let i = 0; i < args.length; i += 10) {
          ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }));
        }

        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ op: 'ping' })); } catch (e) {}
          }
        }, 20000);
      });

      ws.on('message', (data: any) => {
        this.lastWebSocketActivity = Date.now();
        this.lastBybitWSActivity = Date.now();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.topic && msg.topic.startsWith('orderbook.1.') && msg.data) {
            const symbol = msg.data.s;
            const exchangeSymbols = this.ctx.getExchangeSymbols();
            const pair = Object.keys(exchangeSymbols.bybit || {}).find(k => exchangeSymbols.bybit[k] === symbol);
            if (pair) {
              const wsTickers = this.ctx.getWsTickers();
              const current = wsTickers.Bybit[pair] || {
                exchange: 'Bybit',
                pair,
                bid: 0,
                bidQty: 0,
                ask: 0,
                askQty: 0,
                url: '',
                timestamp: Date.now()
              };
              if (msg.data.b && msg.data.b.length > 0) {
                current.bid = parseFloat(msg.data.b[0][0]);
                current.bidQty = parseFloat(msg.data.b[0][1]);
              }
              if (msg.data.a && msg.data.a.length > 0) {
                current.ask = parseFloat(msg.data.a[0][0]);
                current.askQty = parseFloat(msg.data.a[0][1]);
              }
              current.timestamp = Date.now();
              wsTickers.Bybit[pair] = current;
              this.ctx.throttlePriceEmit();
            }
          }
        } catch (e) {}
      });

      ws.on('error', (err) => console.error('Bybit WS error:', err));

      ws.on('close', () => {
        if (this.bybitWSInstance === ws) this.bybitWSInstance = null;
        if (pingInterval) clearInterval(pingInterval);
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
        setTimeout(() => this.startBybitWS(retryCount + 1), delay);
      });
    } catch (err) {
      console.error('[WS] Failed to create Bybit WS instance:', err);
    }
  }

  public startMexcWS(retryCount = 0) {
    try {
      const ws = new WebSocket('wss://contract.mexc.com/edge');
      this.mexcWSInstance = ws;
      const subscribed = new Set<string>();
      let pingInterval: any;
      let subInterval: any;

      const subscribe = (p: string) => {
        if (!p) return;
        let mexcSym = p.replace('/', '_').split(':')[0].toUpperCase();
        if (!mexcSym.includes('_') && mexcSym.endsWith('USDT')) {
          mexcSym = mexcSym.replace('USDT', '_USDT');
        }
        if (subscribed.has(mexcSym)) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: mexcSym } }));
          subscribed.add(mexcSym);
        }
      };

      (globalThis as any).ensureMexcSubscription = subscribe;

      ws.on('open', () => {
        retryCount = 0;
        subscribed.clear();
        this.lastMexcWSActivity = Date.now();

        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ method: 'ping' })); } catch (e) {}
          }
        }, 20000);

        this.ctx.getPairs().forEach(p => subscribe(p));

        const subOpenTrades = () => {
          this.ctx.getVirtualTrades()
            .filter(t => t.status === 'OPEN' && t.exchange?.toLowerCase() === 'mexc')
            .forEach(t => subscribe(t.symbol));
        };
        subOpenTrades();
        subInterval = setInterval(subOpenTrades, 15000);
      });

      ws.on('message', (data: any) => {
        this.lastWebSocketActivity = Date.now();
        this.lastMexcWSActivity = Date.now();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.channel === 'push.ticker' && msg.data) {
            const t = msg.data;
            const mexcClean = t.symbol.replace('_', '').toUpperCase();
            const exchangeSymbols = this.ctx.getExchangeSymbols();
            const pair = Object.keys(exchangeSymbols.mexc || {}).find(k => exchangeSymbols.mexc[k] === mexcClean) || t.symbol.replace('_', '/').toUpperCase();

            const lastVal = parseFloat(t.lastPrice);
            const ticker = {
              exchange: 'MEXC',
              pair,
              bid: parseFloat(t.bid1),
              bidQty: 0,
              ask: parseFloat(t.ask1),
              askQty: 0,
              url: this.ctx.getExchangeLink('mexc', pair),
              timestamp: Date.now(),
              last: lastVal
            };
            const wsTickers = this.ctx.getWsTickers();
            wsTickers.Mexc[pair] = ticker as any;
            wsTickers.Mexc[mexcClean] = ticker as any;

            const cacheSignals = this.ctx.getCacheSignals();
            if (cacheSignals && cacheSignals.data) {
              const sig = cacheSignals.data.find((s: any) => s.symbol === pair || s.symbol === mexcClean || s.symbol === mexcClean + 'USDT' || s.symbol === pair.replace('/', ''));
              if (sig) {
                sig.price = lastVal;
                sig.target = (sig.signal?.includes('SELL') ? lastVal * 0.85 : lastVal * 1.15).toFixed(5);
              }
            }

            this.ctx.throttlePriceEmit();
          }
        } catch (e) {}
      });

      ws.on('error', (err) => console.error('MEXC WS error:', err));

      ws.on('close', () => {
        if (this.mexcWSInstance === ws) this.mexcWSInstance = null;
        if (pingInterval) clearInterval(pingInterval);
        if (subInterval) clearInterval(subInterval);
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
        setTimeout(() => this.startMexcWS(retryCount + 1), delay);
      });
    } catch (err) {
      console.error('[WS] Failed to create MEXC WS instance:', err);
    }
  }

  public startFuturesLiquidationWS(retryCount = 0) {
    if (this.ctx.getIsBinanceGeoblocked()) return;

    try {
      const ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      this.futuresLiquidationWSInstance = ws;

      ws.on('open', () => {
        retryCount = 0;
      });

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg && msg.e === 'forceOrder' && msg.o) {
            const symbol = msg.o.s;
            const side = msg.o.S;
            const value = parseFloat(msg.o.q) * (parseFloat(msg.o.ap) || parseFloat(msg.o.p));
            const cleanSym = symbol.replace('USDT', '');
            const globalLiquidations = this.ctx.getGlobalLiquidations();

            if (!globalLiquidations[cleanSym]) {
              globalLiquidations[cleanSym] = { shortsSq: 0, longsSq: 0, lastT: Date.now() };
            }
            if (side === 'BUY') globalLiquidations[cleanSym].shortsSq += value;
            else if (side === 'SELL') globalLiquidations[cleanSym].longsSq += value;
            globalLiquidations[cleanSym].lastT = Date.now();
          }
        } catch (e) {}
      });

      ws.on('error', (err: any) => {
        const errStr = err?.message || err?.toString() || '';
        if (errStr.includes('451') || errStr.includes('restricted location') || errStr.includes('Eligibility')) {
          this.ctx.setIsBinanceGeoblocked(true);
          console.warn('[WS] Binance Futures Liquidation WS is geoblocked (HTTP 451). Stopping stream.');
          if (this.futuresLiquidationWSInstance === ws) this.futuresLiquidationWSInstance = null;
          return;
        }
      });

      ws.on('close', () => {
        if (this.futuresLiquidationWSInstance === ws) this.futuresLiquidationWSInstance = null;
        if (this.ctx.getIsBinanceGeoblocked()) return;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
        setTimeout(() => this.startFuturesLiquidationWS(retryCount + 1), delay);
      });
    } catch (err) {
      console.error('[WS] Failed to create Binance Futures Liquidation WS instance:', err);
    }
  }

  public startBinanceScannerWS(retryCount = 0) {
    if (this.ctx.getIsBinanceGeoblocked()) return;

    try {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');
      this.binanceScannerWSInstance = ws;

      ws.on('open', () => {
        retryCount = 0;
      });

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (Array.isArray(msg)) {
            const globalCcxtTickers = this.ctx.getGlobalCcxtTickers();
            if (!globalCcxtTickers['binance']) globalCcxtTickers['binance'] = {};
            let updated = false;

            for (const t of msg) {
              if (t.s && t.s.endsWith('USDT')) {
                const cleanSym = t.s.replace('USDT', '');
                const symbol = t.s.replace('USDT', '/USDT');
                const existing = globalCcxtTickers['binance'][symbol] || {};

                // Check for whales / pumps
                const nowTime = Date.now();
                if (existing.quoteVolume && existing.last) {
                  const volDiff = parseFloat(t.q) - existing.quoteVolume;
                  if (volDiff > 2000000) { // 2M$ volume in 1 tick/second
                    this.ctx.getGlobalWhales()[cleanSym] = { amount: volDiff, time: nowTime };
                  }
                  // Check pump (price jump > 1.5% in 1 tick + large vol)
                  const priceDiffPct = ((parseFloat(t.c) - existing.last) / existing.last) * 100;
                  if (priceDiffPct > 1.5 && volDiff > 500000) {
                    this.ctx.getGlobalPumps().add(`${cleanSym}-${nowTime}`);
                  }

                  // CVD Approximation
                  if (volDiff > 0) {
                    const globalCvd = this.ctx.getGlobalCvd();
                    if (!globalCvd[cleanSym]) globalCvd[cleanSym] = { buyVol: 0, sellVol: 0, cvd: 0 };
                    const cPrice = parseFloat(t.c);
                    if (cPrice > existing.last) {
                      globalCvd[cleanSym].buyVol += volDiff;
                      globalCvd[cleanSym].cvd += volDiff;
                    } else if (cPrice < existing.last) {
                      globalCvd[cleanSym].sellVol += volDiff;
                      globalCvd[cleanSym].cvd -= volDiff;
                    }
                  }
                }

                globalCcxtTickers['binance'][symbol] = {
                  ...existing,
                  symbol: symbol,
                  last: parseFloat(t.c),
                  high: parseFloat(t.h),
                  low: parseFloat(t.l),
                  quoteVolume: parseFloat(t.q),
                  baseVolume: parseFloat(t.v),
                  percentage: parseFloat(t.P),
                  ask: parseFloat(t.a),
                  bid: parseFloat(t.b),
                };

                const binancePrice = parseFloat(t.c);
                const weexLast = globalCcxtTickers['weex']?.[`${cleanSym}/USDT`]?.last || globalCcxtTickers['weex']?.[`${cleanSym}/USDT:USDT`]?.last;
                const binanceLast = existing.last || binancePrice;

                let finalPrice = binancePrice;
                if (weexLast && binanceLast) {
                  finalPrice = binancePrice * (weexLast / binanceLast);
                } else if (weexLast) {
                  finalPrice = weexLast;
                }

                const volumeDelta = Math.max(0, parseFloat(t.v) - (existing.baseVolume || 0));
                this.ctx.updateLocalCandlesForSymbol(cleanSym, finalPrice, volumeDelta);
                updated = true;
              }
            }

            const cacheSignals = this.ctx.getCacheSignals();
            if (updated && cacheSignals && (Date.now() - (cacheSignals.lastUpdated || 0) > 3000)) {
              this.ctx.updateSignalsCache();
            }
          }
        } catch (e) {}
      });

      ws.on('error', (err: any) => {
        const errStr = err?.message || err?.toString() || '';
        if (errStr.includes('451') || errStr.includes('restricted location') || errStr.includes('Eligibility')) {
          this.ctx.setIsBinanceGeoblocked(true);
          console.warn('[WS] Binance Scanner WS is geoblocked in Cloud environment (HTTP 451). Stopping reconnects.');
          return;
        }
        console.error('Binance Scanner WS error:', errStr);
      });

      ws.on('close', () => {
        if (this.binanceScannerWSInstance === ws) this.binanceScannerWSInstance = null;
        if (this.ctx.getIsBinanceGeoblocked()) return;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
        setTimeout(() => this.startBinanceScannerWS(retryCount + 1), delay);
      });
    } catch (err) {
      console.error('[WS] Failed to create Binance Scanner WS instance:', err);
    }
  }

  private startWatchdog() {
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();

      // MEXC watchdog
      if (this.mexcWSInstance && (now - this.lastMexcWSActivity > 60000)) {
        console.log('[WATCHDOG] ⚠️ MEXC WebSocket не присылал данные более 60 секунд. Принудительный перезапуск потока...');
        try {
          this.mexcWSInstance.terminate();
        } catch (e) {
          console.error('[WATCHDOG] Ошибка при прерывании MEXC WS:', e);
        }
      }

      // Binance watchdog
      if (this.binanceWSInstance && (now - this.lastBinanceWSActivity > 60000)) {
        console.log('[WATCHDOG] ⚠️ Binance WebSocket не присылал данные более 60 секунд. Принудительный перезапуск потока...');
        try {
          this.binanceWSInstance.terminate();
        } catch (e) {
          console.error('[WATCHDOG] Ошибка при прерывании Binance WS:', e);
        }
      }

      // Bybit watchdog
      if (this.bybitWSInstance && (now - this.lastBybitWSActivity > 60000)) {
        console.log('[WATCHDOG] ⚠️ Bybit WebSocket не присылал данные более 60 секунд. Принудительный перезапуск потока...');
        try {
          this.bybitWSInstance.terminate();
        } catch (e) {
          console.error('[WATCHDOG] Ошибка при прерывании Bybit WS:', e);
        }
      }
    }, 30000);
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
