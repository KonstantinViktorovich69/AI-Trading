import { describe, it, expect, vi, beforeEach } from 'vitest';
import { manageActiveTrades, VirtualTradeEngineDependencies } from './virtualTradeEngine.ts';
import { executeRuleBasedTradeFallback, runAiExpertTraderLoop, ExpertAdvisorDependencies } from './expertAdvisorService.ts';
import { addOtePendingCandidate, clearOtePendingCandidates, getOtePendingCandidates } from './oteVirtualQueue.ts';

describe('virtualTradeEngine service', () => {
  let mockDeps: VirtualTradeEngineDependencies;
  let sampleTrade: any;
  let savedTrades: any[] = [];
  let signalsEmitted = false;

  beforeEach(() => {
    savedTrades = [];
    signalsEmitted = false;
    clearOtePendingCandidates();

    sampleTrade = {
      id: 'trade_test_1',
      symbol: 'BTC/USDT',
      side: 'SHORT',
      entryPrice: 65000,
      currentPrice: 65000,
      amount: 100,
      leverage: 10,
      status: 'OPEN',
      openTime: Date.now() - 60000,
      stopLoss: 66000,
      takeProfit: 63000,
      tpStages: [
        { ratio: 0.5, pricePct: 2.0, targetPrice: 63700, executed: false }
      ],
      gridOrders: [
        { price: 65500, amount: 50, executed: false }
      ]
    };

    mockDeps = {
      getVirtualTrades: () => [sampleTrade],
      getGlobalSettings: () => ({ isAiPartialCloseRealEnabled: true }),
      getGlobalCcxtTickers: () => ({
        binance: {
          'BTC/USDT': { last: 65000, bid: 64995, ask: 65005, close: 65000 }
        }
      }),
      getWsTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({
        BTCUSDT: {
          rsi1m: 55,
          rsi15m: 52,
          volumeSpike: 1.0
        }
      }),
      getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 50 }),
      getAiKnowledgeBase: () => [],
      getVirtualBalance: () => 1000,
      setVirtualBalance: vi.fn(),
      getStartOfDayRealBalance: () => 1000,
      setStartOfDayRealBalance: vi.fn(),
      getStartOfWeekBalance: () => 1000,
      setStartOfWeekBalance: vi.fn(),
      isCircuitBreakerActive: () => false,
      triggerCircuitBreaker: vi.fn(),
      getCcxtClient: vi.fn(),
      fetchCachedRealBalance: vi.fn(),
      saveTradeDB: vi.fn(async (t) => { savedTrades.push(t); }),
      saveBalanceDB: vi.fn(),
      saveKnowledgeDB: vi.fn(),
      sendTelegramMessage: vi.fn(),
      emitSignalsUpdated: vi.fn(() => { signalsEmitted = true; }),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn().mockResolvedValue(true),
      runAiGeneration: vi.fn().mockResolvedValue({ text: '{}' })
    };
  });

  it('updates current price from ticker and calculates PnL correctly', async () => {
    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 64000, bid: 63990, ask: 64010, close: 64000 }
      }
    });

    await manageActiveTrades(mockDeps);

    expect(sampleTrade.currentPrice).toBe(64000);
    expect(mockDeps.emitSignalsUpdated).toHaveBeenCalled();
  });

  it('triggers Stop Loss when price exceeds SL for duration', async () => {
    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 66500, bid: 66490, ask: 66510, close: 66500 }
      }
    });

    sampleTrade.slViolationSeconds = 10; // Already in violation
    await manageActiveTrades(mockDeps);

    expect(sampleTrade.status).toBe('CLOSED');
    expect(sampleTrade.closeReason).toContain('стоп-лосс');
    expect(mockDeps.saveTradeDB).toHaveBeenCalled();
  });

  it('executes DCA grid order when price crosses grid level', async () => {
    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 65600, bid: 65590, ask: 65610, close: 65600 }
      }
    });

    await manageActiveTrades(mockDeps);

    expect(sampleTrade.gridOrders[0].executed).toBe(true);
    expect(sampleTrade.amount).toBe(150);
    expect(sampleTrade.entryPrice).toBeGreaterThan(65000);
  });

  it('blocks DCA when price is within 0.5% of Stop Loss', async () => {
    // SL is 66000. 0.5% before SL is 65670. Setting price to 65700 (within 0.5% of SL).
    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 65700, bid: 65690, ask: 65710, close: 65700 }
      }
    });

    await manageActiveTrades(mockDeps);

    // Grid order must NOT be executed because price is in the SL danger zone
    expect(sampleTrade.gridOrders[0].executed).toBe(false);
    expect(sampleTrade.amount).toBe(100);
  });

  it('enforces 1.5x margin cap on DCA averaging', async () => {
    // Initial amount 100 -> 1.5x cap is 150.
    // If trade amount is already 145 and next grid is 50, it should be clamped to 5
    sampleTrade.initialAmount = 100;
    sampleTrade.amount = 145;
    sampleTrade.gridOrders = [
      { price: 65500, amount: 50, executed: false }
    ];

    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 65550, bid: 65540, ask: 65560, close: 65550 }
      }
    });

    await manageActiveTrades(mockDeps);

    expect(sampleTrade.gridOrders[0].executed).toBe(true);
    expect(sampleTrade.amount).toBe(150); // Capped at exactly 150 (1.5x)
  });

  it('moves Stop Loss to break-even after DCA when position recovers', async () => {
    sampleTrade.dcaAveraged = true;
    sampleTrade.entryPrice = 65200; // Averaged entry price
    sampleTrade.dcaBreakEvenPrice = 65200;
    sampleTrade.stopLoss = 66000; // Original loss SL

    // Price recovers past entry (for SHORT, price falls below entry to 65100)
    mockDeps.getGlobalCcxtTickers = () => ({
      binance: {
        'BTC/USDT': { last: 65100, bid: 65090, ask: 65110, close: 65100 }
      }
    });

    await manageActiveTrades(mockDeps);

    // Stop Loss must be adjusted to break-even (~65200 * 0.9995)
    expect(sampleTrade.stopLoss).toBeLessThanOrEqual(65200);
    expect(sampleTrade.dcaBreakEvenSet).toBe(true);
    expect(sampleTrade.isProtected).toBe(true);
  });

  it('processes filled OTE candidates in manageActiveTrades watchdog loop', async () => {
    const executeVirtualEntry = vi.fn();
    addOtePendingCandidate({
      id: 'ote_cand_1',
      symbol: 'BTC/USDT',
      zoneLow: 64000,
      zoneHigh: 64500,
      startedAtMs: Date.now(),
      context: { executeVirtualEntry }
    });

    mockDeps.getGlobalCcxtTickers = () => ({
      weex: {
        'BTC/USDT': { last: 64200 }
      }
    });

    await manageActiveTrades(mockDeps);

    expect(executeVirtualEntry).toHaveBeenCalledWith(64200);
    expect(getOtePendingCandidates().length).toBe(0);
  });

  it('handles timed out candidates in manageActiveTrades watchdog loop without executing them', async () => {
    const executeVirtualEntry = vi.fn();
    addOtePendingCandidate({
      id: 'ote_cand_timeout',
      symbol: 'BTC/USDT',
      zoneLow: 64000,
      zoneHigh: 64500,
      startedAtMs: Date.now() - 300000, // 5 min ago (exceeds default timeout)
      context: { executeVirtualEntry }
    });

    mockDeps.getGlobalCcxtTickers = () => ({
      weex: {
        'BTC/USDT': { last: 65000 }
      }
    });

    await manageActiveTrades(mockDeps);

    expect(executeVirtualEntry).not.toHaveBeenCalled();
    expect(getOtePendingCandidates().length).toBe(0);
  });

  it('safely handles candidates without context or executeVirtualEntry function without crashing', async () => {
    addOtePendingCandidate({
      id: 'ote_cand_bad',
      symbol: 'BTC/USDT',
      zoneLow: 64000,
      zoneHigh: 64500,
      startedAtMs: Date.now(),
      context: {}
    });

    mockDeps.getGlobalCcxtTickers = () => ({
      weex: {
        'BTC/USDT': { last: 64200 }
      }
    });

    await expect(manageActiveTrades(mockDeps)).resolves.not.toThrow();
    expect(getOtePendingCandidates().length).toBe(0);
  });
});

describe('expertAdvisorService', () => {
  it('executes rule-based fallback DCA in drawdown', async () => {
    const trade: any = {
      id: 'trade_fallback_1',
      symbol: 'ETH/USDT',
      side: 'SHORT',
      entryPrice: 3000,
      amount: 100,
      leverage: 5,
      status: 'OPEN',
      mode: 'AUTO',
      history: []
    };

    const saved: any[] = [];
    const emitted: string[] = [];

    const deps: ExpertAdvisorDependencies = {
      getVirtualTrades: () => [trade],
      getGlobalSettings: () => ({ isAiExpertTraderEnabled: true }),
      getGlobalCcxtTickers: () => ({}),
      getGlobalTrueOhlcv: () => ({
        ETHUSDT: { isSarBearishFlipped15m: true, rsi15m: 72 }
      }),
      getAiKnowledgeBase: () => [],
      getVirtualBalance: () => 500,
      readLocalDB: () => ({ retrospectiveMemory: [] }),
      saveTradeDB: vi.fn(async (t) => { saved.push(t); }),
      emitSignalsUpdated: vi.fn(() => { emitted.push('signals_updated'); }),
      sendTelegramMessage: vi.fn(),
      executeRealCloseOnExchange: vi.fn(),
      executeRealPartialCloseOnExchange: vi.fn(),
      executeRealOpenOnExchange: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn().mockResolvedValue(true),
      runAiGeneration: vi.fn()
    };

    // Current price 3080 (+2.67% against short, pnl -13.3%)
    await executeRuleBasedTradeFallback(trade, 3080, -13.3, -13.3, 500, false, deps);

    expect(trade.amount).toBe(150); // 100 + 50
    expect(trade.lastAiAction).toBe('DCA');
    expect(deps.saveTradeDB).toHaveBeenCalled();
    expect(deps.emitSignalsUpdated).toHaveBeenCalled();
  });
});
