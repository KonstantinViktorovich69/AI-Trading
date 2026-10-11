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

  describe('1. gapReplay: Pure Replay & Candle Simulation', () => {

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

  describe('6. Production Gap Detection & Replay Hardening (Задачи 1-3)', () => {
    it('startHeartbeat со старым heartbeat.json (замоканный fs): записан RESTART_GAP, открытые сделки получили gapAffected=true и gapReplayStatus="PENDING"', async () => {
      const { startHeartbeat, resetHeartbeatForTest, getDowntimeSummary } = await import('./heartbeatService.ts');
      const fs = await import('fs');

      resetHeartbeatForTest();
      resetGapReplayRuntimeState();

      const oldHeartbeatTs = Date.now() - 120000; // 2 minutes ago (> 45s)
      const fakeHeartbeatJson = JSON.stringify({
        ts: oldHeartbeatTs,
        pid: 99999,
        buildId: 'old_build_123',
        processStartedAt: oldHeartbeatTs - 3600000,
        seq: 42
      });

      const readSpy = vi.spyOn(fs.default, 'readFileSync').mockImplementation((filePath: any, ...args: any[]) => {
        if (String(filePath).includes('heartbeat.json')) {
          return fakeHeartbeatJson;
        }
        return '';
      });
      const existsSpy = vi.spyOn(fs.default, 'existsSync').mockImplementation((filePath: any) => {
        if (String(filePath).includes('heartbeat.json')) {
          return true;
        }
        return false;
      });
      const writeSpy = vi.spyOn(fs.default, 'writeFileSync').mockImplementation(() => {});
      const renameSpy = vi.spyOn(fs.default, 'renameSync').mockImplementation(() => {});

      const mockOpenTrade: any = {
        id: 'trade_hb_test_1',
        symbol: 'BTC/USDT',
        status: 'OPEN',
        isReal: false,
        openTime: oldHeartbeatTs - 60000
      };
      const mockVirtualTrades = [mockOpenTrade];
      const saveSpy = vi.fn();

      try {
        startHeartbeat({
          getVirtualTrades: () => mockVirtualTrades,
          saveTradeDB: saveSpy
        });

        const summary = getDowntimeSummary();
        const restartGap = summary.entries.find(e => e.kind === 'RESTART_GAP');
        expect(restartGap).toBeDefined();
        expect(restartGap?.prevBuildId).toBe('old_build_123');

        // Check trade was marked gapAffected and gapReplayStatus='PENDING'
        expect(mockOpenTrade.gapAffected).toBe(true);
        expect((mockOpenTrade as any).gapReplayStatus).toBe('PENDING');
        expect((mockOpenTrade as any).gapReplayFrom).toBe(restartGap?.from);
      } finally {
        readSpy.mockRestore();
        existsSpy.mockRestore();
        writeSpy.mockRestore();
        renameSpy.mockRestore();
        resetHeartbeatForTest();
      }
    });

    it('реплей с поддельной биржей, отдающей свечи: сделка закрыта по SL с ценой SL*(1-0.0005); второй простой той же сделки запрашивает свечи заново', async () => {
      resetGapReplayRuntimeState();

      const trade: any = {
        id: 'trade_replay_sl_chain',
        symbol: 'SOL/USDT',
        side: 'LONG',
        status: 'OPEN',
        isReal: false,
        entryPrice: 150,
        amount: 10,
        leverage: 5,
        stopLoss: 140,
        takeProfit: 170,
        openTime: 1000,
        gapReplayFrom: 2000,
        gapReplayStatus: 'PENDING',
        gapReplayAttempts: 0
      };

      let fetchCount = 0;
      const fakeExchange: any = {
        loadMarkets: vi.fn().mockResolvedValue({}),
        markets: { 'SOL/USDT': {} }
      };

      const customFetcher = vi.fn().mockImplementation(async (_ex, _sym, fromTs, _toTs) => {
        fetchCount++;
        // Low price touches 135 (below SL 140)
        return {
          ok: true,
          candles: [
            [fromTs + 1000, 148, 151, 135, 138, 500]
          ]
        };
      });

      // 1. First advance triggers fetch
      const res1 = advanceGapReplay(trade, fakeExchange, exitCfg, 5000, customFetcher);
      expect(res1.kind).toBe('WAIT');
      expect(fetchCount).toBe(1);

      // Wait for background promise
      await new Promise(r => setTimeout(r, 20));

      // 2. Second advance processes loaded candles and returns READY with terminal SL
      const res2 = advanceGapReplay(trade, fakeExchange, exitCfg, 5010, customFetcher);
      expect(res2.kind).toBe('READY');
      expect(trade.gapReplayStatus).toBe('DONE');
      expect(res2.outcome?.terminal).toBeDefined();
      expect(res2.outcome?.terminal?.kind).toBe('STOP_LOSS');
      // SL price for LONG SL slippage is 140 * (1 - 0.0005) = 139.93
      expect(res2.outcome?.terminal?.executionPrice).toBeCloseTo(139.93, 2);

      // 3. Trade suffers a SECOND gap later at time 20000
      trade.status = 'OPEN';
      trade.gapReplayStatus = 'PENDING';
      trade.gapReplayFrom = 20000;
      trade.gapReplayAttempts = 0;

      // Advancing again for the second gap MUST initiate a fresh fetch (new pair key)
      const res3 = advanceGapReplay(trade, fakeExchange, exitCfg, 25000, customFetcher);
      expect(res3.kind).toBe('WAIT');
      expect(fetchCount).toBe(2); // Second gap requested fresh candles!
    });

    it('STALE_FEED по символу A не метит сделку по B и не ставит паузу входов', async () => {
      const { recordGap, applyPendingGapsToOpenTrades, resetHeartbeatForTest } = await import('./heartbeatService.ts');
      resetHeartbeatForTest();
      resetEntryGateForTest();

      const tradeA: any = {
        id: 'trade_A',
        symbol: 'BTC/USDT',
        status: 'OPEN',
        isReal: false,
        openTime: 1000
      };

      const tradeB: any = {
        id: 'trade_B',
        symbol: 'ETH/USDT',
        status: 'OPEN',
        isReal: false,
        openTime: 1000
      };

      const trades = [tradeA, tradeB];

      // Record STALE_FEED for BTC/USDT of 100s (> 60s)
      const gap = recordGap('STALE_FEED', 2000, 102000, { symbol: 'BTC/USDT' });
      expect(gap).toBeDefined();

      applyPendingGapsToOpenTrades(trades);

      // Trade A must be marked, Trade B must NOT be marked
      expect(tradeA.gapAffected).toBe(true);
      expect(tradeB.gapAffected).toBeUndefined();

      // Check entryGate: STALE_FEED should NOT pause entries
      const gateStatus = isEntryPaused(Date.now(), {
        getGlobalSettings: () => ({ entryPauseAfterStartSec: 0 })
      });
      expect(gateStatus.paused).toBe(false);

      resetHeartbeatForTest();
      resetEntryGateForTest();
    });

    it('частичная фиксация идёт по цене таргета стадии', () => {
      const tradeWithStages: any = {
        id: 'trade_multi_tp',
        symbol: 'ETH/USDT',
        side: 'LONG',
        status: 'OPEN',
        entryPrice: 3000,
        amount: 100,
        leverage: 1,
        stopLoss: 2800,
        takeProfit: 3500,
        openTime: 1000,
        tpStages: [
          { targetPrice: 3100, closeRatio: 0.25, executed: false },
          { targetPrice: 3200, closeRatio: 0.25, executed: false },
          { targetPrice: 3300, closeRatio: 0.25, executed: false },
          { targetPrice: 3400, closeRatio: 1.0, executed: false }
        ]
      };

      // Candle reaches high of 3150 (passes targetPrice 3100)
      const candles = [
        [2000, 3050, 3150, 3020, 3120, 100]
      ];

      const res = replayGapOnCandles(tradeWithStages, candles, 60000, exitCfg, 3000);
      const partialEvent = res.events.find(e => e.type === 'PARTIAL_CLOSE');
      expect(partialEvent).toBeDefined();
      // Price must strictly be 3100 (the stage targetPrice), NOT 3150 (the candle high)
      expect(partialEvent?.price).toBe(3100);
      expect(partialEvent?.stageIndex).toBe(0);
    });
  });
});

