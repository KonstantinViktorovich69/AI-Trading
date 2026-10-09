import { incFunnel } from './funnelCounters.ts';

interface LoopLock {
  token: number;
  startedAt: number;
}

const activeLocks = new Map<string, LoopLock>();
let nextToken = 1;

/**
 * Runs a background loop function with overlap protection and timeout recovery.
 *
 * - If loopGuardEnabled is false, immediately calls fn().
 * - If previous execution is running and elapsed < maxRunMs, skips execution and logs overlap.
 * - If previous execution is running for >= maxRunMs, forcibly releases lock and starts new execution.
 */
export async function runGuarded<T>(
  name: string,
  maxRunMs: number,
  fn: () => Promise<T>,
  options?: { loopGuardEnabled?: boolean }
): Promise<T | void> {
  const enabled = options?.loopGuardEnabled !== false;
  if (!enabled) {
    return fn();
  }

  const now = Date.now();
  const existing = activeLocks.get(name);

  if (existing) {
    const elapsed = now - existing.startedAt;
    if (elapsed < maxRunMs) {
      try {
        incFunnel('loop', `${name}_skipped_overlap`);
      } catch {}
      return;
    }

    // Force release lock after timeout
    console.error(`[LOOP GUARD] Forced release on hung loop "${name}" after ${elapsed}ms (max: ${maxRunMs}ms)`);
    try {
      incFunnel('loop', `${name}_forced_release`);
    } catch {}
    activeLocks.delete(name);
  }

  const token = nextToken++;
  activeLocks.set(name, { token, startedAt: Date.now() });

  try {
    return await fn();
  } finally {
    // Only the lock owner (matching token) can clear the lock
    const current = activeLocks.get(name);
    if (current && current.token === token) {
      activeLocks.delete(name);
    }
  }
}

/**
 * Resets lock state (for tests)
 */
export function resetLoopGuardStateForTest(): void {
  activeLocks.clear();
}
