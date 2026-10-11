import { fetchGapCandles, type GapCandleResult } from './gapCandleFetcher.ts';
import { replayGapOnCandles, type GapReplayResult } from './gapReplay.ts';
import { registerTradeGapHook } from './heartbeatService.ts';
import type { ExitPolicySettings } from './exitPolicy.ts';

export type GapReplayStatus = 'PENDING' | 'DONE' | 'FAILED' | 'NO_CANDLES' | 'FALLBACK_LIVE';

export type AdvanceResultKind = 'WAIT' | 'FALLBACK_LIVE' | 'READY';

export interface AdvanceResult {
  kind: AdvanceResultKind;
  outcome?: GapReplayResult;
}

// In-memory runtime state: keyed by pair `${trade.id}_${gapReplayFrom}`
const candlesCache = new Map<string, any[][]>();
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
    return { kind: 'FALLBACK_LIVE' };
  }

  // Check if candles are already loaded
  if (candlesCache.has(pairKey)) {
    const candles = candlesCache.get(pairKey)!;
    const gapMs = Math.max(0, now - fromTs);
    const tfMs = gapMs <= 6 * 60 * 60 * 1000 ? 60 * 1000 : 5 * 60 * 1000;
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
        candlesCache.set(pairKey, res.candles);
      } else if (res.reason === 'GAP_TOO_LONG' || res.reason === 'NO_CANDLES_FETCHED') {
        trade.gapReplayStatus = res.reason === 'NO_CANDLES_FETCHED' ? 'NO_CANDLES' : 'FAILED';
      }
    })
    .catch(() => {
      inFlightFetches.delete(pairKey);
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
