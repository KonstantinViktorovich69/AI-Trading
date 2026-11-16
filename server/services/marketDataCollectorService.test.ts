import { describe, it, expect } from 'vitest';
import { computeVolumeSpikeRatio } from './marketDataCollectorService.ts';

function makeCandle(ts: number, vol: number): [number, number, number, number, number, number] {
  return [ts, 100, 101, 99, 100, vol];
}

describe('computeVolumeSpikeRatio (closed 15m candle only)', () => {
  it('ignores the last unclosed 15m candle even if its volume is extreme or zero', () => {
    const baseTime = 1_700_000_000_000;
    const closedBaseline = Array.from({ length: 10 }, (_, idx) =>
      makeCandle(baseTime + idx * 900_000, 100)
    );
    const lastClosed = makeCandle(baseTime + 10 * 900_000, 300); // exact 3.0x over preceding closed 15m candles
    const openHuge = makeCandle(baseTime + 11 * 900_000, 50_000);
    const openZero = makeCandle(baseTime + 11 * 900_000, 0);

    expect(computeVolumeSpikeRatio([...closedBaseline, lastClosed, openHuge])).toBe(3.0);
    expect(computeVolumeSpikeRatio([...closedBaseline, lastClosed, openZero])).toBe(3.0);
  });

  it('uses up to 20 preceding closed 15m candles as baseline and clamps to [0.1, 20]', () => {
    const baseTime = 1_700_000_000_000;
    const prev20 = Array.from({ length: 20 }, (_, idx) =>
      makeCandle(baseTime + idx * 900_000, 200)
    );
    const hugeClosed = makeCandle(baseTime + 20 * 900_000, 10_000); // 50x -> clamped to 20
    const openBar = makeCandle(baseTime + 21 * 900_000, 50);

    expect(computeVolumeSpikeRatio([...prev20, hugeClosed, openBar])).toBe(20);

    const tinyClosed = makeCandle(baseTime + 20 * 900_000, 1); // 0.005x -> clamped to 0.1
    expect(computeVolumeSpikeRatio([...prev20, tinyClosed, openBar])).toBe(0.1);
  });

  it('returns 1.0 when fewer than 6 bars are available (need >= 5 closed bars + 1 open bar)', () => {
    const baseTime = 1_700_000_000_000;
    const fiveBars = Array.from({ length: 5 }, (_, idx) =>
      makeCandle(baseTime + idx * 900_000, idx === 3 ? 500 : 100)
    );
    expect(computeVolumeSpikeRatio(fiveBars)).toBe(1.0);
  });
});
