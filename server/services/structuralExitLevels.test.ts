import { describe, it, expect } from 'vitest';
import {
  calculateStructuralStopLoss,
  calculateStructuralTpLadder,
  STRUCTURAL_SL_ATR_BUFFER_RATIO,
  DEFAULT_FALLBACK_SL_RATIO,
  MIN_SL_PCT,
  MAX_SL_PCT,
  MIN_RR_GUARD_TP1_BOUND,
  RR_GUARD_TP1_MULTIPLIER,
  TP_CAP_MULTIPLIER,
  TP_STAGE1_RATIO,
  TP_STAGE2_RATIO,
  TP_STAGE3_RATIO,
  TP_STAGE4_RATIO
} from './structuralExitLevels.ts';

describe('calculateStructuralStopLoss', () => {
  it('handles normal case for LONG position with ATR buffer', () => {
    // referencePrice = 100, localLow5m = 98.5, atr = 1.0, buffer = 0.15
    // structuralDistance = 100 - (98.5 - 0.15) = 1.65 (1.65%)
    // dAutoTp1 = 1.2 -> maxSlBoundByTp1 = max(0.012, 0.012 * 1.8 = 0.0216) = 0.0216
    // finalSlPct = min(0.022, max(0.008, min(0.0165, 0.0216))) = 0.0165
    // stopLoss = 100 * (1 - 0.0165) = 98.35
    const res = calculateStructuralStopLoss({
      isSellSignal: false,
      referencePrice: 100,
      localLow5m: 98.5,
      localHigh5m: 102,
      atr: 1.0,
      dAutoTp1OrDRealTp1: 1.2
    });

    expect(res.slPct).toBeCloseTo(0.0165, 5);
    expect(res.stopLoss).toBe(98.35);
  });

  it('handles normal case for SHORT position with ATR buffer', () => {
    // referencePrice = 100, localHigh5m = 101.5, atr = 1.0, buffer = 0.15
    // structuralDistance = (101.5 + 0.15) - 100 = 1.65 (1.65%)
    // stopLoss = 100 * (1 + 0.0165) = 101.65
    const res = calculateStructuralStopLoss({
      isSellSignal: true,
      referencePrice: 100,
      localLow5m: 98,
      localHigh5m: 101.5,
      atr: 1.0,
      dAutoTp1OrDRealTp1: 1.2
    });

    expect(res.slPct).toBeCloseTo(0.0165, 5);
    expect(res.stopLoss).toBe(101.65);
  });

  it('triggers MIN_SL_PCT floor when structural level is too close', () => {
    // referencePrice = 100, localLow5m = 99.8, atr = 0.5, buffer = 0.075
    // structuralDistance = 100 - (99.8 - 0.075) = 0.275 (0.275% < MIN_SL_PCT 0.8%)
    // finalSlPct should clamp to MIN_SL_PCT (0.008)
    const res = calculateStructuralStopLoss({
      isSellSignal: false,
      referencePrice: 100,
      localLow5m: 99.8,
      localHigh5m: 101,
      atr: 0.5,
      dAutoTp1OrDRealTp1: 1.0
    });

    expect(res.slPct).toBe(MIN_SL_PCT);
    expect(res.stopLoss).toBe(99.2);
  });

  it('triggers R:R Guard cap when structural level is far and TP1 is small', () => {
    // referencePrice = 100, localHigh5m = 105, atr = 2.0 -> distance ~ 7.3%
    // dAutoTp1 = 0.7% -> maxSlBound = max(0.012, 0.007 * 1.8 = 0.0126) = 0.0126 (1.26%)
    // finalSlPct should be clamped by maxSlBoundByTp1 to 0.0126
    const res = calculateStructuralStopLoss({
      isSellSignal: true,
      referencePrice: 100,
      localLow5m: 95,
      localHigh5m: 105,
      atr: 2.0,
      dAutoTp1OrDRealTp1: 0.7
    });

    expect(res.slPct).toBeCloseTo(0.0126, 5);
    expect(res.stopLoss).toBe(101.26);
  });

  it('triggers MAX_SL_PCT ceiling when structural level is very far', () => {
    // referencePrice = 100, localLow5m = 90, atr = 2.0 -> distance > 10%
    // dAutoTp1 = 2.0% -> maxSlBound = 0.02 * 1.8 = 0.036
    // finalSlPct should be capped at MAX_SL_PCT (0.022 = 2.2%)
    const res = calculateStructuralStopLoss({
      isSellSignal: false,
      referencePrice: 100,
      localLow5m: 90,
      localHigh5m: 105,
      atr: 2.0,
      dAutoTp1OrDRealTp1: 2.0
    });

    expect(res.slPct).toBe(MAX_SL_PCT);
    expect(res.stopLoss).toBe(97.8);
  });

  it('falls back to DEFAULT_FALLBACK_SL_RATIO if structural level is on the wrong side of price', () => {
    // For LONG, if localLow5m is above referencePrice (corrupted or stale data)
    const res = calculateStructuralStopLoss({
      isSellSignal: false,
      referencePrice: 100,
      localLow5m: 105,
      localHigh5m: 110,
      atr: 1.0,
      dAutoTp1OrDRealTp1: 1.0
    });

    // Fallback distance = 100 * 0.015 = 1.5%
    expect(res.slPct).toBe(DEFAULT_FALLBACK_SL_RATIO);
    expect(res.stopLoss).toBe(98.5);
  });
});

describe('calculateStructuralTpLadder', () => {
  it('handles normal case for LONG position', () => {
    // referencePrice = 100, swingHigh1h = 108, dAutoTp4Floor = 5.0
    // structuralDistance = 108 - 100 = 8.0 (8%)
    // floorDistance = 5.0, capDistance = 15.0 -> finalTp4Distance = 8.0
    // stages: 0.15 * 8 = 1.2 -> 101.2
    //         0.30 * 8 = 2.4 -> 102.4
    //         0.55 * 8 = 4.4 -> 104.4
    //         1.00 * 8 = 8.0 -> 108.0
    const res = calculateStructuralTpLadder({
      isSellSignal: false,
      referencePrice: 100,
      swingHigh1h: 108,
      swingLow1h: 90,
      dAutoTp4OrDRealTp4Floor: 5.0
    });

    expect(res.tp4DistancePct).toBe(8.0);
    expect(res.stage1).toBe(101.2);
    expect(res.stage2).toBe(102.4);
    expect(res.stage3).toBe(104.4);
    expect(res.stage4).toBe(108.0);
  });

  it('handles normal case for SHORT position', () => {
    // referencePrice = 100, swingLow1h = 92, dAutoTp4Floor = 5.0
    // structuralDistance = 100 - 92 = 8.0 (8%)
    // stages: 100 - 1.2 = 98.8
    //         100 - 2.4 = 97.6
    //         100 - 4.4 = 95.6
    //         100 - 8.0 = 92.0
    const res = calculateStructuralTpLadder({
      isSellSignal: true,
      referencePrice: 100,
      swingHigh1h: 110,
      swingLow1h: 92,
      dAutoTp4OrDRealTp4Floor: 5.0
    });

    expect(res.tp4DistancePct).toBe(8.0);
    expect(res.stage1).toBe(98.8);
    expect(res.stage2).toBe(97.6);
    expect(res.stage3).toBe(95.6);
    expect(res.stage4).toBe(92.0);
  });

  it('triggers floor when structural level is too close', () => {
    // referencePrice = 100, swingHigh1h = 102 (2% distance), floor = 4.5%
    // finalTp4Distance should clamp up to floor (4.5)
    const res = calculateStructuralTpLadder({
      isSellSignal: false,
      referencePrice: 100,
      swingHigh1h: 102,
      swingLow1h: 90,
      dAutoTp4OrDRealTp4Floor: 4.5
    });

    expect(res.tp4DistancePct).toBe(4.5);
    expect(res.stage4).toBe(104.5);
    expect(res.stage1).toBe(100.675);
  });

  it('triggers cap when structural level is too far (> 3x floor)', () => {
    // referencePrice = 100, swingLow1h = 75 (25% distance), floor = 5.0%
    // cap = 5.0 * 3 = 15.0%
    // finalTp4Distance should clamp down to cap (15.0)
    const res = calculateStructuralTpLadder({
      isSellSignal: true,
      referencePrice: 100,
      swingHigh1h: 120,
      swingLow1h: 75,
      dAutoTp4OrDRealTp4Floor: 5.0
    });

    expect(res.tp4DistancePct).toBe(15.0);
    expect(res.stage4).toBe(85.0);
    expect(res.stage1).toBe(97.75);
  });

  it('falls back to floor if swing level is on the wrong side of price', () => {
    // For LONG, swingHigh1h is 95 (< referencePrice 100)
    const res = calculateStructuralTpLadder({
      isSellSignal: false,
      referencePrice: 100,
      swingHigh1h: 95,
      swingLow1h: 90,
      dAutoTp4OrDRealTp4Floor: 4.5
    });

    expect(res.tp4DistancePct).toBe(4.5);
    expect(res.stage4).toBe(104.5);
  });
});
