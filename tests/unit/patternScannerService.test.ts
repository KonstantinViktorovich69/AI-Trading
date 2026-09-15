import { describe, it, expect } from 'vitest';
import {
  calculateRSI,
  calculateBollingerBands,
  calculateParabolicSAR,
  calculateKDJ,
  calculateVWAP,
  detectTradingPatterns,
  Candle
} from '../../server/services/patternScannerService.ts';

describe('PatternScannerService', () => {
  describe('calculateRSI', () => {
    it('returns default 50 for insufficient data', () => {
      expect(calculateRSI([])).toBe(50);
      expect(calculateRSI([10, 11, 12])).toBe(50);
    });

    it('calculates 100 for strictly increasing prices', () => {
      const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
      const rsi = calculateRSI(closes, 14);
      expect(rsi).toBe(100);
    });

    it('calculates low RSI for strictly falling prices', () => {
      const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 5);
      const rsi = calculateRSI(closes, 14);
      expect(rsi).toBeLessThan(10);
    });
  });

  describe('calculateBollingerBands', () => {
    it('returns fallback for empty data', () => {
      const bb = calculateBollingerBands([]);
      expect(bb.status).toBe('NORMAL');
      expect(bb.bandwidth).toBe(0);
    });

    it('identifies OVERBOUGHT status when price breaks above upper band', () => {
      const closes = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 15];
      const bb = calculateBollingerBands(closes, 20, 2);
      expect(bb.status).toBe('OVERBOUGHT');
      expect(bb.upper).toBeLessThan(15);
    });

    it('identifies OVERSOLD status when price breaks below lower band', () => {
      const closes = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10];
      const bb = calculateBollingerBands(closes, 20, 2);
      expect(bb.status).toBe('OVERSOLD');
      expect(bb.lower).toBeGreaterThan(10);
    });
  });

  describe('calculateParabolicSAR', () => {
    it('tracks direction and flips correctly', () => {
      const candles: Candle[] = [
        { time: 1, open: 100, high: 105, low: 99, close: 104, volume: 100 },
        { time: 2, open: 104, high: 110, low: 103, close: 109, volume: 150 },
        { time: 3, open: 109, high: 115, low: 108, close: 114, volume: 180 },
        { time: 4, open: 114, high: 116, low: 95, close: 96, volume: 300 }
      ];

      const res = calculateParabolicSAR(candles);
      expect(res.direction).toBe('BEARISH');
      expect(res.flipped).toBe(true);
    });
  });

  describe('calculateKDJ & calculateVWAP', () => {
    it('calculates valid KDJ numbers', () => {
      const candles: Candle[] = Array.from({ length: 15 }, (_, i) => ({
        time: i,
        open: 100 + i,
        high: 102 + i,
        low: 99 + i,
        close: 101 + i,
        volume: 1000
      }));

      const kdj = calculateKDJ(candles);
      expect(kdj.k).toBeGreaterThan(0);
      expect(kdj.d).toBeGreaterThan(0);
      expect(kdj.j).toBeDefined();
    });

    it('calculates weighted VWAP correctly', () => {
      const candles: Candle[] = [
        { time: 1, open: 100, high: 105, low: 95, close: 100, volume: 10 },
        { time: 2, open: 200, high: 205, low: 195, close: 200, volume: 10 }
      ];
      const vwap = calculateVWAP(candles);
      expect(vwap).toBe(150);
    });
  });

  describe('detectTradingPatterns', () => {
    it('detects 1m Spire Climax Pinbar (SHORT)', () => {
      const candles: Candle[] = Array.from({ length: 15 }, (_, i) => ({
        time: i,
        open: 100 + i * 0.5,
        high: 101 + i * 0.5,
        low: 99 + i * 0.5,
        close: 100.5 + i * 0.5,
        volume: 500
      }));

      // Append spire candle with massive upper wick
      candles.push({
        time: 16,
        open: 108,
        high: 125,
        low: 107,
        close: 108.5,
        volume: 5000
      });

      const pattern = detectTradingPatterns(candles);
      expect(pattern).not.toBeNull();
      expect(pattern?.side).toBe('SHORT');
      expect(pattern?.isLiquiditySweep).toBe(true);
      expect(pattern?.smartLimitTarget).toBeGreaterThan(108);
    });

    it('detects Spire Bottom Pinbar (LONG)', () => {
      const candles: Candle[] = Array.from({ length: 15 }, (_, i) => ({
        time: i,
        open: 100 - i * 0.5,
        high: 101 - i * 0.5,
        low: 99 - i * 0.5,
        close: 99.5 - i * 0.5,
        volume: 500
      }));

      // Append dump spire candle with massive lower wick
      candles.push({
        time: 16,
        open: 92,
        high: 92.5,
        low: 75,
        close: 91.5,
        volume: 5000
      });

      const pattern = detectTradingPatterns(candles);
      expect(pattern).not.toBeNull();
      expect(pattern?.side).toBe('LONG');
      expect(pattern?.isLiquiditySweep).toBe(true);
    });
  });
});
