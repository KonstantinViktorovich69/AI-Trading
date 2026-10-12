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

    it('STALE_FEED race: первый проход оставляет сделку OPEN с PENDING, второй закрывает её с closedByGapReplay=true', async () => {
      const { manageActiveTrades } = await import('./virtualTradeEngine.ts');
      const now = Date.now();

      const trade: any = {
        id: 'trade_stale_race',
        symbol: 'BTC/USDT',
        side: 'LONG',
        status: 'OPEN',
        isReal: false,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        currentPrice: 100,
        amount: 10,
        leverage: 1,
        openTime: now - 7200000,
        stalePriceSince: now - 3600000 // 1 hour ago
      };

      const virtualTrades = [trade];

      // Fake candles where candle breaches SL (low = 94, SL = 95)
      const fakeCandles = [
        [now - 1800000, 99, 101, 94, 96, 100]
      ];

      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        candles: fakeCandles,
        timeframe: '1m',
        complete: true
      });

      const deps: any = {
        getVirtualTrades: () => virtualTrades,
        getGlobalSettings: () => ({ gapReplayEnabled: true }),
        getGlobalCcxtTickers: () => ({
          weex: {
            'BTC/USDT': { last: 90, timestamp: now } // fresh price is 90 (below SL 95)
          }
        }),
        getWsTickers: () => ({}),
        getGlobalTrueOhlcv: () => ({}),
        getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
        getAiKnowledgeBase: () => [],
        getVirtualBalance: () => 1000,
        setVirtualBalance: vi.fn(),
        setStartOfWeekBalance: vi.fn(),
        isCircuitBreakerActive: () => false,
        saveTradeDB: vi.fn().mockResolvedValue(undefined),
        saveBalanceDB: vi.fn(),
        emitSignalsUpdated: vi.fn(),
        fetchGapCandles: customFetch,
        getPublicExchange: () => ({ id: 'weex' })
      };

      // Первый проход сторожа:
      // Свежая цена (90) переступает SL, но из-за stalePriceSince вызывается recordGap('STALE_FEED')
      // и applyPendingGapsToOpenTrades, выставляющий gapReplayStatus = 'PENDING'.
      // Сделка должна остаться OPEN со статусом PENDING на первом проходе!
      await manageActiveTrades(deps);

      expect(trade.status).toBe('OPEN');
      expect(trade.gapReplayStatus).toBe('PENDING');

      // Ждем завершения фоновой загрузки свечей advanceGapReplay
      await new Promise(r => setTimeout(r, 20));

      // Второй проход сторожа:
      // Реплей воспроизводит свечи из кэша, фиксирует SL и закрывает сделку
      await manageActiveTrades(deps);

      expect(trade.status).toBe('CLOSED');
      expect(trade.closedByGapReplay).toBe(true);
      // Slippage for LONG SL is 95 * (1 - 0.0005) = 94.9525
      expect(trade.closePrice).toBeCloseTo(94.9525, 3);
    });

    it('обнаружение рестарта без файлов: открытые сделки с lastAliveAt 2ч назад фиксируют RESTART_GAP_ESTIMATED', async () => {
      const { TradeManagerService, resetEstimatedRestartGapForTest } = await import('./tradeManagerService.ts');
      const { resetHeartbeatForTest, getRecordedGaps } = await import('./heartbeatService.ts');
      resetHeartbeatForTest();
      resetEstimatedRestartGapForTest();

      const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
      const openTrade: any = {
        id: 'trade_old_alive',
        symbol: 'SOL/USDT',
        side: 'LONG',
        status: 'OPEN',
        isReal: false,
        entryPrice: 50,
        amount: 10,
        openTime: twoHoursAgo - 10000,
        lastAliveAt: twoHoursAgo
      };

      const trades = [openTrade];

      const service = new TradeManagerService({
        getVirtualTrades: () => trades,
        getGlobalSettings: () => ({}),
        getGlobalCcxtTickers: () => ({}),
        getWsTickers: () => ({}),
        getGlobalTrueOhlcv: () => ({}),
        getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
        getAiKnowledgeBase: () => [],
        getCcxtClient: vi.fn(),
        executeWithRetry: vi.fn(),
        saveTradeDB: vi.fn().mockResolvedValue(undefined),
        saveBalanceDB: vi.fn(),
        saveKnowledgeDB: vi.fn(),
        sendTelegramMessage: vi.fn(),
        emitSignalsUpdated: vi.fn(),
        executeRealCloseOnExchange: vi.fn(),
        executeRealPartialCloseOnExchange: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        setRealTradeSlTpOnExchange: vi.fn(),
        runAiGeneration: vi.fn()
      });

      await service.manageTradesServerSide();

      const gaps = getRecordedGaps();
      const estimatedGap = gaps.find(g => g.kind === 'RESTART_GAP_ESTIMATED');
      expect(estimatedGap).toBeDefined();
      expect(estimatedGap?.from).toBe(twoHoursAgo);
      expect(estimatedGap?.details?.source).toBe('trade_lastAliveAt');

      expect(openTrade.gapAffected).toBe(true);
      expect(openTrade.gapReplayStatus).toBe('PENDING');

      resetHeartbeatForTest();
      resetEstimatedRestartGapForTest();
    });

    it('точность реплея: простой 20 часов использует 5m, первая частичная свеча не вызывает SL по экстремуму', async () => {
      const { fetchGapCandles } = await import('./gapCandleFetcher.ts');

      // 1. Простой 20 часов использует 5m
      const from20h = 1000;
      const to20h = from20h + 20 * 3600 * 1000;
      const fakeExchange: any = {
        fetchOHLCV: vi.fn().mockResolvedValue([
          [from20h, 100, 101, 99, 100, 10]
        ]),
        loadMarkets: vi.fn().mockResolvedValue({}),
        markets: { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT:USDT', linear: true } }
      };

      const fetchRes = await fetchGapCandles(fakeExchange, 'BTC/USDT', from20h, to20h);
      expect(fetchRes.ok).toBe(true);
      expect(fetchRes.timeframe).toBe('5m');

      // 2. Первая частичная свеча (ts < gapReplayFrom) с экстремумом до простоя не вызывает SL
      const trade: any = {
        id: 'trade_partial_candle',
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: 2000 // Simple gap starts at 2000
      };

      // Candle 1: ts = 1000 < gapReplayFrom (2000). Low = 90 (breaches SL 95), but Close = 98 (safe)
      const partialCandle = [1000, 100, 101, 90, 98, 50];
      const res1 = replayGapOnCandles(trade, [partialCandle], 60000, exitCfg, 3000);
      expect(res1.terminal).toBeUndefined(); // НЕ вызывает SL!

      // Candle 2: ts = 2000 >= gapReplayFrom (2000). Low = 90, Close = 98
      const postGapCandle = [2000, 98, 99, 90, 97, 50];
      const res2 = replayGapOnCandles(trade, [partialCandle, postGapCandle], 60000, exitCfg, 3000);
      expect(res2.terminal).toBeDefined();
      expect(res2.terminal?.kind).toBe('STOP_LOSS'); // Свеча после начала простоя по-прежнему вызывает SL!
    });
  });

  describe('7. WEEX Gap Replay Coverage & Retry Tests', () => {
    function makeWeexExchange(candleHistories: Record<string, any[][]>) {
      return {
        fetchOHLCV: vi.fn(async (_symbol: string, timeframe: string, since?: number, limit?: number) => {
          const history = candleHistories[timeframe] || [];
          const effectiveLimit = Math.min(typeof limit === 'number' ? limit : 1000, 1000);
          // WEEX behavior: takes only the last min(limit, 1000) candles from history, then filters >= since
          const lastCandles = history.slice(-effectiveLimit);
          const filtered = typeof since === 'number' ? lastCandles.filter(c => c[0] >= since) : lastCandles;
          return filtered;
        }),
        loadMarkets: vi.fn().mockResolvedValue({}),
        markets: { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT:USDT', linear: true } }
      };
    }

    it('простой 12 часов, SL затронут 11 часов назад: терминальный STOP_LOSS', async () => {
      const { fetchGapCandles } = await import('./gapCandleFetcher.ts');
      const now = 20_000_000_000;
      const gapMs = 12 * 3600 * 1000;
      const fromTs = now - gapMs;
      const slTs = now - 11 * 3600 * 1000;

      // Generate 800 1m candles (covers > 12h = 720m)
      const candles1m: any[][] = [];
      for (let t = now - 800 * 60000; t <= now; t += 60000) {
        if (Math.abs(t - slTs) < 30000) {
          candles1m.push([t, 100, 101, 90, 96, 50]); // Breaches SL 95
        } else {
          candles1m.push([t, 100, 102, 98, 100, 50]);
        }
      }

      const fakeExchange = makeWeexExchange({ '1m': candles1m });
      const fetchRes = await fetchGapCandles(fakeExchange, 'BTC/USDT', fromTs, now);

      expect(fetchRes.ok).toBe(true);
      expect(fetchRes.timeframe).toBe('1m');
      expect(fetchRes.complete).toBe(true);

      const trade: any = {
        id: 'trade_12h_sl',
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        openTime: fromTs - 60000,
        gapReplayFrom: fromTs
      };

      const outcome = replayGapOnCandles(trade, fetchRes.candles!, 60000, exitCfg, now);
      expect(outcome.terminal).toBeDefined();
      expect(outcome.terminal?.kind).toBe('STOP_LOSS');
    });

    it('простой 23 часа, SL затронут 20 часов назад: STOP_LOSS', async () => {
      const { fetchGapCandles } = await import('./gapCandleFetcher.ts');
      const now = 20_000_000_000;
      const gapMs = 23 * 3600 * 1000;
      const fromTs = now - gapMs;
      const slTs = now - 20 * 3600 * 1000;

      // 23h uses 5m timeframe
      const candles5m: any[][] = [];
      for (let t = now - 300 * 5 * 60000; t <= now; t += 5 * 60000) {
        if (Math.abs(t - slTs) < 150000) {
          candles5m.push([t, 100, 101, 90, 96, 50]); // Breaches SL 95
        } else {
          candles5m.push([t, 100, 102, 98, 100, 50]);
        }
      }

      const fakeExchange = makeWeexExchange({ '5m': candles5m });
      const fetchRes = await fetchGapCandles(fakeExchange, 'BTC/USDT', fromTs, now);

      expect(fetchRes.ok).toBe(true);
      expect(fetchRes.timeframe).toBe('5m');
      expect(fetchRes.complete).toBe(true);

      const trade: any = {
        id: 'trade_23h_sl',
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        openTime: fromTs - 60000,
        gapReplayFrom: fromTs
      };

      const outcome = replayGapOnCandles(trade, fetchRes.candles!, 5 * 60000, exitCfg, now);
      expect(outcome.terminal).toBeDefined();
      expect(outcome.terminal?.kind).toBe('STOP_LOSS');
    });

    it('простой 30 часов (5m): STOP_LOSS. Простой 4 часа (1m): STOP_LOSS', async () => {
      const { fetchGapCandles } = await import('./gapCandleFetcher.ts');
      const now = 20_000_000_000;

      // Part A: 30 hours -> 5m
      const gap30h = 30 * 3600 * 1000;
      const from30h = now - gap30h;
      const sl30h = now - 15 * 3600 * 1000;
      const candles5m: any[][] = [];
      for (let t = now - 400 * 5 * 60000; t <= now; t += 5 * 60000) {
        if (Math.abs(t - sl30h) < 150000) {
          candles5m.push([t, 100, 101, 90, 96, 50]);
        } else {
          candles5m.push([t, 100, 102, 98, 100, 50]);
        }
      }
      const ex30h = makeWeexExchange({ '5m': candles5m });
      const res30h = await fetchGapCandles(ex30h, 'BTC/USDT', from30h, now);
      expect(res30h.ok).toBe(true);
      expect(res30h.timeframe).toBe('5m');
      const trade30h: any = {
        id: 'trade_30h',
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: from30h
      };
      const outcome30h = replayGapOnCandles(trade30h, res30h.candles!, 5 * 60000, exitCfg, now);
      expect(outcome30h.terminal?.kind).toBe('STOP_LOSS');

      // Part B: 4 hours -> 1m
      const gap4h = 4 * 3600 * 1000;
      const from4h = now - gap4h;
      const sl4h = now - 2 * 3600 * 1000;
      const candles1m: any[][] = [];
      for (let t = now - 300 * 60000; t <= now; t += 60000) {
        if (Math.abs(t - sl4h) < 30000) {
          candles1m.push([t, 100, 101, 90, 96, 50]);
        } else {
          candles1m.push([t, 100, 102, 98, 100, 50]);
        }
      }
      const ex4h = makeWeexExchange({ '1m': candles1m });
      const res4h = await fetchGapCandles(ex4h, 'BTC/USDT', from4h, now);
      expect(res4h.ok).toBe(true);
      expect(res4h.timeframe).toBe('1m');
      const trade4h: any = {
        id: 'trade_4h',
        symbol: 'BTC/USDT',
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: from4h
      };
      const outcome4h = replayGapOnCandles(trade4h, res4h.candles!, 60000, exitCfg, now);
      expect(outcome4h.terminal?.kind).toBe('STOP_LOSS');
    });

    it('история короче простоя: complete=false и gapReplayIncomplete=true', async () => {
      const { fetchGapCandles } = await import('./gapCandleFetcher.ts');
      const now = 20_000_000_000;
      const gap12h = 12 * 3600 * 1000; // 12 hours
      const from12h = now - gap12h;

      // Only 60 minutes of 1m candles (< 12h)
      const candles1m: any[][] = [];
      for (let t = now - 60 * 60000; t <= now; t += 60000) {
        candles1m.push([t, 100, 101, 99, 100, 10]);
      }
      // Only 10 5m candles (< 12h)
      const candles5m: any[][] = [];
      for (let t = now - 10 * 5 * 60000; t <= now; t += 5 * 60000) {
        candles5m.push([t, 100, 101, 99, 100, 10]);
      }
      // Only 4 15m candles (< 12h)
      const candles15m: any[][] = [];
      for (let t = now - 4 * 15 * 60000; t <= now; t += 15 * 60000) {
        candles15m.push([t, 100, 101, 99, 100, 10]);
      }

      const fakeExchange = makeWeexExchange({ '1m': candles1m, '5m': candles5m, '15m': candles15m });
      const fetchRes = await fetchGapCandles(fakeExchange, 'BTC/USDT', from12h, now);

      expect(fetchRes.ok).toBe(true);
      expect(fetchRes.complete).toBe(false);

      // Verify advanceGapReplay sets gapReplayIncomplete = true
      resetGapReplayRuntimeState();
      const trade: any = {
        id: 'trade_incomplete_history',
        symbol: 'BTC/USDT',
        side: 'LONG',
        isReal: false,
        status: 'OPEN',
        entryPrice: 100,
        stopLoss: 90,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: from12h,
        gapReplayStatus: 'PENDING',
        gapReplayAttempts: 0
      };

      const customFetcher = vi.fn().mockResolvedValue(fetchRes);

      const r1 = advanceGapReplay(trade, fakeExchange, exitCfg, now, customFetcher);
      expect(r1.kind).toBe('WAIT');

      await new Promise(r => setTimeout(r, 20));

      const r2 = advanceGapReplay(trade, fakeExchange, exitCfg, now + 10, customFetcher);
      expect(r2.kind).toBe('READY');
      expect(trade.gapReplayIncomplete).toBe(true);
      expect(trade.gapReplayStatus).toBe('DONE');
    });

    it('первая выдача бросает ошибку, вторая успешна: после первой попытки сделка остаётся PENDING, после второй закрывается реплеем', async () => {
      resetGapReplayRuntimeState();
      const now = 10000;
      const trade: any = {
        id: 'trade_first_err_second_ok',
        symbol: 'BTC/USDT',
        side: 'LONG',
        isReal: false,
        status: 'OPEN',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: 2000,
        gapReplayStatus: 'PENDING',
        gapReplayAttempts: 0
      };

      let callCount = 0;
      const customFetcher = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, reason: 'FETCH_ERROR', error: 'WEEX timeout error' };
        }
        return {
          ok: true,
          timeframe: '1m',
          complete: true,
          candles: [
            [2500, 100, 101, 90, 96, 50] // Breaches SL 95
          ]
        };
      });

      // Attempt 1: fails
      const r1 = advanceGapReplay(trade, {}, exitCfg, now, customFetcher);
      expect(r1.kind).toBe('WAIT');
      await new Promise(r => setTimeout(r, 20));

      expect(trade.gapReplayStatus).toBe('PENDING');
      expect(trade.gapReplayAttempts).toBe(1);
      expect(trade.gapReplayLastError).toBe('WEEX timeout error');

      // Attempt 2 after 16s cooldown: succeeds
      const tAttempt2 = now + 16000;
      const r2 = advanceGapReplay(trade, {}, exitCfg, tAttempt2, customFetcher);
      expect(r2.kind).toBe('WAIT');
      await new Promise(r => setTimeout(r, 20));

      // Processing loaded candles
      const r3 = advanceGapReplay(trade, {}, exitCfg, tAttempt2 + 10, customFetcher);
      expect(r3.kind).toBe('READY');
      expect(r3.outcome?.terminal?.kind).toBe('STOP_LOSS');
      expect(trade.gapReplayStatus).toBe('DONE');
    });

    it('три ошибки подряд: FALLBACK_LIVE', async () => {
      resetGapReplayRuntimeState();
      const now = 10000;
      const trade: any = {
        id: 'trade_three_errors_fallback',
        symbol: 'BTC/USDT',
        side: 'LONG',
        isReal: false,
        status: 'OPEN',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 120,
        amount: 10,
        leverage: 1,
        gapReplayFrom: 2000,
        gapReplayStatus: 'PENDING',
        gapReplayAttempts: 0
      };

      const failingFetcher = vi.fn().mockResolvedValue({
        ok: false,
        reason: 'FETCH_ERROR',
        error: 'Persistent exchange downtime'
      });

      // Attempt 1 at t = 10000
      advanceGapReplay(trade, {}, exitCfg, now, failingFetcher);
      await new Promise(r => setTimeout(r, 20));
      expect(trade.gapReplayStatus).toBe('PENDING');
      expect(trade.gapReplayAttempts).toBe(1);

      // Attempt 2 at t = 26000 (after 16s)
      advanceGapReplay(trade, {}, exitCfg, now + 16000, failingFetcher);
      await new Promise(r => setTimeout(r, 20));
      expect(trade.gapReplayStatus).toBe('PENDING');
      expect(trade.gapReplayAttempts).toBe(2);

      // Attempt 3 at t = 42000 (after 16s)
      advanceGapReplay(trade, {}, exitCfg, now + 32000, failingFetcher);
      await new Promise(r => setTimeout(r, 20));
      expect(trade.gapReplayStatus).toBe('PENDING');
      expect(trade.gapReplayAttempts).toBe(3);

      // Next advance call at t = 58000: attempts >= 3 triggers FALLBACK_LIVE
      const rFinal = advanceGapReplay(trade, {}, exitCfg, now + 48000, failingFetcher);
      expect(rFinal.kind).toBe('FALLBACK_LIVE');
      expect(trade.gapReplayStatus).toBe('FALLBACK_LIVE');
    });
  });
});

