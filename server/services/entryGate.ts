import { registerGapListener } from './heartbeatService.ts';
import { PROCESS_STARTED_AT } from './buildInfo.ts';

export interface EntryGateDeps {
  getGlobalTrueOhlcv?: () => Record<string, any>;
  getGlobalSettings?: () => any;
}

export interface EntryGateStatus {
  paused: boolean;
  reason?: string;
  remainingSec?: number;
}

let pausedUntilTs = 0;
let pauseReason = '';

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

// Subscribe to downtime gap listener: any gap >= 60s pauses entries for 120s
try {
  registerGapListener((gap: { from: number; to: number; durationSec: number }) => {
    if (gap && gap.durationSec >= 60) {
      pauseEntries(120, 'gap');
    }
  });
} catch (err) {
  console.warn('[ENTRY GATE] Failed registering gap listener:', err);
}

/**
 * Checks whether entry gate is paused.
 * Rules:
 * 1. Process startup grace period: < entryPauseAfterStartSec (default 120; 0 = off).
 * 2. Warmup check: < 3 symbols in getGlobalTrueOhlcv(), while < 300s since start. After 300s warmup pause forced release.
 * 3. now < pausedUntilTs.
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

  return { paused: false };
}

/**
 * Reset state for unit tests
 */
export function resetEntryGateForTest(): void {
  pausedUntilTs = 0;
  pauseReason = '';
}
