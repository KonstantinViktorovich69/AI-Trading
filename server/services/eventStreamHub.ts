import { EventEmitter } from 'events';

export interface AgentExchangeLog {
  id: string;
  timestamp: number;
  fromAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER';
  toAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER' | 'ALL';
  message: string;
  details?: string;
  type: 'info' | 'success' | 'warning';
}

export interface EventStreamHubDependencies {
  getCachedDB?: () => any;
  flushDB?: () => Promise<void> | void;
  maxLogsCount?: number;
}

export class EventStreamHub {
  private emitter: EventEmitter;
  private agentExchangeLogs: AgentExchangeLog[] = [];
  private deps: EventStreamHubDependencies;

  constructor(deps: EventStreamHubDependencies = {}) {
    this.deps = deps;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  public getEmitter(): EventEmitter {
    return this.emitter;
  }

  public getAgentExchangeLogs(): AgentExchangeLog[] {
    return this.agentExchangeLogs;
  }

  public setAgentExchangeLogs(logs: AgentExchangeLog[]): void {
    this.agentExchangeLogs = logs;
  }

  public logAgentExchange(
    fromAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER',
    toAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER' | 'ALL',
    message: string,
    details?: string,
    type: 'info' | 'success' | 'warning' = 'info'
  ): AgentExchangeLog {
    const log: AgentExchangeLog = {
      id: `el_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: Date.now(),
      fromAgent,
      toAgent,
      message,
      details,
      type
    };

    this.agentExchangeLogs.push(log);
    const maxCount = this.deps.maxLogsCount || 100;
    if (this.agentExchangeLogs.length > maxCount) {
      this.agentExchangeLogs.shift();
    }

    if (this.deps.getCachedDB && this.deps.flushDB) {
      try {
        const dbData = this.deps.getCachedDB();
        if (dbData) {
          dbData.agentExchangeLogs = this.agentExchangeLogs;
          this.deps.flushDB();
        }
      } catch (err) {
        // Fail-safe silently for non-critical logging persist
      }
    }

    this.emitter.emit('signals_updated');
    return log;
  }

  public emit(event: string, ...args: any[]): boolean {
    return this.emitter.emit(event, ...args);
  }

  public on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  public off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  public notifySignalsUpdated(): void {
    this.emitter.emit('signals_updated');
  }

  public notifyPriceTick(symbol: string, price: number): void {
    this.emitter.emit('price_tick', { symbol, price, timestamp: Date.now() });
  }
}
