import fs from 'fs';
import path from 'path';
import { isMainThread } from 'worker_threads';

export interface FunnelEvent {
  ts: number;
  symbol?: string;
  stage: string;
  reason: string;
}

export interface FunnelState {
  buckets: Record<string, Record<string, number>>; // hourISO -> stage|reason -> count
  recentEvents: FunnelEvent[];
}

const FUNNEL_FILE = path.resolve(process.cwd(), 'data/funnel.json');
const MAX_HOURS_HISTORY = 72;
const MAX_RECENT_EVENTS = 300;

let funnelState: FunnelState = {
  buckets: {},
  recentEvents: []
};

let autoFlushTimer: NodeJS.Timeout | null = null;

function writeAtomicJson(filePath: string, data: any): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp_${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error('[FUNNEL] Failed to write atomic funnel file:', err);
  }
}

export function loadFunnelState(): void {
  if (!isMainThread) return;
  try {
    if (fs.existsSync(FUNNEL_FILE)) {
      const raw = fs.readFileSync(FUNNEL_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.buckets === 'object') {
        funnelState.buckets = parsed.buckets || {};
        funnelState.recentEvents = Array.isArray(parsed.recentEvents) ? parsed.recentEvents : [];
      }
    }
  } catch (err) {
    console.warn('[FUNNEL] Failed to load initial funnel state (using clean):', err);
  }
}

export function flushFunnelCounters(): void {
  if (!isMainThread) return;
  pruneOldBuckets();
  writeAtomicJson(FUNNEL_FILE, funnelState);
}

function pruneOldBuckets(now = Date.now()): void {
  const minTime = now - MAX_HOURS_HISTORY * 3600 * 1000;
  for (const hourISO of Object.keys(funnelState.buckets)) {
    const bucketTime = new Date(hourISO).getTime();
    if (isNaN(bucketTime) || bucketTime < minTime) {
      delete funnelState.buckets[hourISO];
    }
  }
}

export function initFunnelCounters(): void {
  if (!isMainThread) return;
  loadFunnelState();
  if (!autoFlushTimer) {
    autoFlushTimer = setInterval(() => {
      flushFunnelCounters();
    }, 60000);
    autoFlushTimer.unref();
  }
}

// Auto-initialize on import in main thread
if (isMainThread) {
  initFunnelCounters();
}

export function incFunnel(stage: string, reason: string, symbol?: string): void {
  if (!isMainThread) return;
  try {
    const now = Date.now();
    const hourISO = new Date(Math.floor(now / 3600000) * 3600000).toISOString();

    if (!funnelState.buckets[hourISO]) {
      funnelState.buckets[hourISO] = {};
    }

    const key = `${stage}|${reason}`;
    funnelState.buckets[hourISO][key] = (funnelState.buckets[hourISO][key] || 0) + 1;

    funnelState.recentEvents.push({
      ts: now,
      symbol,
      stage,
      reason
    });

    if (funnelState.recentEvents.length > MAX_RECENT_EVENTS) {
      funnelState.recentEvents.splice(0, funnelState.recentEvents.length - MAX_RECENT_EVENTS);
    }
  } catch {
    // Non-blocking telemetry
  }
}

export function getFunnelData(hours = 24): {
  hoursRequested: number;
  aggregated: Record<string, number>;
  events: FunnelEvent[];
} {
  try {
    const now = Date.now();
    const minTime = now - Math.max(1, hours) * 3600 * 1000;
    const aggregated: Record<string, number> = {};

    for (const [hourISO, counts] of Object.entries(funnelState.buckets)) {
      const bucketTime = new Date(hourISO).getTime();
      if (!isNaN(bucketTime) && bucketTime >= minTime) {
        for (const [key, count] of Object.entries(counts)) {
          aggregated[key] = (aggregated[key] || 0) + count;
        }
      }
    }

    const recent100 = funnelState.recentEvents
      .filter(e => e.ts >= minTime)
      .slice(-100);

    return {
      hoursRequested: hours,
      aggregated,
      events: recent100
    };
  } catch {
    return {
      hoursRequested: hours,
      aggregated: {},
      events: []
    };
  }
}

export function resetFunnelForTest(): void {
  funnelState = {
    buckets: {},
    recentEvents: []
  };
}
