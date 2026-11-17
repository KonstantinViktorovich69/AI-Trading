import { describe, it, expect, vi } from 'vitest';
import { computeVolumeSpikeRatio, updateBtcFreshnessFast, type MarketDataCollectorContext } from './marketDataCollectorService.ts';
import { recordBtcOhlcvAgeSample, getBtcOhlcvAgeMax10mSec, getMarketDataFreshness, resetEntryGateForTest } from './entryGate.ts';

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

describe('updateBtcFreshnessFast & 10m BTC age max tracking (J4)', () => {
  it('updates GLOBAL_TRUE_OHLCV.BTCUSDT.updatedAt using only BTC 15m/1h fetches when enabled and no-ops when disabled', async () => {
    const staleTs = Date.now() - 250_000;
    const trueOhlcv: Record<string, any> = {
      BTCUSDT: { updatedAt: staleTs, ema200_1h: 60000 }
    };
    const rawOhlcv: Record<string, any> = {};
    let flagEnabled = false;

    const bars15 = Array.from({ length: 40 }, (_, i) => [
      1_700_000_000_000 + i * 900_000,
      64000 + i * 10,
      64050 + i * 10,
      63950 + i * 10,
      64020 + i * 10,
      120
    ]);
    const bars1h = Array.from({ length: 60 }, (_, i) => [
      1_700_000_000_000 + i * 3_600_000,
      64000, 64100, 63900, 64050, 500
    ]);

    const fetchOHLCV = vi.fn(async (sym: string, tf: string) => {
      if (tf === '15m') return bars15;
      if (tf === '1h') return bars1h;
      return [];
    });

    const ctx: MarketDataCollectorContext = {
      getGlobalTrueOHLCV: () => trueOhlcv,
      getGlobalRawOHLCV: () => rawOhlcv,
      getGlobalCcxtTickers: () => ({ weex: {} }),
      getGlobalATR: () => ({}),
      getGlobalADX: () => ({}),
      getGlobalDerivatives: () => ({ fundingRates: {} }),
      getFundingRates: () => ({}),
      getOpenInterests: () => ({}),
      getOrderBookImbalance: () => ({}),
      getGlobalOrderBookHistory: () => ({}),
      getCacheSignals: () => ({ data: [] }),
      getVirtualTrades: () => [],
      getCcxtExchange: () => ({ id: 'weex', markets: {}, fetchOHLCV }),
      isMainThread: () => true,
      getGlobalSettings: () => ({ btcFreshnessFastLoopEnabled: flagEnabled })
    };

    // Flag OFF -> must not hit exchange
    const disabledRes = await updateBtcFreshnessFast(ctx);
    expect(disabledRes).toBe(false);
    expect(fetchOHLCV).not.toHaveBeenCalled();
    expect(trueOhlcv.BTCUSDT.updatedAt).toBe(staleTs);

    // Flag ON -> lightweight BTC 15m + 1h update only
    flagEnabled = true;
    const enabledRes = await updateBtcFreshnessFast(ctx);
    expect(enabledRes).toBe(true);
    expect(fetchOHLCV).toHaveBeenCalledTimes(2);
    expect(fetchOHLCV.mock.calls.every(([sym]) => sym === 'BTC/USDT:USDT')).toBe(true);
    expect(trueOhlcv.BTCUSDT.updatedAt).toBeGreaterThan(staleTs);
    expect(Object.keys(trueOhlcv)).toEqual(['BTCUSDT']);
  });

  it('tracks rolling 10-minute max btcOhlcvAgeSec and drops samples older than 10 minutes', () => {
    resetEntryGateForTest();
    const t0 = 1_700_000_000_000;
    recordBtcOhlcvAgeSample(40, t0);
    recordBtcOhlcvAgeSample(185, t0 + 120_000);
    recordBtcOhlcvAgeSample(25, t0 + 240_000);

    expect(getBtcOhlcvAgeMax10mSec(t0 + 240_000)).toBe(185);

    // Move past 10 minutes after the 185s sample (t0 + 120s + 601s = t0 + 721s)
    const freshCheck = getMarketDataFreshness(t0 + 725_000, {
      getGlobalTrueOhlcv: () => ({ BTCUSDT: { updatedAt: t0 + 710_000 } }),
      getGlobalCcxtTickers: () => ({ weex: { 'BTC/USDT:USDT': { timestamp: t0 + 724_000 } } })
    });
    expect(freshCheck.btcOhlcvAgeSec).toBe(15);
    expect(freshCheck.btcOhlcvAgeMax10mSec).toBe(25); // 240s + 600s > 725s so 25s sample still in window, 185s evicted
  });
});
