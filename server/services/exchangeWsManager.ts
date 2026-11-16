import WebSocket from 'ws';

/**
 * WEEX Futures V3 Public WebSocket Manager
 * Official docs:
 *  - Intro & heartbeat ping/pong: https://www.weex.com/api-doc/products/futures/streams/websocket-intro
 *  - Tickers channel payload: https://www.weex.com/api-doc/spot/Websocket/public/Tickers-Channel
 *    and https://www.weex.com/legacy-docs/contract/Websocket/public/Tickers-Channel
 */

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
    Weex?: Record<string, any>;
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

export interface WeexWsWatchdogStatus {
  connected: boolean;
  connecting: boolean;
  offlineDisabled: boolean;
  observeOnly: boolean;
  url: string;
  subscribedCount: number;
  tickerCount: number;
  lastMessageAt: number | null;
  reconnectCount: number;
  lastError: string | null;
}

export interface WsObserveSymbolSnapshot {
  symbol: string;
  pair: string;
  wsPrice: number;
  restPrice: number | null;
  diffPct: number | null;
  lastTickAt: number;
  ageSec: number;
}

export interface WsObserveSummary {
  ticksInWindow: number;
  totalTicks: number;
  trackedSymbolsCount: number;
  symbols: WsObserveSymbolSnapshot[];
  logLine: string;
}

export class ExchangeWsManager {
  private static readonly WEEX_PUBLIC_WS_URL = 'wss://ws-contract.weex.com/v3/ws/public';
  private static readonly MAX_CHANNELS_PER_CONN = 50;

  private ctx: ExchangeWsManagerContext;
  private liquidationsCleanupInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private observeSummaryInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private weexWs: WebSocket | null = null;
  private isStopped: boolean = false;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private observeOnly: boolean = false;
  private lastMessageAt: number | null = null;
  private reconnectCount: number = 0;
  private subscribedCount: number = 0;
  private lastError: string | null = null;
  private tickerUpdatesCount: number = 0;

  private observeWindowTickCount: number = 0;
  private observeBySymbol: Map<string, { pair: string; lastPrice: number; lastTickAt: number }> = new Map();

  constructor(context: ExchangeWsManagerContext) {
    this.ctx = context;
  }

  public isObserveOnly(): boolean {
    return this.observeOnly;
  }

  public setObserveOnly(value: boolean): void {
    this.observeOnly = value;
  }

  public startAll(options?: { observeOnly?: boolean }) {
    this.isStopped = false;
    this.observeOnly = options?.observeOnly ?? false;
    this.startCleanups();

    if (this.observeOnly) {
      if (this.observeSummaryInterval) clearInterval(this.observeSummaryInterval);
      this.observeSummaryInterval = setInterval(() => {
        const summary = this.flushObserveSummaryLog();
        console.log(summary.logLine);
      }, 60 * 1000);
      this.observeSummaryInterval.unref?.();
    }

    const isOfflineOrTest = process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1' || Boolean(process.env.VITEST);
    if (!isOfflineOrTest) {
      this.connectWeexWs();
    }
  }

  public stopAll() {
    this.isStopped = true;
    if (this.liquidationsCleanupInterval) {
      clearInterval(this.liquidationsCleanupInterval);
      this.liquidationsCleanupInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.observeSummaryInterval) {
      clearInterval(this.observeSummaryInterval);
      this.observeSummaryInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.weexWs) {
      try {
        this.weexWs.removeAllListeners();
        this.weexWs.close();
      } catch {}
      this.weexWs = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }

  public getWatchdogStatus(): { weex: WeexWsWatchdogStatus } {
    const isOfflineOrTest = process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1' || Boolean(process.env.VITEST);
    return {
      weex: {
        connected: this.isConnected,
        connecting: this.isConnecting,
        offlineDisabled: isOfflineOrTest,
        observeOnly: this.observeOnly,
        url: ExchangeWsManager.WEEX_PUBLIC_WS_URL,
        subscribedCount: this.subscribedCount,
        tickerCount: this.tickerUpdatesCount,
        lastMessageAt: this.lastMessageAt,
        reconnectCount: this.reconnectCount,
        lastError: this.lastError
      }
    };
  }

  public getObserveSnapshot(nowTs = Date.now()): WsObserveSummary {
    const ccxtTickers = this.ctx.getGlobalCcxtTickers?.() || {};
    const weexRestMap = ccxtTickers.weex || {};
    const symbols: WsObserveSymbolSnapshot[] = [];

    for (const [symbol, rec] of this.observeBySymbol.entries()) {
      const restEntry = weexRestMap[rec.pair] || weexRestMap[symbol] || weexRestMap[`${rec.pair}:USDT`];
      const restPriceRaw = Number(restEntry?.last ?? restEntry?.close ?? 0);
      const restPrice = Number.isFinite(restPriceRaw) && restPriceRaw > 0 ? restPriceRaw : null;
      const diffPct = restPrice !== null
        ? Number((((rec.lastPrice - restPrice) / restPrice) * 100).toFixed(4))
        : null;
      symbols.push({
        symbol,
        pair: rec.pair,
        wsPrice: rec.lastPrice,
        restPrice,
        diffPct,
        lastTickAt: rec.lastTickAt,
        ageSec: Math.max(0, Math.round((nowTs - rec.lastTickAt) / 1000))
      });
    }

    symbols.sort((a, b) => b.lastTickAt - a.lastTickAt);
    const preview = symbols.slice(0, 8).map((s) => {
      const restStr = s.restPrice !== null ? `${s.restPrice}` : 'N/A';
      const diffStr = s.diffPct !== null ? `${s.diffPct >= 0 ? '+' : ''}${s.diffPct}%` : 'N/A';
      return `${s.symbol}(ws=${s.wsPrice},rest=${restStr},diff=${diffStr},age=${s.ageSec}s)`;
    }).join(', ');

    const logLine = `[WS OBSERVE] 60s ticks=${this.observeWindowTickCount}, total=${this.tickerUpdatesCount}, symbols=${symbols.length}${preview ? ` | ${preview}` : ''}`;

    return {
      ticksInWindow: this.observeWindowTickCount,
      totalTicks: this.tickerUpdatesCount,
      trackedSymbolsCount: symbols.length,
      symbols,
      logLine
    };
  }

  public flushObserveSummaryLog(nowTs = Date.now()): WsObserveSummary {
    const summary = this.getObserveSnapshot(nowTs);
    this.observeWindowTickCount = 0;
    return summary;
  }

  private applyTickerPayload(payload: any, msg: any, rawStream: string, fromV3Array: boolean): void {
    if (!payload || typeof payload !== 'object') return;
    const rawSym = String(payload?.s || payload?.symbol || msg?.s || msg?.symbol || rawStream.split('@')[0] || '').trim();
    if (!rawSym) return;

    const cleanSym = rawSym.replace(/[\/:_-]/g, '').toUpperCase();
    if (!cleanSym.endsWith('USDT') && !cleanSym.endsWith('USDC')) return;
    const quote = cleanSym.endsWith('USDC') ? 'USDC' : 'USDT';
    const base = cleanSym.slice(0, cleanSym.length - quote.length);
    const pair = `${base}/${quote}`;

    const last = Number(payload?.c ?? payload?.last ?? payload?.lastPrice ?? payload?.close ?? 0);
    if (!isFinite(last) || last <= 0) return;

    const now = Date.now();
    this.lastMessageAt = now;
    this.tickerUpdatesCount++;

    if (this.observeOnly) {
      this.observeWindowTickCount++;
      this.observeBySymbol.set(cleanSym, { pair, lastPrice: last, lastTickAt: now });
      return;
    }

    const bid = Number(payload?.b ?? payload?.bidPrice ?? payload?.best_bid ?? last) || last;
    const ask = Number(payload?.a ?? payload?.askPrice ?? payload?.best_ask ?? last) || last;
    const quoteVol = Number(payload?.q ?? payload?.quoteVolume ?? payload?.volume_24h ?? 0) || 0;
    const baseVol = Number(payload?.v ?? payload?.volume ?? 0) || 0;
    const openPrice = Number(payload?.o ?? 0);
    let pct = Number(payload?.P ?? payload?.priceChangePercent ?? payload?.change24h ?? 0);
    // WEEX V3 @ticker array sends P as decimal ratio (e.g. "-0.063311" for -6.33%)
    if (fromV3Array && isFinite(pct) && Math.abs(pct) <= 1 && isFinite(openPrice) && openPrice > 0) {
      const empiricalRatio = (last - openPrice) / openPrice;
      if (Math.abs(empiricalRatio - pct) < 0.02) {
        pct = Number((pct * 100).toFixed(4));
      }
    }

    const wsTickers = this.ctx.getWsTickers();
    const tickerObj = {
      exchange: 'WEEX',
      pair,
      bid,
      bidQty: Number(payload?.B ?? payload?.bidQty ?? 0),
      ask,
      askQty: Number(payload?.A ?? payload?.askQty ?? 0),
      url: this.ctx.getExchangeLink('weex', pair),
      timestamp: now,
      last
    };

    if (wsTickers) {
      if (wsTickers.WEEX) {
        wsTickers.WEEX[pair] = tickerObj;
        wsTickers.WEEX[cleanSym] = tickerObj;
      }
      if (wsTickers.Weex) {
        wsTickers.Weex[pair] = tickerObj;
        wsTickers.Weex[cleanSym] = tickerObj;
      }
    }

    const ccxtTickers = this.ctx.getGlobalCcxtTickers();
    if (ccxtTickers) {
      if (!ccxtTickers.weex) ccxtTickers.weex = {};
      const prev = ccxtTickers.weex[pair] || {};
      ccxtTickers.weex[pair] = {
        ...prev,
        symbol: pair,
        last,
        close: last,
        bid,
        ask,
        quoteVolume: quoteVol > 0 ? quoteVol : prev.quoteVolume,
        baseVolume: baseVol > 0 ? baseVol : prev.baseVolume,
        percentage: !isNaN(pct) && pct !== 0 ? pct : prev.percentage,
        _pctScaled: true,
        timestamp: now
      };
    }

    this.ctx.updateLocalCandlesForSymbol(cleanSym, last, 0);
    this.ctx.throttlePriceEmit();
  }

  /**
   * Handles incoming raw WEEX V3 WebSocket ticker or ping frames.
   * Supports both WEEX V3 Futures `d: [...]` array frames (with top-level `s`) and legacy flat/`data` frames.
   */
  public handleIncomingMessage(rawPayload: string | Buffer): void {
    try {
      const text = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
      if (!text) return;
      const msg = JSON.parse(text);

      // Respond to WEEX V3 server heartbeat ping
      if (msg?.event === 'ping') {
        if (this.weexWs && this.weexWs.readyState === WebSocket.OPEN) {
          this.weexWs.send(JSON.stringify({ method: 'PONG', id: 1 }));
        }
        this.lastMessageAt = Date.now();
        return;
      }

      if (msg?.event === 'connected') {
        this.lastMessageAt = Date.now();
        return;
      }

      if (msg?.result === true && msg?.id !== undefined) {
        this.lastMessageAt = Date.now();
        return;
      }

      const rawStream = typeof msg?.stream === 'string' ? msg.stream : '';

      // Official WEEX Futures V3 format: { e: "ticker", E: <ts>, s: "BTCUSDT", d: [ { c: "...", P: "...", ... } ] }
      if (Array.isArray(msg?.d)) {
        for (const item of msg.d) {
          this.applyTickerPayload(item, msg, rawStream, true);
        }
        return;
      }

      // Legacy / flat object format: { stream: "BTCUSDT@ticker", data: { s: "BTCUSDT", c: ... } } or flat object
      const payload = msg?.data && typeof msg.data === 'object' ? msg.data : msg;
      this.applyTickerPayload(payload, msg, rawStream, false);
    } catch {
      // Ignore malformed non-JSON WS frames cleanly
    }
  }

  private connectWeexWs() {
    if (this.isStopped || this.isConnecting || this.isConnected) return;
    this.isConnecting = true;
    this.lastError = null;

    try {
      const ws = new WebSocket(ExchangeWsManager.WEEX_PUBLIC_WS_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        handshakeTimeout: 10000
      });
      this.weexWs = ws;

      ws.on('open', () => {
        this.isConnecting = false;
        this.isConnected = true;
        this.lastMessageAt = Date.now();
        this.lastError = null;

        const pairs = (this.ctx.getPairs() || []).slice(0, ExchangeWsManager.MAX_CHANNELS_PER_CONN);
        const channels = Array.from(new Set(
          pairs
            .map(p => p.replace(/[\/:]/g, '').toUpperCase())
            .filter(Boolean)
            .map(sym => `${sym}@ticker`)
        ));

        this.subscribedCount = channels.length;
        if (channels.length > 0) {
          ws.send(JSON.stringify({
            method: 'SUBSCRIBE',
            params: channels,
            id: 1
          }));
        }

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch {}
          }
        }, 20000);
        this.heartbeatInterval.unref?.();

        this.ctx.logStructured?.('info', 'WS_MANAGER', `WEEX V3 Public WS connected (${channels.length} ticker streams, observeOnly=${this.observeOnly}).`);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleIncomingMessage(data as string | Buffer);
      });

      ws.on('error', (err: Error) => {
        this.lastError = err?.message || 'WEEX WS error';
        this.isConnecting = false;
      });

      ws.on('close', () => {
        this.isConnected = false;
        this.isConnecting = false;
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        if (!this.isStopped) {
          this.scheduleReconnect();
        }
      });
    } catch (err: any) {
      this.isConnecting = false;
      this.isConnected = false;
      this.lastError = err?.message || 'WEEX WS init exception';
      if (!this.isStopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (this.isStopped || this.reconnectTimer) return;
    this.reconnectCount++;
    const delayMs = Math.min(30000, 1500 * Math.pow(2, Math.min(4, this.reconnectCount - 1)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWeexWs();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private startCleanups() {
    if (this.liquidationsCleanupInterval) clearInterval(this.liquidationsCleanupInterval);
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
    this.liquidationsCleanupInterval.unref?.();
  }
}
