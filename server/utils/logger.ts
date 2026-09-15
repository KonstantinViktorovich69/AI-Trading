/**
 * Structured Logging Engine (Elastic/Prometheus style) with high-precision timestamps.
 */

export interface StructuredLog {
  timestamp: string;      // ISO format with milliseconds
  epochMs: number;        // Milliseconds for high-precision sorting
  level: 'info' | 'warn' | 'error' | 'success';
  component: string;      // e.g. 'SYSTEM', 'AUTOPILOT', 'CCXT', 'SIGNALS', 'KNOWLEDGE', 'API', 'LATENCY'
  symbol?: string;
  message: string;
  meta?: any;
}

const structuredLogs: StructuredLog[] = [];
const MAX_STRUCTURED_LOGS = 3000;

export function logStructured(
  level: 'info' | 'warn' | 'error' | 'success',
  component: string,
  message: string,
  symbol?: string,
  meta?: any
): void {
  const now = new Date();
  const logItem: StructuredLog = {
    timestamp: now.toISOString(),
    epochMs: now.getTime(),
    level,
    component,
    symbol: symbol ? symbol.toUpperCase().trim() : undefined,
    message,
    meta
  };
  structuredLogs.push(logItem);
  if (structuredLogs.length > MAX_STRUCTURED_LOGS) {
    structuredLogs.shift();
  }
}

export function getStructuredLogs(): readonly StructuredLog[] {
  return structuredLogs;
}

export function queryStructuredLogs(options: {
  limit?: number;
  offset?: number;
  component?: string;
  level?: string;
}): { total: number; limit: number; offset: number; logs: StructuredLog[] } {
  const limit = options.limit || 100;
  const offset = options.offset || 0;
  
  let filtered = [...structuredLogs];
  if (options.component) {
    filtered = filtered.filter(l => l.component.toUpperCase() === options.component!.toUpperCase());
  }
  if (options.level) {
    filtered = filtered.filter(l => l.level.toLowerCase() === options.level!.toLowerCase());
  }
  
  // Sort newest first
  filtered.sort((a, b) => b.epochMs - a.epochMs);
  
  const paginated = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    limit,
    offset,
    logs: paginated
  };
}
