import { describe, it, expect, vi, afterEach } from 'vitest';
import { createExpressApp } from './expressAppFactory.ts';
import http from 'http';

describe('createExpressApp production debug routes guard', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  const mockContexts: any = {
    realTradeContext: {},
    marketContext: {},
    streamContext: {},
    aiContext: {},
    paperTradeContext: {},
    knowledgeContext: {},
    settingsContext: {},
    systemContext: {},
    debugContext: {
      getGlobalTrueOhlcv: vi.fn().mockReturnValue({}),
      getGlobalCcxtTickers: vi.fn().mockReturnValue({}),
      getGlobalSettings: vi.fn().mockReturnValue({}),
      getAiKnowledgeBase: vi.fn().mockReturnValue([]),
      getGlobalProlivPeaks: vi.fn().mockReturnValue([]),
      triggerTrueOhlcvUpdate: vi.fn(),
      triggerSignalsScan: vi.fn(),
      triggerDiagnoseSignals: vi.fn(),
      triggerForceScan: vi.fn(),
      triggerTestSignalInjection: vi.fn()
    }
  };

  it('returns 404 for /api/debug/* routes when NODE_ENV === production', async () => {
    process.env.NODE_ENV = 'production';
    const app = createExpressApp(mockContexts);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as any;
    const port = address.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/debug/run-signals`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('API endpoint not found');

      const resOhlcv = await fetch(`http://127.0.0.1:${port}/api/debug-ohlcv`);
      expect(resOhlcv.status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('allows /health in production', async () => {
    process.env.NODE_ENV = 'production';
    const app = createExpressApp(mockContexts);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as any;
    const port = address.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('creates express app, listens and responds to health check', async () => {
    const dummyRouterContext: any = {
      getSignalsCache: () => ({ data: [] }),
      getMarketPulse: () => ({}),
      getSocialSentiment: () => ({}),
      getVirtualTrades: () => [],
      getVirtualBalance: () => 1000,
      getProlivPeaks: () => [],
      getAgentExchangeLogs: () => [],
      getCachedDB: () => ({}),
      getWsTickers: () => ({}),
      getGlobalCcxtTickers: () => ({}),
      findTickerInMap: () => null,
      streamEmitter: { on: vi.fn(), emit: vi.fn() },
      getFundingRates: () => ({}),
      isFetchingGlobalTickers: () => false,
      updateGlobalTickers: vi.fn(),
      historyData: {},
      globalTrueOhlcv: {},
      serverStartTime: Date.now(),
      getGlobalSettings: () => ({}),
      saveTradeDB: vi.fn(),
      sendTelegramMessage: vi.fn(),
      sendTelegramTestMessage: vi.fn(),
      enrichExchangeError: vi.fn(),
      getCcxtClient: vi.fn(),
      getUnifiedTradeClosePnl: vi.fn(),
      WEEX_HEADERS: {},
      getTradeSyncAttempts: () => new Map(),
      getRealPositionsCache: () => ({ data: [], lastUpdated: 0 }),
      setRealPositionsCache: vi.fn(),
      isRealTradingAllowed: () => false,
      executeRealOpenOnExchange: vi.fn(),
      executeWithRetry: vi.fn(),
      formatFuturesSymbol: (s: string) => s,
      getKnowledgeBase: () => [],
      setKnowledgeBase: vi.fn(),
      saveKnowledgeDB: vi.fn(),
      deleteKnowledgeDB: vi.fn(),
      getModelWeights: () => ({}),
      getModelStatus: () => ({}),
      runAiGeneration: vi.fn(),
      getArchivistPrompt: vi.fn(),
      getRuleTesterPrompt: vi.fn(),
      safeJsonParse: vi.fn(),
      getJaccardSimilarity: vi.fn(),
      runSmartArchivistCycle: vi.fn(),
      runNewAIPerformanceOptimizationCircuit: vi.fn(),
      requestDBSave: vi.fn(),
      flushDB: vi.fn(),
      syncToFirebase: vi.fn(),
      getDb: () => null,
      isFirebaseFirestoreDisabled: true,
      OWNER_ID: 'test',
      getCommitteeVetoShadowStats: () => ({}),
      getMarketRegime: () => 'FLAT',
      log400: vi.fn(),
      getLastSanitizationStatus: () => ({}),
      setExpertInstructions: vi.fn(),
      getAutopilotFailedSymbols: () => new Set(),
      fetchTelegramChatId: vi.fn(),
      getSettingsOptimizerPrompt: vi.fn(),
      queryStructuredLogs: () => [],
      getCurrentExchangePingMs: () => 50,
      getExchangePingHistory: () => [],
      getAiCommitteeCache: () => ({}),
      getPendingFrontendAiTasks: () => [],
      setPendingFrontendAiTasks: vi.fn(),
      resolvePendingAiTask: vi.fn(),
      getDatabaseRevision: () => 1,
      getEventLoopLagMs: () => 0,
      getWatchdogStatus: () => ({}),
      getServerStartTime: () => Date.now(),
      getLatencyInfo: () => ({ weexLatencyMs: 30, binanceLatencyMs: 20 }),
      getGlobalTrueOhlcv: () => ({}),
      getCcxtExchanges: () => ({}),
      getRestBlockedExchanges: () => new Set(),
      getIsCircuitBreakerActive: () => false,
      setIsCircuitBreakerActive: vi.fn(),
      getLastBtcShockTime: () => 0,
      getStartOfDayBalance: () => 1000,
      setStartOfDayBalance: vi.fn(),
      getStartOfDayRealBalance: () => 1000,
      setStartOfDayRealBalance: vi.fn(),
      getStartOfWeekBalance: () => 1000,
      setStartOfWeekBalance: vi.fn(),
      getSignalsData: () => [],
      getAtomicStoreRevision: () => 1,
      normalizeSymbol: (s: string) => s,
      validatePaperTradeInput: () => ({ isValid: true }),
      acquireExecutionLock: () => true,
      releaseExecutionLock: vi.fn(),
      getExchangeLink: () => '',
      getTradingAdvice: () => ({}),
      getChartImageHtml: () => '',
      getCcxtClientConstructionCount: () => 0,
      getIsBinanceGeoblocked: () => false,
      setIsBinanceGeoblocked: vi.fn()
    };

    const app = createExpressApp({
      realTradeContext: dummyRouterContext,
      marketContext: dummyRouterContext,
      streamContext: dummyRouterContext,
      aiContext: dummyRouterContext,
      paperTradeContext: dummyRouterContext,
      knowledgeContext: dummyRouterContext,
      settingsContext: dummyRouterContext,
      systemContext: dummyRouterContext,
      debugContext: dummyRouterContext
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address: any = server.address();
    const port = address.port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe('ok');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
