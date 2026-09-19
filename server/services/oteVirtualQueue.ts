/**
 * @file oteVirtualQueue.ts
 * Очередь ожидающих OTE-кандидатов для виртуальных сделок в памяти (без персистентности в БД).
 * Модуль хранит кандидатов в оперативной памяти и предоставляет методы для добавления,
 * удаления, очистки и процессинга очереди на основе текущих рыночных цен и таймаутов.
 */

import {
  DEFAULT_OTE_TIMEOUT_MS,
  hasOteEntryTimedOut,
  hasPriceReachedOteZone
} from './oteEntryCalculator.ts';

export interface OtePendingCandidate {
  id: string;             // уникальный идентификатор, генерируется вызывающим кодом (не этим модулем)
  symbol: string;
  zoneLow: number;
  zoneHigh: number;
  startedAtMs: number;
  context?: any;          // произвольные данные, нужные вызывающему коду позже для открытия сделки —
                          // этот модуль их не читает и не интерпретирует, только хранит и возвращает
}

// Модульное состояние в памяти процесса
let pendingQueue: OtePendingCandidate[] = [];

/**
 * Добавляет кандидата в очередь. Если кандидат с таким id уже присутствует, обновляет его.
 */
export function addOtePendingCandidate(candidate: OtePendingCandidate): void {
  const existingIdx = pendingQueue.findIndex(c => c.id === candidate.id);
  if (existingIdx >= 0) {
    pendingQueue[existingIdx] = candidate;
  } else {
    pendingQueue.push(candidate);
  }
}

/**
 * Удаляет кандидата по id, если он есть (если нет — ничего не делает, не бросает ошибку).
 */
export function removeOtePendingCandidate(id: string): void {
  pendingQueue = pendingQueue.filter(c => c.id !== id);
}

/**
 * Возвращает поверхностную копию текущего списка ожидающих кандидатов.
 */
export function getOtePendingCandidates(): OtePendingCandidate[] {
  return pendingQueue.map(candidate => ({ ...candidate }));
}

/**
 * Полностью очищает очередь в памяти.
 */
export function clearOtePendingCandidates(): void {
  pendingQueue = [];
}

/**
 * Обрабатывает очередь кандидатов на основе текущих цен и времени:
 * - Кандидаты, цена которых достигла зоны OTE, попадают в filled.
 * - Кандидаты, превысившие таймаут ожидания, попадают в timedOut.
 * - Оставшиеся кандидаты продолжают ожидать в очереди.
 * - Кандидаты из filled и timedOut удаляются из очереди.
 */
export function processOtePendingQueue(
  currentPrices: Record<string, number>,
  nowMs: number = Date.now(),
  timeoutMs: number = DEFAULT_OTE_TIMEOUT_MS
): { filled: OtePendingCandidate[]; timedOut: OtePendingCandidate[] } {
  const filled: OtePendingCandidate[] = [];
  const timedOut: OtePendingCandidate[] = [];
  const remaining: OtePendingCandidate[] = [];

  for (const candidate of pendingQueue) {
    const currentPrice = currentPrices[candidate.symbol];
    const isPriceValidNumber = typeof currentPrice === 'number' && Number.isFinite(currentPrice);

    if (isPriceValidNumber && hasPriceReachedOteZone(currentPrice, candidate.zoneLow, candidate.zoneHigh)) {
      filled.push(candidate);
    } else if (hasOteEntryTimedOut(candidate.startedAtMs, nowMs, timeoutMs)) {
      timedOut.push(candidate);
    } else {
      remaining.push(candidate);
    }
  }

  pendingQueue = remaining;

  return { filled, timedOut };
}
