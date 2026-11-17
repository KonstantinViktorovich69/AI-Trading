import { registerGapListener } from './heartbeatService.ts';
import { PROCESS_STARTED_AT } from './buildInfo.ts';

export interface EntryGateDeps {
  getGlobalTrueOhlcv?: () => Record<string, any>;
  getGlobalSettings?: () => any;
  getGlobalCcxtTickers?: () => Record<string, any>;
  getTickerTimestamp?: () => number | undefined;
  getBtcOhlcvTimestamp?: () => number | undefined;
  getApiHealth?: () => Record<string, any>;
  silent?: boolean;
}

export interface EntryGateStatus {
  paused: boolean;
  reason?: string;
  remainingSec?: number;
}

let pausedUntilTs = 0;
let pauseReason = '';
let lastStaleLogTs = 0;
const BTC_AGE_WINDOW_MS = 10 * 60 * 1000;
const btcAgeSamples: Array<{ ts: number; ageSec: number }> = [];

export function recordBtcOhlcvAgeSample(ageSec: number | null | undefined, nowTs = Date.now()): void {
  if (typeof ageSec !== 'number' || !Number.isFinite(ageSec) || ageSec < 0) return;
  const cutoff = nowTs - BTC_AGE_WINDOW_MS;
  while (btcAgeSamples.length > 0 && btcAgeSamples[0].ts < cutoff) {
    btcAgeSamples.shift();
  }
  btcAgeSamples.push({ ts: nowTs, ageSec });
}

export function getBtcOhlcvAgeMax10mSec(nowTs = Date.now()): number | null {
  const cutoff = nowTs - BTC_AGE_WINDOW_MS;
  while (btcAgeSamples.length > 0 && btcAgeSamples[0].ts < cutoff) {
    btcAgeSamples.shift();
  }
  if (btcAgeSamples.length === 0) return null;
  let maxAge = btcAgeSamples[0].ageSec;
  for (let i = 1; i < btcAgeSamples.length; i++) {
    if (btcAgeSamples[i].ageSec > maxAge) maxAge = btcAgeSamples[i].ageSec;
  }
  return maxAge;
}

/**
 * Manually or programmatically pause new entries for `sec` seconds.
 */
export function pauseEntries(sec: number, reason: string, fromTs?: number): void {
  const baseTs = fromTs || Date.now();
  const targetTs = baseTs + sec * 1000;
  if (targetTs > pausedUntilTs) {
    pausedUntilTs = targetTs;
    pauseReason = reason || 'manual_pause';
  }
}

// Subscribe to downtime gap listener: RESTART_GAP, RESTART_GAP_ESTIMATED, FREEZE_GAP >= 60s pauses entries for 120s (STALE_FEED does not pause entries)
try {
  registerGapListener((gap: { kind?: string; from: number; to: number; durationSec: number }) => {
    if (
      gap &&
      gap.durationSec >= 60 &&
      (gap.kind === 'RESTART_GAP' || gap.kind === 'RESTART_GAP_ESTIMATED' || gap.kind === 'FREEZE_GAP')
    ) {
      pauseEntries(120, 'gap');
    }
  });
} catch (err) {
  console.warn('[ENTRY GATE] Failed registering gap listener:', err);
}

export function resolveTickerTimestamp(deps?: EntryGateDeps): number | undefined {
  if (!deps) return undefined;
  if (typeof deps.getTickerTimestamp === 'function') {
    const ts = deps.getTickerTimestamp();
    if (typeof ts === 'number' && ts > 0) return ts;
  }
  const health = deps.getApiHealth ? deps.getApiHealth() : undefined;
  const syncTs = health?.weex?.lastSuccessfulSyncAt;
  if (typeof syncTs === 'number' && syncTs > 0) return syncTs;

  const tickersMap = deps.getGlobalCcxtTickers ? deps.getGlobalCcxtTickers()?.weex : undefined;
  if (tickersMap && typeof tickersMap === 'object') {
    const btcTs = tickersMap['BTC/USDT:USDT']?.timestamp || tickersMap['BTC/USDT']?.timestamp;
    if (typeof btcTs === 'number' && btcTs > 0) return btcTs;
    let maxTs = 0;
    let inspected = 0;
    for (const val of Object.values<any>(tickersMap)) {
      if (val && typeof val.timestamp === 'number' && val.timestamp > maxTs) {
        maxTs = val.timestamp;
      }
      inspected++;
      if (inspected >= 15) break;
    }
    if (maxTs > 0) return maxTs;
  }
  return undefined;
}

export function resolveBtcOhlcvTimestamp(deps?: EntryGateDeps): number | undefined {
  if (!deps) return undefined;
  if (typeof deps.getBtcOhlcvTimestamp === 'function') {
    const ts = deps.getBtcOhlcvTimestamp();
    if (typeof ts === 'number' && ts > 0) return ts;
  }
  const trueOhlcv = deps.getGlobalTrueOhlcv ? deps.getGlobalTrueOhlcv() : undefined;
  if (trueOhlcv && typeof trueOhlcv === 'object') {
    const btcEntry = trueOhlcv['BTCUSDT'] || trueOhlcv['BTC/USDT'] || trueOhlcv['BTC/USDT:USDT'];
    if (btcEntry && typeof btcEntry.updatedAt === 'number' && btcEntry.updatedAt > 0) {
      return btcEntry.updatedAt;
    }
  }
  return undefined;
}

export function getMarketDataFreshness(nowTs?: number, deps?: EntryGateDeps): {
  tickerTimestamp: number | null;
  tickerAgeSec: number | null;
  btcOhlcvTimestamp: number | null;
  btcOhlcvAgeSec: number | null;
  btcOhlcvAgeMax10mSec: number | null;
} {
  const now = nowTs || Date.now();
  const tickerTs = resolveTickerTimestamp(deps);
  const btcOhlcvTs = resolveBtcOhlcvTimestamp(deps);
  const btcOhlcvAgeSec = typeof btcOhlcvTs === 'number' && btcOhlcvTs > 0 ? Math.max(0, Math.round((now - btcOhlcvTs) / 1000)) : null;
  if (btcOhlcvAgeSec !== null) {
    recordBtcOhlcvAgeSample(btcOhlcvAgeSec, now);
  }
  return {
    tickerTimestamp: tickerTs ?? null,
    tickerAgeSec: typeof tickerTs === 'number' && tickerTs > 0 ? Math.max(0, Math.round((now - tickerTs) / 1000)) : null,
    btcOhlcvTimestamp: btcOhlcvTs ?? null,
    btcOhlcvAgeSec,
    btcOhlcvAgeMax10mSec: getBtcOhlcvAgeMax10mSec(now)
  };
}

/**
 * Checks whether entry gate is paused.
 * Rules:
 * 1. Process startup grace period: < entryPauseAfterStartSec (default 120; 0 = off).
 * 2. Warmup check: < 3 symbols in getGlobalTrueOhlcv(), while < 300s since start. After 300s warmup pause forced release.
 * 3. now < pausedUntilTs.
 * 4. T7.5 Stale data check: ticker age or BTC OHLCV age > staleDataPauseSec (default 300s).
 */
export function isEntryPaused(nowTs?: number, deps?: EntryGateDeps): EntryGateStatus {
  const now = nowTs || Date.now();
  const settings = deps?.getGlobalSettings ? deps.getGlobalSettings() : {};
  // In unit test environment (process.env.NODE_ENV === 'test' or VITEST), default entryPauseAfterStartSec is 0 unless explicitly configured
  const isTest = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined);
  const defaultPauseSec = isTest ? 0 : 120;
  const entryPauseAfterStartSec = (settings as any)?.entryPauseAfterStartSec ?? defaultPauseSec;

  // 1. Check startup grace period
  const elapsedFromStartSec = Math.floor((now - PROCESS_STARTED_AT) / 1000);
  if (entryPauseAfterStartSec > 0 && elapsedFromStartSec < entryPauseAfterStartSec) {
    const remainingSec = entryPauseAfterStartSec - elapsedFromStartSec;
    return {
      paused: true,
      reason: 'startup_cooldown',
      remainingSec
    };
  }

  // 2. Check warmup of OHLCV (symbols count < 3) until 300s (only if startup check is active and getGlobalTrueOhlcv is provided)
  if (entryPauseAfterStartSec > 0 && elapsedFromStartSec < 300 && deps?.getGlobalTrueOhlcv) {
    try {
      const ohlcv = deps.getGlobalTrueOhlcv();
      const symbolCount = ohlcv && typeof ohlcv === 'object' ? Object.keys(ohlcv).length : 0;
      if (symbolCount < 3) {
        return {
          paused: true,
          reason: 'ohlcv_warmup',
          remainingSec: 300 - elapsedFromStartSec
        };
      }
    } catch {}
  }

  // 3. Check pausedUntilTs
  if (now < pausedUntilTs) {
    const remainingSec = Math.ceil((pausedUntilTs - now) / 1000);
    return {
      paused: true,
      reason: pauseReason || 'gap',
      remainingSec
    };
  }

  // 4. T7.5: Pause new entries when ticker or BTC OHLCV data exceeds staleDataPauseSec
  const staleDataPauseSec = typeof (settings as any)?.staleDataPauseSec === 'number'
    ? (settings as any).staleDataPauseSec
    : 300;
  if (staleDataPauseSec > 0) {
    const thresholdMs = staleDataPauseSec * 1000;
    const tickerTs = resolveTickerTimestamp(deps);
    if (typeof tickerTs === 'number' && tickerTs > 0 && (now - tickerTs) > thresholdMs) {
      const ageSec = Math.round((now - tickerTs) / 1000);
      if (!deps?.silent && (now - lastStaleLogTs > 60000)) {
        lastStaleLogTs = now;
        console.warn(`[ENTRY GATE] Pausing entries: tickers age ${ageSec}s > ${staleDataPauseSec}s`);
      }
      return {
        paused: true,
        reason: `stale_data_tickers (${ageSec}s > ${staleDataPauseSec}s)`
      };
    }

    const btcOhlcvTs = resolveBtcOhlcvTimestamp(deps);
    if (typeof btcOhlcvTs === 'number' && btcOhlcvTs > 0) {
      const ageSec = Math.max(0, Math.round((now - btcOhlcvTs) / 1000));
      recordBtcOhlcvAgeSample(ageSec, now);
      if ((now - btcOhlcvTs) > thresholdMs) {
        if (!deps?.silent && (now - lastStaleLogTs > 60000)) {
          lastStaleLogTs = now;
          console.warn(`[ENTRY GATE] Pausing entries: BTC OHLCV age ${ageSec}s > ${staleDataPauseSec}s`);
        }
        return {
          paused: true,
          reason: `stale_data_btc_ohlcv (${ageSec}s > ${staleDataPauseSec}s)`
        };
      }
    }
  }

  return { paused: false };
}

/**
 * Reset state for unit tests
 */
export function resetEntryGateForTest(): void {
  pausedUntilTs = 0;
  pauseReason = '';
  lastStaleLogTs = 0;
  btcAgeSamples.length = 0;
}
