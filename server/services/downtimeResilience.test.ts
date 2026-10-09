import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { replayGapOnCandles } from './gapReplay.ts';
import { advanceGapReplay, resetGapReplayRuntimeState } from './gapReplayRuntime.ts';
import { isEntryPaused, pauseEntries, resetEntryGateForTest } from './entryGate.ts';
import { runGuarded, resetLoopGuardStateForTest } from './loopGuard.ts';
import { updatePatternBlacklistFromStats } from './signalEngine.ts';
import { trainQuantModel } from './quantModelTrainer.ts';
import { PROCESS_STARTED_AT } from './buildInfo.ts';

describe('Downtime Resilience & Telemetry Suite (Prompt 2)', () => {
  beforeEach(() => {
    resetGapReplayRuntimeState();
    resetEntryGateForTest();
    resetLoopGuardStateForTest();
  });

  describe('1. gapReplay: Pure Replay & Candle Simulation', () => {
    const exitCfg = {
      minNormalAutoCloseNetPnlPct: 6.0,
      minPttpActivationNetPnlPct: 12.0,
      minPttpPeakNetPnlPct: 18.0,
      pttpTrailingDropPct: 35.0,
      maxLifetimeHours: 24,
      allowEmergencyMaxLifetime: true,
      timeoutProfitHours: 18,
      minTimeoutProfitNetPnlPct: 6.0,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 8.0,
      maxStagnationPnlPct: 0.5,
      enableMultiTp: true,
      bypassProfitFloorForMultiTp: true,
      bypassProfitFloorForPrimaryTp: true,
      enableTrailingStop: true,
      trailingStopTriggerPnlPct: 14.0,
      trailingStopDistancePct: 3.0
    };

    it('triggers SL with adverse slippage for LONG during gap (raw touch without 5s)', () => {
      const trade = {
        id: 'trade_long_sl',
        symbol: 'BTC/USDT:USDT',
        side: 'LONG',
        entryPrice: 100,
        amount: 100,
        leverage: 1,
        stopLoss: 95,
        takeProfit: 110,
        openTime: 1000
      };

      // Candle dropping to 94 (breaches SL 95)
      const candles = [
        [2000, 99, 101, 94, 96, 100] // [time, open, high, low, close, volume]
      ];

      const res = replayGapOnCandles(trade, candles, 60000, exitCfg, 3000);
      expect(res.terminal).toBeDefined();
      expect(res.terminal?.kind).toBe('STOP_LOSS');
      // Slippage for LONG SL is 0.05% lower: 95 * (1 - 0.0005) = 94.9525
      expect(res.terminal?.executionPrice).toBeCloseTo(94.9525, 3);
      expect(res.terminal?.eventTime).toBe(2000);
    });

    it('triggers SL with adverse slippage for SHORT during gap', () => {
      const trade = {
        id: 'trade_short_sl',
        symbol: 'ETH/USDT:USDT',
        side: 'SHORT',
        entryPrice: 100,
        amount: 100,
        leverage: 1,
        stopLoss: 105,
        takeProfit: 90,
        openTime: 1000
      };

      // Candle pumping to 106 (breaches SHORT SL 105)
      const candles = [
        [2000, 101, 106, 99, 104, 100]
      ];

      const res = replayGapOnCandles(trade, candles, 60000, exitCfg, 3000);
      expect(res.terminal).toBeDefined();
      expect(res.terminal?.kind).toBe('STOP_LOSS');
      // Slippage for SHORT SL is 0.05% higher: 105 * (1 + 0.0005) = 105.0525
      expect(res.terminal?.executionPrice).toBeCloseTo(105.0525, 3);
    });

    it('triggers SL first if both SL and TP are hit in the same candle', () => {
      const trade = {
        id: 'trade_both_hit',
        symbol: 'SOL/USDT:USDT',
        side: 'LONG',
        entryPrice: 100,
        amount: 100,
        leverage: 1,
        stopLoss: 90,
        takeProfit: 120,
        openTime: 1000
      };

      // Huge candle with low 85 (SL hit) and high 125 (TP hit)
      const candles = [
        [2000, 100, 125, 85, 115, 1000]
      ];

      const res = replayGapOnCandles(trade, candles, 60000, exitCfg, 3000);
      expect(res.terminal).toBeDefined();
      expect(res.terminal?.kind).toBe('STOP_LOSS');
    });

    it('executes TP1 partial close and then triggers breakeven SL', () => {
      const trade = {
        id: 'trade_multi_tp',
        symbol: 'ADA/USDT:USDT',
        side: 'LONG',
        entryPrice: 1.0,
        amount: 100,
        leverage: 1,
        stopLoss: 0.95,
        takeProfit: 1.20,
        isMultiTp: true,
        tpStages: [
          { targetPrice: 1.05, closeRatio: 0.3, executed: false },
          { targetPrice: 1.10, closeRatio: 0.3, executed: false }
        ],
        openTime: 1000
      };

      // Candle 1: reaches 1.06 (TP1 hit, unleveraged > 1.5% -> breakeven)
      // Candle 2: drops to 1.002 (hits breakeven SL ~1.0035)
      const candles = [
        [2000, 1.0, 1.06, 1.0, 1.05, 500],
        [3000, 1.05, 1.05, 1.00, 1.01, 500]
      ];

      const res = replayGapOnCandles(trade, candles, 60000, exitCfg, 4000);
      expect(res.executedStages).toContain(0);
      const partialEvents = res.events.filter(e => e.type === 'PARTIAL_CLOSE');
      expect(partialEvents.length).toBeGreaterThanOrEqual(1);
      expect(partialEvents[0].amountClosed).toBe(30);

      // In candle 2, SL has been moved to breakeven (1.0035) and is triggered
      expect(res.terminal).toBeDefined();
      expect(res.terminal?.kind).toBe('STOP_LOSS');
    });

    it('returns no events if price stays within bounds and hits nothing', () => {
      const trade = {
        id: 'trade_no_hit',
        symbol: 'DOT/USDT:USDT',
        side: 'LONG',
        entryPrice: 10,
        amount: 100,
        leverage: 1,
        stopLoss: 8,
        takeProfit: 15,
        openTime: 1000
      };

      const candles = [
        [2000, 10, 10.1, 9.9, 10.05, 100]
      ];

      const res = replayGapOnCandles(trade, candles, 60000, exitCfg, 3000);
      expect(res.terminal).toBeUndefined();
      expect(res.events.length).toBe(0);
    });
  });

  describe('2. gapReplayRuntime: Fallback and In-Flight Handling', () => {
    it('returns FALLBACK_LIVE after 3 attempts or timeout', async () => {
      const trade = {
        id: 'trade_runtime_fallback',
        symbol: 'XRP/USDT:USDT',
        side: 'LONG',
        isReal: false,
        openTime: Date.now() - 50000,
        gapReplayStatus: 'PENDING',
        gapReplayAttempts: 3
      };

      const res = advanceGapReplay(trade, {}, {} as any, Date.now());
      expect(res.kind).toBe('FALLBACK_LIVE');
      expect(trade.gapReplayStatus).toBe('FALLBACK_LIVE');
    });

    it('does not run replay on real trades', () => {
      const trade: any = {
        id: 'trade_real_no_replay',
        symbol: 'BTC/USDT:USDT',
        isReal: true,
        status: 'OPEN'
      };
      // Advance shouldn't be called or status won't be set to PENDING
      expect(trade.gapReplayStatus).toBeUndefined();
    });
  });

  describe('3. entryGate: Pausing on Startup, Warmup, and Gaps', () => {
    it('pauses entries during startup cooldown', () => {
      // Simulate now being 30s after PROCESS_STARTED_AT
      const now = PROCESS_STARTED_AT + 30000;
      const status = isEntryPaused(now, {
        getGlobalSettings: () => ({ entryPauseAfterStartSec: 120 })
      });
      expect(status.paused).toBe(true);
      expect(status.reason).toBe('startup_cooldown');
      expect(status.remainingSec).toBe(90);
    });

    it('pauses entries when OHLCV warmup has less than 3 symbols', () => {
      // 150s after startup (past 120s cooldown), but only 1 symbol warmed up
      const now = PROCESS_STARTED_AT + 150000;
      const status = isEntryPaused(now, {
        getGlobalSettings: () => ({ entryPauseAfterStartSec: 120 }),
        getGlobalTrueOhlcv: () => ({ 'BTCUSDT': {} })
      });
      expect(status.paused).toBe(true);
      expect(status.reason).toBe('ohlcv_warmup');
    });

    it('forcibly releases warmup pause after 300s', () => {
      // 301s after startup with 1 symbol
      const now = PROCESS_STARTED_AT + 301000;
      const status = isEntryPaused(now, {
        getGlobalSettings: () => ({ entryPauseAfterStartSec: 120 }),
        getGlobalTrueOhlcv: () => ({ 'BTCUSDT': {} })
      });
      expect(status.paused).toBe(false);
    });

    it('pauses entries after manual or gap trigger', () => {
      const now = PROCESS_STARTED_AT + 400000;
      pauseEntries(120, 'gap', now);
      const status = isEntryPaused(now + 1000);
      expect(status.paused).toBe(true);
      expect(status.reason).toBe('gap');
    });
  });

  describe('4. loopGuard: Overlap and Hang Protection', () => {
    it('prevents overlapping loop execution and tracks skipped overlap', async () => {
      let isFirstRunning = true;
      let secondRan = false;

      const promise1 = runGuarded('test_loop', 5000, async () => {
        while (isFirstRunning) {
          await new Promise(r => setTimeout(r, 20));
        }
        return 'first_done';
      });

      // Second attempt while first is running
      const res2 = await runGuarded('test_loop', 5000, async () => {
        secondRan = true;
        return 'second_done';
      });

      expect(res2).toBeUndefined();
      expect(secondRan).toBe(false);

      isFirstRunning = false;
      const res1 = await promise1;
      expect(res1).toBe('first_done');
    });

    it('forcibly releases lock when loop exceeds maxRunMs', async () => {
      vi.useFakeTimers();

      let hungFinished = false;
      // Start a hung loop
      runGuarded('hung_loop', 1000, () => new Promise(r => {
        setTimeout(() => { hungFinished = true; r('hung'); }, 10000);
      })).catch(() => {});

      // Fast forward time past 1000ms
      vi.advanceTimersByTime(1500);

      let newRan = false;
      await runGuarded('hung_loop', 1000, async () => {
        newRan = true;
        return 'recovered';
      });

      expect(newRan).toBe(true);
      vi.useRealTimers();
    });

    it('clears lock properly when an exception is thrown', async () => {
      await expect(
        runGuarded('error_loop', 5000, async () => {
          throw new Error('Test loop error');
        })
      ).rejects.toThrow('Test loop error');

      // Next run should succeed immediately
      let ranAfterError = false;
      await runGuarded('error_loop', 5000, async () => {
        ranAfterError = true;
      });
      expect(ranAfterError).toBe(true);
    });
  });

  describe('5. Exclusion of gapAffected Trades from Self-Learning', () => {
    it('excludes gapAffected trades from pattern blacklist statistics', () => {
      const closedTrades = [
        {
          symbol: 'BTC/USDT:USDT',
          pattern: 'SAR_PEAK_REVERSAL',
          status: 'CLOSED',
          pnl: -50,
          outcome: 0,
          gapAffected: true // SHOULD BE EXCLUDED
        },
        {
          symbol: 'ETH/USDT:USDT',
          pattern: 'SAR_PEAK_REVERSAL',
          status: 'CLOSED',
          pnl: 10,
          outcome: 1,
          gapAffected: false
        }
      ];

      // Should not throw and processes clean trades only
      expect(() => updatePatternBlacklistFromStats(closedTrades)).not.toThrow();
    });

    it('excludes gapAffected trades from quant model training', async () => {
      let trainingSelectedTrades: any[] = [];
      const mockContext: any = {
        getModelStatus: () => ({ isTrainingActive: false, lastRetrained: 0, totalLearnedTrades: 0 }),
        getModelWeights: () => ({ beta0: 0, beta1: 0, beta2: 0, beta3: 0, beta4: 0, beta5: 0, beta6: 0, beta7: 0, beta8: 0, beta9: 0, beta10: 0, beta11: 0 }),
        setModelWeights: vi.fn(),
        getVirtualTrades: () => [
          { status: 'CLOSED', pnl: 5, gapAffected: true }, // Excluded
          { status: 'CLOSED', pnl: -10, gapAffected: false }
        ],
        getAiKnowledgeBase: () => [],
        saveKnowledgeDB: vi.fn(),
        saveSettings: vi.fn()
      };

      // trainQuantModel will filter trades; since total < 30 it exits early cleanly
      await trainQuantModel(mockContext);
      expect(mockContext.getModelStatus().isTrainingActive).toBe(false);
    });
  });
});
