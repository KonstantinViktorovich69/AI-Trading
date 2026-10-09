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

// In-memory runtime state (does not store heavy candles in trade objects)
const candlesCache = new Map<string, any[][]>();
const inFlightFetches = new Set<string>();
const fetchStartTime = new Map<string, number>();

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

  if (!fetchStartTime.has(tradeId)) {
    fetchStartTime.set(tradeId, now);
  }

  const elapsedFromFirst = now - (fetchStartTime.get(tradeId) || now);
  const attempts = trade.gapReplayAttempts || 0;

  // Check 120s timeout or > 3 attempts -> FALLBACK_LIVE
  if (elapsedFromFirst >= 120000 || attempts >= 3) {
    trade.gapReplayStatus = 'FALLBACK_LIVE';
    inFlightFetches.delete(tradeId);
    return { kind: 'FALLBACK_LIVE' };
  }

  // Check if candles are already loaded
  if (candlesCache.has(tradeId)) {
    const candles = candlesCache.get(tradeId)!;
    const gapMs = Math.max(0, now - (trade.gapReplayFrom || trade.openTime || now));
    const tfMs = gapMs <= 6 * 60 * 60 * 1000 ? 60 * 1000 : 5 * 60 * 1000;
    const outcome = replayGapOnCandles(trade, candles, tfMs, exitCfg, now);
    trade.gapReplayStatus = 'DONE';
    inFlightFetches.delete(tradeId);
    return { kind: 'READY', outcome };
  }

  // If already in flight, wait
  if (inFlightFetches.has(tradeId)) {
    return { kind: 'WAIT' };
  }

  // Start background fetch WITHOUT await
  inFlightFetches.add(tradeId);
  trade.gapReplayAttempts = attempts + 1;

  const fetcher = customFetchGapCandles || fetchGapCandles;
  const fromTs = trade.gapReplayFrom || trade.openTime || (now - 60000);

  fetcher(exchange, trade.symbol, fromTs, now)
    .then((res: GapCandleResult) => {
      inFlightFetches.delete(tradeId);
      if (res.ok && Array.isArray(res.candles) && res.candles.length > 0) {
        candlesCache.set(tradeId, res.candles);
      } else if (res.reason === 'GAP_TOO_LONG' || res.reason === 'NO_CANDLES_FETCHED') {
        trade.gapReplayStatus = res.reason === 'NO_CANDLES_FETCHED' ? 'NO_CANDLES' : 'FAILED';
      }
    })
    .catch(() => {
      inFlightFetches.delete(tradeId);
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
}
