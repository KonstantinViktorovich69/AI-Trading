import WebSocket from 'ws';

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
  url: string;
  subscribedCount: number;
  tickerCount: number;
  lastMessageAt: number | null;
  reconnectCount: number;
  lastError: string | null;
}

export class ExchangeWsManager {
  private static readonly WEEX_PUBLIC_WS_URL = 'wss://ws-contract.weex.com/v3/ws/public';
  private static readonly MAX_CHANNELS_PER_CONN = 50;

  private ctx: ExchangeWsManagerContext;
  private liquidationsCleanupInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private weexWs: WebSocket | null = null;
  private isStopped: boolean = false;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private lastMessageAt: number | null = null;
  private reconnectCount: number = 0;
  private subscribedCount: number = 0;
  private lastError: string | null = null;
  private tickerUpdatesCount: number = 0;

  constructor(context: ExchangeWsManagerContext) {
    this.ctx = context;
  }

  public startAll() {
    this.isStopped = false;
    this.startCleanups();

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
        url: ExchangeWsManager.WEEX_PUBLIC_WS_URL,
        subscribedCount: this.subscribedCount,
        tickerCount: this.tickerUpdatesCount,
        lastMessageAt: this.lastMessageAt,
        reconnectCount: this.reconnectCount,
        lastError: this.lastError
      }
    };
  }

  /**
   * Handles incoming raw WEEX V3 WebSocket ticker or ping frames.
   * Exposed publicly so unit tests can feed real WEEX V3 payloads deterministically without network sockets.
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

      if (msg?.result === true && msg?.id !== undefined) {
        this.lastMessageAt = Date.now();
        return;
      }

      const payload = msg?.data && typeof msg.data === 'object' ? msg.data : msg;
      const rawStream = typeof msg?.stream === 'string' ? msg.stream : '';
      const rawSym = String(payload?.s || payload?.symbol || rawStream.split('@')[0] || '').trim();
      if (!rawSym) return;

      const cleanSym = rawSym.replace(/[\/:_-]/g, '').toUpperCase();
      if (!cleanSym.endsWith('USDT') && !cleanSym.endsWith('USDC')) return;
      const quote = cleanSym.endsWith('USDC') ? 'USDC' : 'USDT';
      const base = cleanSym.slice(0, cleanSym.length - quote.length);
      const pair = `${base}/${quote}`;

      const last = Number(payload?.c ?? payload?.last ?? payload?.lastPrice ?? payload?.close ?? 0);
      if (!isFinite(last) || last <= 0) return;

      const bid = Number(payload?.b ?? payload?.bidPrice ?? payload?.best_bid ?? last) || last;
      const ask = Number(payload?.a ?? payload?.askPrice ?? payload?.best_ask ?? last) || last;
      const quoteVol = Number(payload?.q ?? payload?.quoteVolume ?? payload?.volume_24h ?? 0) || 0;
      const baseVol = Number(payload?.v ?? payload?.volume ?? 0) || 0;
      const pct = Number(payload?.P ?? payload?.priceChangePercent ?? payload?.change24h ?? 0);
      const now = Date.now();

      this.lastMessageAt = now;
      this.tickerUpdatesCount++;

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

        this.ctx.logStructured?.('info', 'WS_MANAGER', `WEEX V3 Public WS connected (${channels.length} ticker streams).`);
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
