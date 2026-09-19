import { describe, it, expect, beforeEach } from 'vitest';
import {
  addOtePendingCandidate,
  removeOtePendingCandidate,
  getOtePendingCandidates,
  clearOtePendingCandidates,
  processOtePendingQueue,
  OtePendingCandidate
} from './oteVirtualQueue.ts';
import { DEFAULT_OTE_TIMEOUT_MS } from './oteEntryCalculator.ts';

describe('oteVirtualQueue', () => {
  beforeEach(() => {
    clearOtePendingCandidates();
  });

  it('adds, retrieves and removes candidates correctly', () => {
    const candidate1: OtePendingCandidate = {
      id: 'c-1',
      symbol: 'BTCUSDT',
      zoneLow: 98000,
      zoneHigh: 98500,
      startedAtMs: 1000,
      context: { signalId: 'sig-1' }
    };

    const candidate2: OtePendingCandidate = {
      id: 'c-2',
      symbol: 'ETHUSDT',
      zoneLow: 3100,
      zoneHigh: 3150,
      startedAtMs: 1200
    };

    addOtePendingCandidate(candidate1);
    addOtePendingCandidate(candidate2);

    const list = getOtePendingCandidates();
    expect(list).toHaveLength(2);
    expect(list.map(c => c.id)).toEqual(['c-1', 'c-2']);

    // Проверяем, что getOtePendingCandidates возвращает копию
    list.pop();
    expect(getOtePendingCandidates()).toHaveLength(2);

    // Удаление кандидата по ID
    removeOtePendingCandidate('c-1');
    expect(getOtePendingCandidates()).toHaveLength(1);
    expect(getOtePendingCandidates()[0].id).toBe('c-2');

    // Удаление несуществующего кандидата ничего не ломает
    removeOtePendingCandidate('non-existent');
    expect(getOtePendingCandidates()).toHaveLength(1);
  });

  it('updates an existing candidate if same ID is added again', () => {
    const candidate: OtePendingCandidate = {
      id: 'c-1',
      symbol: 'BTCUSDT',
      zoneLow: 98000,
      zoneHigh: 98500,
      startedAtMs: 1000
    };

    addOtePendingCandidate(candidate);
    addOtePendingCandidate({
      ...candidate,
      zoneHigh: 99000
    });

    const candidates = getOtePendingCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].zoneHigh).toBe(99000);
  });

  it('processes filled candidate when price reaches the OTE zone', () => {
    const candidate: OtePendingCandidate = {
      id: 'cand-filled',
      symbol: 'BTCUSDT',
      zoneLow: 98000,
      zoneHigh: 98500,
      startedAtMs: 10000,
      context: { side: 'BUY' }
    };

    addOtePendingCandidate(candidate);

    const result = processOtePendingQueue(
      { BTCUSDT: 98250 },
      15000,
      DEFAULT_OTE_TIMEOUT_MS
    );

    expect(result.filled).toHaveLength(1);
    expect(result.filled[0].id).toBe('cand-filled');
    expect(result.filled[0].context).toEqual({ side: 'BUY' });
    expect(result.timedOut).toHaveLength(0);

    // Кандидат должен быть удален из очереди
    expect(getOtePendingCandidates()).toHaveLength(0);
  });

  it('processes timed out candidate when time exceeds timeoutMs', () => {
    const candidate: OtePendingCandidate = {
      id: 'cand-timeout',
      symbol: 'ETHUSDT',
      zoneLow: 3000,
      zoneHigh: 3050,
      startedAtMs: 1000
    };

    addOtePendingCandidate(candidate);

    // Цена не в зоне, но прошло >= DEFAULT_OTE_TIMEOUT_MS
    const nowMs = 1000 + DEFAULT_OTE_TIMEOUT_MS;
    const result = processOtePendingQueue(
      { ETHUSDT: 3200 },
      nowMs,
      DEFAULT_OTE_TIMEOUT_MS
    );

    expect(result.filled).toHaveLength(0);
    expect(result.timedOut).toHaveLength(1);
    expect(result.timedOut[0].id).toBe('cand-timeout');

    // Кандидат должен быть удален из очереди
    expect(getOtePendingCandidates()).toHaveLength(0);
  });

  it('keeps candidate in queue when price is outside zone and timeout is not reached', () => {
    const candidate: OtePendingCandidate = {
      id: 'cand-waiting',
      symbol: 'SOLUSDT',
      zoneLow: 180,
      zoneHigh: 185,
      startedAtMs: 10000
    };

    addOtePendingCandidate(candidate);

    const result = processOtePendingQueue(
      { SOLUSDT: 195 },
      15000,
      DEFAULT_OTE_TIMEOUT_MS
    );

    expect(result.filled).toHaveLength(0);
    expect(result.timedOut).toHaveLength(0);

    // Кандидат остается в очереди
    const remaining = getOtePendingCandidates();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('cand-waiting');
  });

  it('handles multiple candidates simultaneously with different outcomes', () => {
    const cand1: OtePendingCandidate = {
      id: 'c-filled',
      symbol: 'BTCUSDT',
      zoneLow: 98000,
      zoneHigh: 98500,
      startedAtMs: 1000
    };

    const cand2: OtePendingCandidate = {
      id: 'c-timedout',
      symbol: 'ETHUSDT',
      zoneLow: 3000,
      zoneHigh: 3050,
      startedAtMs: 1000
    };

    const cand3: OtePendingCandidate = {
      id: 'c-waiting',
      symbol: 'SOLUSDT',
      zoneLow: 180,
      zoneHigh: 185,
      startedAtMs: 50000
    };

    addOtePendingCandidate(cand1);
    addOtePendingCandidate(cand2);
    addOtePendingCandidate(cand3);

    const currentPrices = {
      BTCUSDT: 98100, // попадает в зону [98000, 98500] -> filled
      ETHUSDT: 3200,  // не в зоне, но startedAtMs 1000 при nowMs 200000 и timeout 180000 -> timed out
      SOLUSDT: 190   // не в зоне [180, 185], и startedAtMs 50000 (прошло 150000 < 180000) -> waiting
    };

    const nowMs = 200000;
    const result = processOtePendingQueue(currentPrices, nowMs, 180000);

    expect(result.filled.map(c => c.id)).toEqual(['c-filled']);
    expect(result.timedOut.map(c => c.id)).toEqual(['c-timedout']);

    // Только c-waiting должен остаться в очереди
    const remaining = getOtePendingCandidates();
    expect(remaining.map(c => c.id)).toEqual(['c-waiting']);
  });

  it('does not return already processed candidates on subsequent processOtePendingQueue calls', () => {
    const candidate: OtePendingCandidate = {
      id: 'c-single',
      symbol: 'BTCUSDT',
      zoneLow: 100,
      zoneHigh: 105,
      startedAtMs: 1000
    };

    addOtePendingCandidate(candidate);

    const firstRun = processOtePendingQueue({ BTCUSDT: 102 }, 2000);
    expect(firstRun.filled).toHaveLength(1);

    const secondRun = processOtePendingQueue({ BTCUSDT: 102 }, 3000);
    expect(secondRun.filled).toHaveLength(0);
    expect(secondRun.timedOut).toHaveLength(0);
    expect(getOtePendingCandidates()).toHaveLength(0);
  });

  it('handles candidate when price for its symbol is missing in currentPrices', () => {
    const candNotExpired: OtePendingCandidate = {
      id: 'c-no-price-waiting',
      symbol: 'AVAXUSDT',
      zoneLow: 25,
      zoneHigh: 27,
      startedAtMs: 50000
    };

    const candExpired: OtePendingCandidate = {
      id: 'c-no-price-timeout',
      symbol: 'DOTUSDT',
      zoneLow: 5,
      zoneHigh: 6,
      startedAtMs: 1000
    };

    addOtePendingCandidate(candNotExpired);
    addOtePendingCandidate(candExpired);

    // currentPrices не содержит ни AVAXUSDT, ни DOTUSDT
    const result = processOtePendingQueue({}, 200000, 180000);

    expect(result.filled).toHaveLength(0);
    expect(result.timedOut.map(c => c.id)).toEqual(['c-no-price-timeout']);

    const remaining = getOtePendingCandidates();
    expect(remaining.map(c => c.id)).toEqual(['c-no-price-waiting']);
  });

  it('prioritizes filled over timeout if price reached zone even at/after timeout threshold', () => {
    const candidate: OtePendingCandidate = {
      id: 'c-boundary',
      symbol: 'BTCUSDT',
      zoneLow: 100,
      zoneHigh: 110,
      startedAtMs: 0
    };

    addOtePendingCandidate(candidate);

    // Время вышло, но цена в этот же момент находится в зоне
    const result = processOtePendingQueue(
      { BTCUSDT: 105 },
      200000,
      180000
    );

    // Согласно правилу 1: если цена в зоне, идет в filled
    expect(result.filled).toHaveLength(1);
    expect(result.filled[0].id).toBe('c-boundary');
    expect(result.timedOut).toHaveLength(0);
  });
});
