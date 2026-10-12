import { fetchGapCandles, type GapCandleResult } from './gapCandleFetcher.ts';
import { replayGapOnCandles, type GapReplayResult } from './gapReplay.ts';
import { registerTradeGapHook } from './heartbeatService.ts';
import type { ExitPolicySettings } from './exitPolicy.ts';
import { incFunnel } from './funnelCounters.ts';

export type GapReplayStatus = 'PENDING' | 'DONE' | 'FAILED' | 'NO_CANDLES' | 'FALLBACK_LIVE';

export type AdvanceResultKind = 'WAIT' | 'FALLBACK_LIVE' | 'READY';

export interface AdvanceResult {
  kind: AdvanceResultKind;
  outcome?: GapReplayResult;
}

interface CachedCandleEntry {
  candles: any[][];
  timeframe?: string;
  complete?: boolean;
}

// In-memory runtime state: keyed by pair `${trade.id}_${gapReplayFrom}`
const candlesCache = new Map<string, CachedCandleEntry>();
const inFlightFetches = new Set<string>();
const fetchStartTime = new Map<string, number>();
const lastFetchAttemptTime = new Map<string, number>();

function getReplayPairKey(tradeId: string, fromTs: number): string {
  return `${tradeId}_${fromTs}`;
}

/**
 * Initializes the hook on trade gap detection.
 * Subscribes to registerTradeGapHook:
 * for OPEN trades where !trade.isReal, sets trade.gapReplayStatus = 'PENDING'
 * and updates trade.gapReplayFrom.
 */
export function initGapReplayRuntime(): void {
  registerTradeGapHook((trade: any, gap: { from: number; to: number; durationSec: number }) => {
    if (!trade || trade.status !== 'OPEN' || trade.isReal) {
      return;
    }
    const currentStatus = trade.gapReplayStatus;
    if (currentStatus === 'PENDING') {
      trade.gapReplayFrom = Math.min(trade.gapReplayFrom || gap.from, gap.from);
    } else {
      trade.gapReplayFrom = gap.from;
      trade.gapReplayStatus = 'PENDING';
      trade.gapReplayAttempts = 0;
    }
  });
}

// Automatically register hook when module is imported
try {
  initGapReplayRuntime();
} catch (err) {
  console.warn('[GAP REPLAY RUNTIME] Hook registration failed:', err);
}

/**
 * Advances the replay state machine for a trade during watchdog execution.
 * Non-blocking: background candle fetch without await inside watchdog.
 */
export function advanceGapReplay(
  trade: any,
  exchange: any,
  exitCfg: ExitPolicySettings,
  nowTs: number,
  customFetchGapCandles?: (exchange: any, symbol: string, fromTs: number, toTs: number) => Promise<GapCandleResult>
): AdvanceResult {
  const tradeId = String(trade.id);
  const now = nowTs || Date.now();
  const fromTs = trade.gapReplayFrom || trade.openTime || (now - 60000);
  const pairKey = getReplayPairKey(tradeId, fromTs);

  if (!fetchStartTime.has(pairKey)) {
    fetchStartTime.set(pairKey, now);
  }

  const elapsedFromFirst = now - (fetchStartTime.get(pairKey) || now);
  const attempts = trade.gapReplayAttempts || 0;

  // Check 120s timeout or > 3 attempts -> FALLBACK_LIVE
  if (elapsedFromFirst >= 120000 || attempts >= 3) {
    trade.gapReplayStatus = 'FALLBACK_LIVE';
    inFlightFetches.delete(pairKey);
    candlesCache.delete(pairKey);
    fetchStartTime.delete(pairKey);
    lastFetchAttemptTime.delete(pairKey);
    trade.gapReplayAttempts = 0;
    try {
      incFunnel('gap_replay', 'fallback_live', trade.symbol);
    } catch {}
    return { kind: 'FALLBACK_LIVE' };
  }

  // Check if candles are already loaded
  if (candlesCache.has(pairKey)) {
    const cached = candlesCache.get(pairKey)!;
    const candles = cached.candles;
    const tfMs = cached.timeframe === '15m' ? 15 * 60 * 1000 : cached.timeframe === '5m' ? 5 * 60 * 1000 : 60 * 1000;
    if (cached.complete === false) {
      trade.gapReplayIncomplete = true;
      try {
        incFunnel('gap_replay', 'incomplete', trade.symbol);
      } catch {}
    } else {
      try {
        incFunnel('gap_replay', 'done', trade.symbol);
      } catch {}
    }
    const outcome = replayGapOnCandles(trade, candles, tfMs, exitCfg, now);
    trade.gapReplayStatus = 'DONE';
    inFlightFetches.delete(pairKey);
    candlesCache.delete(pairKey);
    fetchStartTime.delete(pairKey);
    lastFetchAttemptTime.delete(pairKey);
    trade.gapReplayAttempts = 0;
    return { kind: 'READY', outcome };
  }

  // If already in flight, wait
  if (inFlightFetches.has(pairKey)) {
    return { kind: 'WAIT' };
  }

  // Retry cooldown check: do not retry failed fetch sooner than 15s
  const lastAttempt = lastFetchAttemptTime.get(pairKey) || 0;
  if (lastAttempt > 0 && (now - lastAttempt < 15000)) {
    return { kind: 'WAIT' };
  }

  // Start background fetch WITHOUT await
  inFlightFetches.add(pairKey);
  lastFetchAttemptTime.set(pairKey, now);
  trade.gapReplayAttempts = attempts + 1;

  const fetcher = customFetchGapCandles || fetchGapCandles;

  fetcher(exchange, trade.symbol, fromTs, now)
    .then((res: GapCandleResult) => {
      inFlightFetches.delete(pairKey);
      if (res.ok && Array.isArray(res.candles) && res.candles.length > 0) {
        candlesCache.set(pairKey, {
          candles: res.candles,
          timeframe: res.timeframe,
          complete: res.complete
        });
      } else if (res.reason === 'GAP_TOO_LONG') {
        trade.gapReplayStatus = 'FAILED';
        trade.gapReplayLastError = 'GAP_TOO_LONG';
        candlesCache.delete(pairKey);
        fetchStartTime.delete(pairKey);
        lastFetchAttemptTime.delete(pairKey);
      } else if (res.reason === 'FETCH_ERROR') {
        // Trade stays PENDING for retry!
        const errText = (res.error || 'FETCH_ERROR').slice(0, 200);
        trade.gapReplayLastError = errText;
        try {
          incFunnel('gap_replay', 'fetch_error', trade.symbol);
        } catch {}
      } else if (res.reason === 'NO_CANDLES_FETCHED' || (res.ok && (!res.candles || res.candles.length === 0))) {
        // Trade stays PENDING for retry!
        const errText = 'NO_CANDLES_FETCHED'.slice(0, 200);
        trade.gapReplayLastError = errText;
        try {
          incFunnel('gap_replay', 'no_candles', trade.symbol);
        } catch {}
      } else if (res.reason) {
        trade.gapReplayLastError = String(res.reason).slice(0, 200);
      }
    })
    .catch((err: any) => {
      inFlightFetches.delete(pairKey);
      const errMsg = (err?.message || String(err) || 'FETCH_ERROR').slice(0, 200);
      trade.gapReplayLastError = errMsg;
      try {
        incFunnel('gap_replay', 'fetch_error', trade.symbol);
      } catch {}
    });

  return { kind: 'WAIT' };
}

/**
 * Resets memory state (useful for tests)
 */
export function resetGapReplayRuntimeState(): void {
  candlesCache.clear();
  inFlightFetches.clear();
  fetchStartTime.clear();
  lastFetchAttemptTime.clear();
}
