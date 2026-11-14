import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { evaluateStrategySignal, type StrategyContext } from './strategyEngine.ts';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';
import { incFunnel, resetFunnelForTest } from './funnelCounters.ts';
import { ExchangeWsManager } from './exchangeWsManager.ts';
import { createAiRoutes } from '../routes/aiRoutes.ts';
import { evaluateExitPolicy } from './exitPolicy.ts';
import { computeQuantFeaturesV2 } from './quantFeaturesV2.ts';

function requestJson(server: http.Server, method: string, urlPath: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode || 0, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Audit Fixes Regression Suite (P0/P1/P2)', () => {
  beforeEach(() => {
    resetFunnelForTest();
  });

  it('quantFeaturesV2 falls back to indicators.updatedAt when timestamp/lastUpdated are omitted', () => {
    const pastTs = Date.now() - 12_000;
    const features = computeQuantFeaturesV2({
      symbol: 'BTCUSDT',
      price: 65000,
      volume: 1000000,
      trueOhlcv: {
        BTCUSDT: { updatedAt: pastTs, rsi1h: 62, volumeSpike: 2.5 }
      }
    });
    expect(features.hadIndicators).toBe(true);
    expect(features.ageSec).toBeGreaterThanOrEqual(10);
    expect(features.ageSec).toBeLessThan(60);
  });

  it('strategyEngine wires activeStrategy modulation for TREND_FOLLOWING vs SHORT_PUMP_FADE', () => {
    const baseCtx: StrategyContext = {
      symbol: 'SOLUSDT',
      marketType: 'FUTURES',
      tradingMode: 'FUTURES',
      price: 150,
      high: 155,
      low: 147,
      open: 148,
      vwap: 149,
      sar: 146,
      rsi: 40,
      change24h: -3.5,
      volume24h: 2500000,
      avgVolume: 800000,
      bidSpreadPct: 0.0005,
      fundingRate: 0.0001,
      htfTrend: 'BULLISH'
    };

    const trendRes = evaluateStrategySignal({
      ...baseCtx,
      activeStrategy: 'TREND_FOLLOWING'
    });
    expect(trendRes.side).toBe('LONG');
    expect(trendRes.gateDiagnostics.strategy_TREND_FOLLOWING).toBe(true);
    expect(trendRes.gateDiagnostics.trendFollowingAligned).toBe(true);

    const counterTrendRes = evaluateStrategySignal({
      ...baseCtx,
      sar: 156,
      vwap: 152,
      htfTrend: 'BULLISH',
      side: 'SHORT',
      action: 'SELL',
      activeStrategy: 'TREND_FOLLOWING'
    });
    expect(counterTrendRes.gateDiagnostics.trendFollowingAligned).toBe(false);
  });

  it('signalPerformanceAnalyticsService reports 0% agent accuracy when zero votes, uses real funnel counters, and avoids modulo simulation', () => {
    incFunnel('risk_gate', 'VOLATILITY_BRAKE', 'ETHUSDT');
    incFunnel('committee', 'BEAR_VETO', 'SOLUSDT');
    incFunnel('seen', 'SCANNED', 'BTCUSDT');

    const trades = [
      {
        id: 'oos-1',
        symbol: 'BTC/USDT',
        side: 'SHORT',
        status: 'CLOSED',
        entryPrice: 60000,
        closePrice: 61000,
        highestPrice: 61200,
        lowestPrice: 59900,
        stopLoss: 61000,
        amount: 100,
        leverage: 5,
        pnl: -10,
        pnlPercent: -8.33,
        closeReasonCode: 'STOP_LOSS',
        marketRegime: 'TREND_UP',
        openTime: Date.now() - 100000,
        closeTime: Date.now()
      }
    ];

    const report = SignalPerformanceAnalyticsService.generatePerformanceReport(trades);

    // Zero votes -> 0% accuracy (no fake 75%)
    expect(report.combined.byAgent.scout_agent.totalVotes).toBe(0);
    expect(report.combined.byAgent.scout_agent.accuracy).toBe(0);
    expect(report.combined.byAgent.scout_agent.avgConfidence).toBe(0);

    // Real excursion calculated from highestPrice/lowestPrice
    expect(report.rawAuditedTrades[0].maePct).toBeCloseTo(10, 1);

    // No modulo factor fabrication when decisionTrace.factors is absent
    const totalFactorTrades = Object.values(report.combined.byFactorCombinations).reduce((s, m) => s + m.totalTrades, 0);
    expect(totalFactorTrades).toBe(0);

    // Real funnel counts in Q9
    expect(report.analyticalReport.question9_filterAnalysis.riskSentinelBlocks).toBe(1);
    expect(report.analyticalReport.question9_filterAnalysis.consensusRejections).toBe(1);
    expect(report.analyticalReport.question9_filterAnalysis.totalSignalsFilteredOut).toBe(2);

    // Dynamic loss precursors in Q10
    expect(report.analyticalReport.question10_lossPrecursors.length).toBe(3);
    expect(report.analyticalReport.question10_lossPrecursors[0].frequencyInLossesPct).toBe(100);
    expect(report.analyticalReport.question10_lossPrecursors[1].frequencyInLossesPct).toBe(100);
    expect(report.analyticalReport.question10_lossPrecursors[2].frequencyInLossesPct).toBe(100);
  });

  it('ExchangeWsManager processes WEEX V3 ticker frames and updates WEEX/Weex tickers + watchdog status', () => {
    const wsTickers: any = { Kraken: {}, Kucoin: {}, Bitget: {}, Gateio: {}, OKX: {}, HTX: {}, WEEX: {}, Weex: {} };
    const globalCcxtTickers: any = { weex: {} };
    const candleCalls: any[] = [];
    let emitCalls = 0;

    const mgr = new ExchangeWsManager({
      getPairs: () => ['BTC/USDT'],
      getExchangeSymbols: () => ({}),
      getWsTickers: () => wsTickers,
      getGlobalCcxtTickers: () => globalCcxtTickers,
      getGlobalLiquidations: () => ({}),
      getGlobalWhales: () => ({}),
      getGlobalPumps: () => new Set(),
      getGlobalCvd: () => ({}),
      getCacheSignals: () => ({}),
      getVirtualTrades: () => [],
      throttlePriceEmit: () => { emitCalls++; },
      getExchangeLink: (_ex, pair) => `https://www.weex.com/trade/${pair.replace('/', '_')}`,
      updateLocalCandlesForSymbol: (cleanSym, finalPrice, volumeDelta) => {
        candleCalls.push({ cleanSym, finalPrice, volumeDelta });
      },
      updateSignalsCache: () => {}
    });

    mgr.handleIncomingMessage(JSON.stringify({
      stream: 'BTCUSDT@ticker',
      data: { s: 'BTCUSDT', c: '67500.5', b: '67500.0', a: '67501.0', P: '4.25', q: '12500000' }
    }));

    expect(wsTickers.WEEX.BTCUSDT.last).toBe(67500.5);
    expect(wsTickers.Weex['BTC/USDT'].last).toBe(67500.5);
    expect(globalCcxtTickers.weex['BTC/USDT'].last).toBe(67500.5);
    expect(globalCcxtTickers.weex['BTC/USDT']._pctScaled).toBe(true);
    expect(candleCalls).toEqual([{ cleanSym: 'BTCUSDT', finalPrice: 67500.5, volumeDelta: 0 }]);
    expect(emitCalls).toBe(1);

    const status = mgr.getWatchdogStatus();
    expect(status.weex.tickerCount).toBe(1);
    expect(status.weex.url).toBe('wss://ws-contract.weex.com/v3/ws/public');
    mgr.stopAll();
  });

  it('aiRoutes /paper-trade/ai-update respects isDcaEnabled=false, preserves micro-cap precision, and never double-counts margin', async () => {
    let balance = 1000;
    const settings: any = { isDcaEnabled: true, defaultLeverage: 5 };
    const trades: any[] = [
      {
        id: 't-dca-1',
        symbol: '1000PEPEUSDT',
        side: 'SHORT',
        mode: 'AUTO',
        status: 'OPEN',
        isReal: false,
        entryPrice: 0.00001234,
        amount: 200,
        leverage: 10,
        // Note: trade.margin deliberately omitted so margin = 200/10 = 20
        stopLoss: 0.00001300,
        takeProfit: 0.00001100
      }
    ];

    const app = express();
    app.use(express.json());
    app.use('/api', createAiRoutes({
      getGlobalSettings: () => settings,
      getVirtualTrades: () => trades,
      getKnowledgeBase: () => [],
      getSocialSentiment: () => ({}),
      getSignalsCache: () => ({}),
      runAiGeneration: async () => ({ text: '{}' }),
      getSentinelShieldPrompt: () => '',
      getCommitteePrompt: () => '',
      getPositionManagerPrompt: () => '',
      getSignalAnalysisPrompt: () => '',
      getTradeEvaluationPrompt: () => '',
      getRuleTesterPrompt: () => '',
      safeJsonParse: (_s, fb) => fb,
      runDeterministicQuantCommitteeFallback: () => [],
      getBlacklistedPatterns: () => ({}),
      evaluateExitPolicy,
      executePaperTradeCloseTransaction: async () => ({ success: true }),
      dbAtomicStore: {},
      saveTradeDB: () => {},
      saveBalanceDB: () => {},
      sendTelegramMessage: () => {},
      setRealTradeSlTpOnExchange: async () => true,
      logStructured: () => {},
      streamEmitter: { emit: () => true },
      getVirtualBalance: () => balance,
      setVirtualBalance: (v: number) => { balance = v; },
      DEFAULT_BASELINE_EXPERT_INSTRUCTIONS: '',
      getPendingAiTasks: () => new Map(),
      getCachedMarketNews: () => null,
      setCachedMarketNews: () => {},
      getOhlcvCache: () => ({}),
      getPendingChartRequests: () => ({}),
      getCcxtExchanges: () => ({}),
      getRestBlockedExchanges: () => new Set(),
      formatFuturesSymbol: (s) => s,
      getGlobalRawOHLCV: () => ({
        BTCUSDT: {
          '1h': Array.from({ length: 30 }, (_, idx) => [
            Date.now() - (30 - idx) * 3600000,
            60000 + idx * 100,
            60200 + idx * 100,
            59900 + idx * 100,
            idx < 22 ? 60100 + idx * 250 : 65500 - (idx - 22) * 500,
            5000
          ])
        }
      })
    }));

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const dcaRes = await requestJson(server, 'POST', '/api/paper-trade/ai-update', {
        id: 't-dca-1',
        action: 'DCA',
        advice: 'Average into spike',
        currentPrice: 0.00001260
      });
      expect(dcaRes.status).toBe(200);
      // prevMargin = 20 (200/10), dcaAmount = 100, dcaMargin = 10 -> total margin MUST be 30, NOT 40!
      expect(dcaRes.body.data.margin).toBe(30);
      expect(dcaRes.body.data.entryPrice).toBeGreaterThan(0.000012);
      expect(dcaRes.body.data.entryPrice).toBeLessThan(0.0000126);
      expect(balance).toBe(990);

      // Verify isDcaEnabled=false blocks further DCA
      settings.isDcaEnabled = false;
      const blockedRes = await requestJson(server, 'POST', '/api/paper-trade/ai-update', {
        id: 't-dca-1',
        action: 'DCA',
        advice: 'Try again',
        currentPrice: 0.00001280
      });
      expect(blockedRes.body.data.margin).toBe(30);
      expect(balance).toBe(990);

      // Verify offline backtest route works with canonical strategy + exitPolicy using cached OHLCV
      process.env.OFFLINE_MODE = '1';
      const btRes = await requestJson(server, 'POST', '/api/backtest', {
        targets: [{ symbol: 'BTC/USDT', exchange: 'weex' }]
      });
      expect(btRes.status).toBe(200);
      expect(btRes.body.success).toBe(true);
      expect(typeof btRes.body.results.totalTrades).toBe('number');
    } finally {
      server.close();
    }
  });
});
