/**
 * @file oteEntryCalculator.ts
 * Чистые расчетные функции для Optimal Trade Entry (OTE).
 * Модуль изолирован, не содержит побочных эффектов, сетевых вызовов или работы с БД.
 */

/**
 * Нижний коэффициент коррекции по Фибоначчи для зоны OTE (50% отката импульса).
 */
export const OTE_ZONE_LOW_RATIO = 0.50;

/**
 * Верхний коэффициент коррекции по Фибоначчи для зоны OTE (золотое сечение 61.8% отката импульса).
 */
export const OTE_ZONE_HIGH_RATIO = 0.618;

/**
 * Минимальный относительный размер импульса как доля от цены (0.1%),
 * ниже которого движение признается вырожденным / микрошумом и зона считается невалидной.
 */
export const MIN_IMPULSE_RATIO = 0.001;

/**
 * Стандартный таймаут ожидания отката цены в зону OTE в миллисекундах (3 минуты = 180 000 мс).
 */
export const DEFAULT_OTE_TIMEOUT_MS = 180000;

export interface OteEntryZoneParams {
  isSellSignal: boolean;
  price: number;          // текущая цена на момент сигнала = точка B
  localLow5m: number;     // экстремум свипа для LONG = точка A
  localHigh5m: number;    // экстремум свипа для SHORT = точка A
}

export interface OteEntryZoneResult {
  targetPrice: number;
  zoneLow: number;
  zoneHigh: number;
  isValid: boolean;
}

/**
 * Рассчитывает целевую зону входа Optimal Trade Entry (OTE) и среднюю цену входа.
 * 
 * Логика:
 * - LONG (isSellSignal = false): импульс от localLow5m (точка A) вверх до price (точка B).
 *   Зона отката формируется в диапазоне [50%, 61.8%] импульса от точки A.
 * - SHORT (isSellSignal = true): импульс от localHigh5m (точка A) вниз до price (точка B).
 *   Зона отката формируется в диапазоне [50%, 61.8%] импульса от точки A.
 * В обоих случаях zoneLow < zoneHigh как числовые значения.
 */
export function calculateOteEntryZone(params: {
  isSellSignal: boolean;
  price: number;
  localLow5m: number;
  localHigh5m: number;
}): { targetPrice: number; zoneLow: number; zoneHigh: number; isValid: boolean } {
  const { isSellSignal, price, localLow5m, localHigh5m } = params;

  if (!isFinite(price) || price <= 0) {
    return {
      targetPrice: 0,
      zoneLow: 0,
      zoneHigh: 0,
      isValid: false
    };
  }

  let pointA: number;
  let pointB: number;
  let impulse: number;

  if (isSellSignal) {
    // SHORT: точка A = максимум свипа, точка B = текущая цена после пролива
    pointA = localHigh5m;
    pointB = price;
    impulse = pointA - pointB;
  } else {
    // LONG: точка A = минимум свипа, точка B = текущая цена после отскока
    pointA = localLow5m;
    pointB = price;
    impulse = pointB - pointA;
  }

  // Проверка на вырожденный или недостаточный импульс (< 0.1% от цены)
  if (impulse <= 0 || (impulse / price) < MIN_IMPULSE_RATIO) {
    const fallbackPrice = Number(price.toFixed(5));
    return {
      targetPrice: fallbackPrice,
      zoneLow: fallbackPrice,
      zoneHigh: fallbackPrice,
      isValid: false
    };
  }

  let zoneLow: number;
  let zoneHigh: number;

  if (isSellSignal) {
    // Для SHORT откат вверх от точки B к точке A:
    // 50% отката: pointA - impulse * 0.50
    // 61.8% отката: pointA - impulse * 0.618
    // Поскольку 0.50 < 0.618, pointA - impulse * 0.618 < pointA - impulse * 0.50
    zoneHigh = pointA - impulse * OTE_ZONE_LOW_RATIO;
    zoneLow = pointA - impulse * OTE_ZONE_HIGH_RATIO;
  } else {
    // Для LONG откат вниз от точки B к точке A:
    // 50% отката: pointA + impulse * 0.50
    // 61.8% отката: pointA + impulse * 0.618
    zoneLow = pointA + impulse * OTE_ZONE_LOW_RATIO;
    zoneHigh = pointA + impulse * OTE_ZONE_HIGH_RATIO;
  }

  const targetPrice = (zoneLow + zoneHigh) / 2;

  return {
    targetPrice: Number(targetPrice.toFixed(5)),
    zoneLow: Number(zoneLow.toFixed(5)),
    zoneHigh: Number(zoneHigh.toFixed(5)),
    isValid: true
  };
}

/**
 * Проверяет, находится ли текущая цена внутри диапазона OTE [zoneLow, zoneHigh] включительно.
 */
export function hasPriceReachedOteZone(
  currentPrice: number,
  zoneLow: number,
  zoneHigh: number
): boolean {
  return currentPrice >= zoneLow && currentPrice <= zoneHigh;
}

/**
 * Проверяет, истек ли лимит времени ожидания входа в зону OTE.
 */
export function hasOteEntryTimedOut(
  startedAtMs: number,
  nowMs: number,
  timeoutMs: number = DEFAULT_OTE_TIMEOUT_MS
): boolean {
  return (nowMs - startedAtMs) >= timeoutMs;
}
