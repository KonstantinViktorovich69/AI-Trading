import { describe, it, expect } from 'vitest';
import {
  calculateOteEntryZone,
  hasPriceReachedOteZone,
  hasOteEntryTimedOut,
  OTE_ZONE_LOW_RATIO,
  OTE_ZONE_HIGH_RATIO,
  MIN_IMPULSE_RATIO,
  DEFAULT_OTE_TIMEOUT_MS
} from './oteEntryCalculator.ts';

describe('Optimal Trade Entry (OTE) Calculator', () => {
  describe('Constants verification', () => {
    it('defines expected Fibonacci and timeout constants', () => {
      expect(OTE_ZONE_LOW_RATIO).toBe(0.50);
      expect(OTE_ZONE_HIGH_RATIO).toBe(0.618);
      expect(MIN_IMPULSE_RATIO).toBe(0.001);
      expect(DEFAULT_OTE_TIMEOUT_MS).toBe(180000);
    });
  });

  describe('calculateOteEntryZone - Normal cases', () => {
    it('calculates valid OTE zone for LONG setup', () => {
      // Экстремум свипа снизу (локальный минимум) = 100
      // Текущая цена после отскока вверх = 110
      // Импульс = 10.0 (9.09% от цены > 0.1%)
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 110,
        localLow5m: 100,
        localHigh5m: 112
      });

      expect(res.isValid).toBe(true);
      // zoneLow = 100 + 10 * 0.50 = 105.00000
      expect(res.zoneLow).toBe(105);
      // zoneHigh = 100 + 10 * 0.618 = 106.18000
      expect(res.zoneHigh).toBe(106.18);
      // targetPrice = (105 + 106.18) / 2 = 105.59000
      expect(res.targetPrice).toBe(105.59);
      expect(res.zoneLow).toBeLessThan(res.zoneHigh);
      expect(res.targetPrice).toBeGreaterThan(res.zoneLow);
      expect(res.targetPrice).toBeLessThan(res.zoneHigh);
    });

    it('calculates valid OTE zone for SHORT setup', () => {
      // Экстремум свипа сверху (локальный максимум) = 200
      // Текущая цена после пролива вниз = 180
      // Импульс = 20.0 (11.11% от цены > 0.1%)
      const res = calculateOteEntryZone({
        isSellSignal: true,
        price: 180,
        localLow5m: 175,
        localHigh5m: 200
      });

      expect(res.isValid).toBe(true);
      // zoneHigh = 200 - 20 * 0.50 = 190.00000
      expect(res.zoneHigh).toBe(190);
      // zoneLow = 200 - 20 * 0.618 = 187.64000
      expect(res.zoneLow).toBe(187.64);
      // targetPrice = (187.64 + 190) / 2 = 188.82000
      expect(res.targetPrice).toBe(188.82);
      expect(res.zoneLow).toBeLessThan(res.zoneHigh);
      expect(res.targetPrice).toBeGreaterThan(res.zoneLow);
      expect(res.targetPrice).toBeLessThan(res.zoneHigh);
    });

    it('accurately rounds prices to 5 decimal places', () => {
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 0.12345,
        localLow5m: 0.10000,
        localHigh5m: 0.13000
      });

      expect(res.isValid).toBe(true);
      expect(Number.isFinite(res.targetPrice)).toBe(true);
      expect(res.zoneLow).toBeCloseTo(0.10000 + (0.12345 - 0.10000) * 0.50, 5);
      expect(res.zoneHigh).toBeCloseTo(0.10000 + (0.12345 - 0.10000) * 0.618, 5);
    });
  });

  describe('calculateOteEntryZone - Degenerate and invalid cases', () => {
    it('returns isValid: false when impulse is negative for LONG (price < localLow5m)', () => {
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 95,
        localLow5m: 100,
        localHigh5m: 110
      });

      expect(res.isValid).toBe(false);
      expect(res.targetPrice).toBe(95);
      expect(res.zoneLow).toBe(95);
      expect(res.zoneHigh).toBe(95);
    });

    it('returns isValid: false when impulse is negative for SHORT (price > localHigh5m)', () => {
      const res = calculateOteEntryZone({
        isSellSignal: true,
        price: 205,
        localLow5m: 190,
        localHigh5m: 200
      });

      expect(res.isValid).toBe(false);
      expect(res.targetPrice).toBe(205);
      expect(res.zoneLow).toBe(205);
      expect(res.zoneHigh).toBe(205);
    });

    it('returns isValid: false when impulse is zero', () => {
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 100,
        localLow5m: 100,
        localHigh5m: 110
      });

      expect(res.isValid).toBe(false);
    });

    it('returns isValid: false when impulse ratio is below MIN_IMPULSE_RATIO (0.1%)', () => {
      // Цена 100 000, импульс 50 (0.05% от цены, меньше минимального 0.1%)
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 100050,
        localLow5m: 100000,
        localHigh5m: 100100
      });

      expect(res.isValid).toBe(false);
      expect(res.targetPrice).toBe(100050);
    });

    it('handles non-positive price gracefully', () => {
      const res = calculateOteEntryZone({
        isSellSignal: false,
        price: 0,
        localLow5m: -10,
        localHigh5m: 10
      });

      expect(res.isValid).toBe(false);
    });
  });

  describe('hasPriceReachedOteZone', () => {
    const zoneLow = 105.0;
    const zoneHigh = 106.18;

    it('returns true when price is inside the zone', () => {
      expect(hasPriceReachedOteZone(105.5, zoneLow, zoneHigh)).toBe(true);
    });

    it('returns true on zone boundaries (inclusive)', () => {
      expect(hasPriceReachedOteZone(zoneLow, zoneLow, zoneHigh)).toBe(true);
      expect(hasPriceReachedOteZone(zoneHigh, zoneLow, zoneHigh)).toBe(true);
    });

    it('returns false when price is below zoneLow', () => {
      expect(hasPriceReachedOteZone(104.99, zoneLow, zoneHigh)).toBe(false);
    });

    it('returns false when price is above zoneHigh', () => {
      expect(hasPriceReachedOteZone(106.19, zoneLow, zoneHigh)).toBe(false);
    });

    it('works identically for SHORT zone orientation', () => {
      const shortZoneLow = 187.64;
      const shortZoneHigh = 190.00;

      // Цена откатывает снизу вверх в зону шорта
      expect(hasPriceReachedOteZone(188.0, shortZoneLow, shortZoneHigh)).toBe(true);
      expect(hasPriceReachedOteZone(186.0, shortZoneLow, shortZoneHigh)).toBe(false);
      expect(hasPriceReachedOteZone(191.0, shortZoneLow, shortZoneHigh)).toBe(false);
    });
  });

  describe('hasOteEntryTimedOut', () => {
    it('returns false when elapsed time is less than timeoutMs', () => {
      const startedAt = 1000000;
      const now = startedAt + 100000; // 100 сек (< 180 сек)
      expect(hasOteEntryTimedOut(startedAt, now)).toBe(false);
    });

    it('returns true when elapsed time equals default timeoutMs exactly', () => {
      const startedAt = 1000000;
      const now = startedAt + DEFAULT_OTE_TIMEOUT_MS; // 180 сек
      expect(hasOteEntryTimedOut(startedAt, now)).toBe(true);
    });

    it('returns true when elapsed time exceeds default timeoutMs', () => {
      const startedAt = 1000000;
      const now = startedAt + DEFAULT_OTE_TIMEOUT_MS + 1;
      expect(hasOteEntryTimedOut(startedAt, now)).toBe(true);
    });

    it('respects custom timeoutMs argument', () => {
      const startedAt = 1000000;
      const customTimeout = 60000; // 1 минута
      expect(hasOteEntryTimedOut(startedAt, startedAt + 59999, customTimeout)).toBe(false);
      expect(hasOteEntryTimedOut(startedAt, startedAt + 60000, customTimeout)).toBe(true);
    });
  });
});
