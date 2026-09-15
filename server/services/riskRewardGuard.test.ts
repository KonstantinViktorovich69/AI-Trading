import { describe, it, expect } from 'vitest';

describe('Risk/Reward & Consensus Guard Logic', () => {
  it('calculates bounded Stop-Loss respecting 1.8x TP1 target', () => {
    // Scenario A: Scalp with 1.0% TP1
    const dAutoTp1 = 1.0;
    const price = 60000;
    const slDistVal = 1800; // raw ATR based distance would be 3%
    const maxSlBoundByTp1 = Math.max(0.012, (dAutoTp1 / 100) * 1.8);
    const finalSlPct = Math.min(0.022, Math.max(0.008, Math.min(slDistVal / price, maxSlBoundByTp1)));

    // slDistVal / price is 0.030 (3.0%)
    // maxSlBoundByTp1 is 0.018 (1.8%)
    // finalSlPct must be capped at 1.8% to guarantee healthy R:R
    expect(finalSlPct).toBeCloseTo(0.018, 5);
    expect(finalSlPct).toBeLessThanOrEqual(0.022);
    expect(finalSlPct).toBeGreaterThanOrEqual(0.008);
  });

  it('preserves tighter Stop-Loss when ATR is small', () => {
    // Scenario B: Low ATR scalp with 1.2% TP1
    const dAutoTp1 = 1.2;
    const price = 60000;
    const slDistVal = 600; // raw ATR distance is 1.0%
    const maxSlBoundByTp1 = Math.max(0.012, (dAutoTp1 / 100) * 1.8);
    const finalSlPct = Math.min(0.022, Math.max(0.008, Math.min(slDistVal / price, maxSlBoundByTp1)));

    // raw is 1.0%, cap is 2.16%, so 1.0% is preserved
    expect(finalSlPct).toBe(0.010);
  });

  it('determines adaptive required consensus score dynamically based on regime and trend', () => {
    const getAdaptiveRequiredScore = (signalSide: 'SHORT' | 'LONG', marketRegime: string, isReversalSweep: boolean) => {
      const isTrendAligned = (signalSide === 'LONG' && marketRegime === 'TREND_UP') ||
                             (signalSide === 'SHORT' && marketRegime === 'TREND_DOWN') ||
                             isReversalSweep;
      if (isTrendAligned) return 68;
      if (marketRegime === 'RANGING_FLAT' || marketRegime === 'NEUTRAL') return 72;
      return 75;
    };

    // Trend following LONG in bull trend
    expect(getAdaptiveRequiredScore('LONG', 'TREND_UP', false)).toBe(68);
    // Trend following SHORT in bear trend
    expect(getAdaptiveRequiredScore('SHORT', 'TREND_DOWN', false)).toBe(68);
    // Reversal sweep in flat range
    expect(getAdaptiveRequiredScore('SHORT', 'RANGING_FLAT', true)).toBe(68);
    // Range trade without sweep
    expect(getAdaptiveRequiredScore('SHORT', 'RANGING_FLAT', false)).toBe(72);
    // Counter trend trade (LONG in bear trend)
    expect(getAdaptiveRequiredScore('LONG', 'TREND_DOWN', false)).toBe(75);
  });

  it('verifies dynamic breakeven trigger thresholds (+0.60% unleveraged or +2.0% net PnL)', () => {
    const checkBreakevenQualified = (unleveragedPnlNow: number, pnlNow: number) => {
      return (unleveragedPnlNow >= 0.60 || pnlNow >= 2.00);
    };

    // Minor noise
    expect(checkBreakevenQualified(0.30, 1.20)).toBe(false);
    // Moderate unleveraged move
    expect(checkBreakevenQualified(0.65, 1.80)).toBe(true);
    // High leveraged net PnL
    expect(checkBreakevenQualified(0.45, 2.10)).toBe(true);
  });
});
