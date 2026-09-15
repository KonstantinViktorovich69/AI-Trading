import { Exchange } from 'ccxt';
import { logStructured } from '../utils/logger.ts';

export interface PingHistoryEntry {
  timestamp: number;
  pingMs: number;
}

export class SystemMetricsCollector {
  private serverEventLoopLagMs = 0;
  private lastLoopCheck = Date.now();
  private loopIntervalTimer: NodeJS.Timeout | null = null;

  private currentExchangePingMs = 50;
  private exchangePingHistory: PingHistoryEntry[] = [];
  private pingIntervalTimer: NodeJS.Timeout | null = null;

  private activeExecutionLocks = new Set<string>();

  constructor() {
    this.startEventLoopLagMonitor();
  }

  // 1. High-Resolution Event Loop Lag Monitor
  private startEventLoopLagMonitor() {
    this.lastLoopCheck = Date.now();
    this.loopIntervalTimer = setInterval(() => {
      const now = Date.now();
      this.serverEventLoopLagMs = Math.max(0, now - this.lastLoopCheck - 150);
      this.lastLoopCheck = now;
    }, 150);
  }

  public getEventLoopLagMs(): number {
    return this.serverEventLoopLagMs;
  }

  // 2. Symbolic Mutex Lock Manager for concurrent order safety
  public acquireExecutionLock(symbol: string, ttlMs = 6000): boolean {
    if (!symbol) return true;
    const norm = symbol.replace(/[\/:]/g, '').toUpperCase();
    if (this.activeExecutionLocks.has(norm)) {
      return false; // Duplicate order blocked
    }
    this.activeExecutionLocks.add(norm);
    setTimeout(() => {
      this.activeExecutionLocks.delete(norm);
    }, ttlMs);
    return true;
  }

  public releaseExecutionLock(symbol: string): void {
    if (!symbol) return;
    const norm = symbol.replace(/[\/:]/g, '').toUpperCase();
    this.activeExecutionLocks.delete(norm);
  }

  public isExecutionLocked(symbol: string): boolean {
    if (!symbol) return false;
    const norm = symbol.replace(/[\/:]/g, '').toUpperCase();
    return this.activeExecutionLocks.has(norm);
  }

  // 3. Exchange Telemetry Ping Monitor
  public getCurrentExchangePingMs(): number {
    return this.currentExchangePingMs;
  }

  public getExchangePingHistory(): PingHistoryEntry[] {
    return this.exchangePingHistory;
  }

  public async pingExchange(client: Exchange | null): Promise<number | null> {
    if (!client) return null;
    try {
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
      if (this.exchangePingHistory.length > 200) {
        this.exchangePingHistory.shift();
      }

      if (diff > 300) {
        logStructured('warn', 'LATENCY', `High execution latency detected: ${diff}ms. Autopilot orders may experience slippage!`, undefined, { pingMs: diff });
      } else {
        logStructured('info', 'LATENCY', `Raw connection response delay: ${diff}ms`, undefined, { pingMs: diff });
      }
      return diff;
    } catch (err: any) {
      logStructured('warn', 'LATENCY', `Unable to estimate API ping response: ${err.message || err}`);
      return null;
    }
  }

  public startPingScheduler(getClientFn: () => Exchange | null, intervalMs = 15000) {
    if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
      return;
    }
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
    }
    this.pingIntervalTimer = setInterval(async () => {
      const client = getClientFn();
      if (client) {
        await this.pingExchange(client);
      }
    }, intervalMs);
  }

  public dispose() {
    if (this.loopIntervalTimer) clearInterval(this.loopIntervalTimer);
    if (this.pingIntervalTimer) clearInterval(this.pingIntervalTimer);
    this.activeExecutionLocks.clear();
  }
}

export const systemMetricsCollector = new SystemMetricsCollector();
