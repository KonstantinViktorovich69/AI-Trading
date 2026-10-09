import fs from 'fs';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { getBuildId, PROCESS_STARTED_AT } from './buildInfo.ts';

export interface HeartbeatPayload {
  ts: number;
  pid: number;
  buildId: string;
  processStartedAt: number;
  seq: number;
}

export type GapKind = 'RESTART_GAP' | 'RESTART_GAP_ESTIMATED' | 'FREEZE_GAP' | 'STALE_FEED';

export interface DowntimeGap {
  id: string;
  kind: GapKind;
  from: number;
  to: number;
  durationSec: number;
  prevBuildId?: string;
  newBuildId?: string;
  source?: string;
  symbol?: string;
  details?: Record<string, any>;
}

export interface HeartbeatDeps {
  getVirtualTrades: () => any[];
  getLoadedStateUpdatedAt?: () => number | undefined;
  saveTradeDB?: (trade: any) => Promise<any> | void;
}

export type GapListener = (gap: DowntimeGap) => void;
export type TradeGapHook = (trade: any, gap: DowntimeGap) => void;

const HEARTBEAT_FILE = path.resolve(process.cwd(), 'data/heartbeat.json');
const DOWNTIME_LOG_FILE = path.resolve(process.cwd(), 'data/downtime-log.json');
const MAX_DOWNTIME_ENTRIES = 200;

let heartbeatSeq = 0;
let heartbeatIntervalTimer: NodeJS.Timeout | null = null;
let lastHeartbeatTs: number | null = null;
let activeDeps: HeartbeatDeps | null = null;

const lastTickTimes: Record<'watchdog' | 'autopilot' | 'heartbeat', number> = {
  watchdog: Date.now(),
  autopilot: Date.now(),
  heartbeat: Date.now()
};

let downtimeGaps: DowntimeGap[] = [];
const gapListeners: GapListener[] = [];
const tradeGapHooks: TradeGapHook[] = [];

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
    console.error(`[HEARTBEAT] Failed to write atomic file ${filePath}:`, err);
  }
}

export function loadDowntimeLog(): void {
  try {
    if (fs.existsSync(DOWNTIME_LOG_FILE)) {
      const raw = fs.readFileSync(DOWNTIME_LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        downtimeGaps = parsed;
      }
    }
  } catch (err) {
    console.warn('[HEARTBEAT] Could not load existing downtime-log.json:', err);
  }
}

function saveDowntimeLog(): void {
  try {
    if (downtimeGaps.length > MAX_DOWNTIME_ENTRIES) {
      downtimeGaps = downtimeGaps.slice(-MAX_DOWNTIME_ENTRIES);
    }
    writeAtomicJson(DOWNTIME_LOG_FILE, downtimeGaps);
  } catch (err) {
    console.error('[HEARTBEAT] Could not save downtime log:', err);
  }
}

export function registerGapListener(fn: GapListener): void {
  gapListeners.push(fn);
}

export function registerTradeGapHook(fn: TradeGapHook): void {
  tradeGapHooks.push(fn);
}

export function recordGap(
  kind: GapKind,
  from: number,
  to: number,
  meta?: { prevBuildId?: string; newBuildId?: string; source?: string; symbol?: string; [key: string]: any }
): DowntimeGap | null {
  try {
    if (to <= from) return null;
    const durationSec = Math.max(1, Math.round((to - from) / 1000));
    const now = Date.now();

    // Check if overlaps or connects with the latest gap recorded in last 60 seconds
    const lastGap = downtimeGaps[downtimeGaps.length - 1];
    if (
      lastGap &&
      (from <= lastGap.to + 60000) &&
      (now - lastGap.to <= 60000 || from <= lastGap.to)
    ) {
      lastGap.to = Math.max(lastGap.to, to);
      lastGap.durationSec = Math.max(1, Math.round((lastGap.to - lastGap.from) / 1000));
      saveDowntimeLog();
      for (const listener of gapListeners) {
        try { listener(lastGap); } catch {}
      }
      return lastGap;
    }

    const newGap: DowntimeGap = {
      id: `gap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      kind,
      from,
      to,
      durationSec,
      prevBuildId: meta?.prevBuildId,
      newBuildId: meta?.newBuildId,
      source: meta?.source,
      symbol: meta?.symbol,
      details: meta
    };

    downtimeGaps.push(newGap);
    saveDowntimeLog();

    for (const listener of gapListeners) {
      try { listener(newGap); } catch {}
    }

    // Try applying gap immediately to open trades if deps available
    if (activeDeps) {
      try {
        const trades = activeDeps.getVirtualTrades();
        if (Array.isArray(trades)) {
          applyPendingGapsToOpenTrades(trades, activeDeps.saveTradeDB);
        }
      } catch (err) {
        console.warn('[HEARTBEAT] Failed auto-applying gap to open trades:', err);
      }
    }

    return newGap;
  } catch (err) {
    console.error('[HEARTBEAT] Error recording gap:', err);
    return null;
  }
}

export function startHeartbeat(deps: HeartbeatDeps): void {
  if (!isMainThread) return;
  activeDeps = deps;
  loadDowntimeLog();

  const now = Date.now();
  const currentBuild = getBuildId();

  // 1. Synchronously read data/heartbeat.json of previous process
  try {
    if (fs.existsSync(HEARTBEAT_FILE)) {
      const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8');
      const prev = JSON.parse(raw);
      if (prev && typeof prev.ts === 'number') {
        const diffMs = now - prev.ts;
        if (diffMs > 45000) {
          recordGap('RESTART_GAP', prev.ts, now, {
            prevBuildId: prev.buildId,
            newBuildId: currentBuild
          });
        }
      }
    } else if (deps.getLoadedStateUpdatedAt) {
      const updatedAt = deps.getLoadedStateUpdatedAt();
      if (typeof updatedAt === 'number' && updatedAt > 0) {
        const diffMs = now - updatedAt;
        if (diffMs > 45000) {
          recordGap('RESTART_GAP_ESTIMATED', updatedAt, now, {
            newBuildId: currentBuild
          });
        }
      }
    }
  } catch (err) {
    console.warn('[HEARTBEAT] Error checking previous heartbeat:', err);
  }

  // 2. Write initial heartbeat tick
  writeHeartbeatTick(now);

  // 3. Setup recurring 15s interval
  if (heartbeatIntervalTimer) {
    clearInterval(heartbeatIntervalTimer);
  }

  heartbeatIntervalTimer = setInterval(() => {
    try {
      observeLoopTick('heartbeat');
      writeHeartbeatTick(Date.now());
    } catch (err) {
      console.warn('[HEARTBEAT] Interval error:', err);
    }
  }, 15000);
  heartbeatIntervalTimer.unref();

  // Apply pending gaps to open trades immediately at startup
  try {
    const trades = deps.getVirtualTrades();
    if (Array.isArray(trades)) {
      applyPendingGapsToOpenTrades(trades, deps.saveTradeDB);
    }
  } catch {}
}

function writeHeartbeatTick(now: number): void {
  try {
    heartbeatSeq++;
    lastHeartbeatTs = now;
    const payload: HeartbeatPayload = {
      ts: now,
      pid: process.pid,
      buildId: getBuildId(),
      processStartedAt: PROCESS_STARTED_AT,
      seq: heartbeatSeq
    };
    writeAtomicJson(HEARTBEAT_FILE, payload);
  } catch (err) {
    console.error('[HEARTBEAT] Write tick failed:', err);
  }
}

export function observeLoopTick(
  source: 'watchdog' | 'autopilot' | 'heartbeat',
  now = Date.now()
): void {
  try {
    const last = lastTickTimes[source];
    lastTickTimes[source] = now;

    if (!last) return;

    const diffMs = now - last;
    let thresholdMs = 45000;
    if (source === 'watchdog') thresholdMs = 10000;
    else if (source === 'autopilot') thresholdMs = 30000;
    else if (source === 'heartbeat') thresholdMs = 45000;

    if (diffMs > thresholdMs) {
      recordGap('FREEZE_GAP', last, now, {
        source,
        newBuildId: getBuildId()
      });
    }
  } catch {
    // Non-blocking telemetry
  }
}

export function applyPendingGapsToOpenTrades(
  trades: any[],
  saveTradeDB?: (trade: any) => Promise<any> | void
): void {
  try {
    if (!Array.isArray(trades) || trades.length === 0 || downtimeGaps.length === 0) {
      return;
    }

    const openTrades = trades.filter(t => t && t.status === 'OPEN');
    if (openTrades.length === 0) return;

    for (const gap of downtimeGaps) {
      for (const trade of openTrades) {
        const tradeOpenTime = trade.openTime || trade.createdAt || 0;
        if (tradeOpenTime <= gap.from) {
          trade.gapEvents = trade.gapEvents || [];
          const alreadyMarked = trade.gapEvents.some((e: any) => e.id === gap.id);
          if (!alreadyMarked) {
            trade.gapAffected = true;
            trade.gapFrom = typeof trade.gapFrom === 'number' ? Math.min(trade.gapFrom, gap.from) : gap.from;
            trade.gapTo = typeof trade.gapTo === 'number' ? Math.max(trade.gapTo, gap.to) : gap.to;
            trade.gapSec = (trade.gapSec || 0) + gap.durationSec;

            trade.gapEvents.push({
              id: gap.id,
              kind: gap.kind,
              from: gap.from,
              to: gap.to
            });

            if (trade.gapEvents.length > 10) {
              trade.gapEvents = trade.gapEvents.slice(-10);
            }

            for (const hook of tradeGapHooks) {
              try { hook(trade, gap); } catch {}
            }

            if (saveTradeDB) {
              try {
                saveTradeDB(trade);
              } catch (saveErr) {
                console.warn(`[HEARTBEAT] Error saving gap-marked trade ${trade.id}:`, saveErr);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[HEARTBEAT] Failed applying gaps to open trades:', err);
  }
}

export function getDowntimeSummary(): {
  process: { startedAt: number; buildId: string; uptimeSec: number };
  lastHeartbeatTs: number | null;
  entries: DowntimeGap[];
  summary: {
    gaps24h: number;
    downtimeSec24h: number;
    gaps7d: number;
    downtimeSec7d: number;
  };
} {
  const now = Date.now();
  const past24h = now - 24 * 3600 * 1000;
  const past7d = now - 7 * 24 * 3600 * 1000;

  const gaps24 = downtimeGaps.filter(g => g.to >= past24h);
  const gaps7 = downtimeGaps.filter(g => g.to >= past7d);

  const downtimeSec24h = gaps24.reduce((sum, g) => sum + (g.durationSec || 0), 0);
  const downtimeSec7d = gaps7.reduce((sum, g) => sum + (g.durationSec || 0), 0);

  const entriesRecent50 = downtimeGaps.slice(-50).reverse();

  return {
    process: {
      startedAt: PROCESS_STARTED_AT,
      buildId: getBuildId(),
      uptimeSec: Math.floor(process.uptime())
    },
    lastHeartbeatTs,
    entries: entriesRecent50,
    summary: {
      gaps24h: gaps24.length,
      downtimeSec24h,
      gaps7d: gaps7.length,
      downtimeSec7d
    }
  };
}

export function resetHeartbeatForTest(): void {
  if (heartbeatIntervalTimer) {
    clearInterval(heartbeatIntervalTimer);
    heartbeatIntervalTimer = null;
  }
  heartbeatSeq = 0;
  lastHeartbeatTs = null;
  activeDeps = null;
  downtimeGaps = [];
  gapListeners.length = 0;
  tradeGapHooks.length = 0;
  lastTickTimes.watchdog = Date.now();
  lastTickTimes.autopilot = Date.now();
  lastTickTimes.heartbeat = Date.now();
}
