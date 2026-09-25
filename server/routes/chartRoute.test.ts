import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAiRoutes, type AiRoutesContext } from './aiRoutes.ts';
import { isWeexApiSupported } from '../data/defaultStrategyKnowledge.ts';

describe('Chart Route - Non-supported WEEX symbol failover & error handling', () => {
  let mockContext: AiRoutesContext;
  let ohlcvCache: Record<string, { data: any[]; timestamp: number }>;
  let pendingChartRequests: Record<string, Promise<any>>;
  let restBlockedExchanges: Set<string>;
  let router: any;

  const createMockRes = () => {
    const res: any = {
      statusCode: 200,
      jsonData: null,
      status: vi.fn().mockImplementation((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: vi.fn().mockImplementation((data: any) => {
        res.jsonData = data;
        return res;
      })
    };
    return res;
  };

  const getHandler = (r: any, path: string, method: string) => {
    const layer = r.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
    if (!layer) throw new Error(`Route ${method} ${path} not found`);
    return layer.route.stack[0].handle;
  };

  beforeEach(() => {
    ohlcvCache = {};
    pendingChartRequests = {};
    restBlockedExchanges = new Set();

    mockContext = {
      getGlobalSettings: vi.fn().mockReturnValue({}),
      getVirtualTrades: vi.fn().mockReturnValue([]),
      getKnowledgeBase: vi.fn().mockReturnValue([]),
      getSocialSentiment: vi.fn().mockReturnValue({}),
      getSignalsCache: vi.fn().mockReturnValue({}),
      runAiGeneration: vi.fn(),
      getSentinelShieldPrompt: vi.fn(),
      getCommitteePrompt: vi.fn(),
      getPositionManagerPrompt: vi.fn(),
      getSignalAnalysisPrompt: vi.fn(),
      getTradeEvaluationPrompt: vi.fn(),
      getRuleTesterPrompt: vi.fn(),
      safeJsonParse: vi.fn(),
      runDeterministicQuantCommitteeFallback: vi.fn(),
      getBlacklistedPatterns: vi.fn().mockReturnValue([]),
      evaluateExitPolicy: vi.fn(),
      executePaperTradeCloseTransaction: vi.fn(),
      dbAtomicStore: {} as any,
      saveTradeDB: vi.fn(),
      saveBalanceDB: vi.fn(),
      sendTelegramMessage: vi.fn(),
      setRealTradeSlTpOnExchange: vi.fn(),
      logStructured: vi.fn(),
      streamEmitter: { emit: vi.fn() },
      getVirtualBalance: vi.fn().mockReturnValue(1000),
      setVirtualBalance: vi.fn(),
      DEFAULT_BASELINE_EXPERT_INSTRUCTIONS: 'Test Instructions',
      getPendingAiTasks: vi.fn().mockReturnValue(new Map()),
      getCachedMarketNews: vi.fn().mockReturnValue(null),
      setCachedMarketNews: vi.fn(),
      getOhlcvCache: () => ohlcvCache,
      getPendingChartRequests: () => pendingChartRequests,
      getCcxtExchanges: vi.fn().mockReturnValue({}),
      getRestBlockedExchanges: () => restBlockedExchanges,
      formatFuturesSymbol: (sym: string, ex: string) => {
        if (ex === 'weex') return sym.includes(':') ? sym : `${sym}:USDT`;
        return sym;
      },
      isWeexApiSupported: (sym: string) => isWeexApiSupported(sym),
      getGlobalRawOHLCV: vi.fn().mockReturnValue({})
    };

    router = createAiRoutes(mockContext);
  });

  it('serves cached candles for MSTU/USDT:USDT directly without hitting un-supported WEEX endpoint', async () => {
    ohlcvCache['weex_MSTU/USDT:USDT_15m'] = {
      data: [{ time: 1700000000, open: 10, high: 12, low: 9, close: 11, volume: 1000 }],
      timestamp: Date.now()
    };

    const handler = getHandler(router, '/chart/:exchange/:symbol*', 'get');
    const req: any = {
      params: { exchange: 'weex', symbol: 'MSTU/USDT:USDT' },
      query: { tf: '15m' }
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.jsonData.success).toBe(true);
    expect(res.jsonData.data).toHaveLength(1);
    expect(res.jsonData.data[0].close).toBe(11);
  });

  it('correctly validates WEEX symbol support via isWeexApiSupported', () => {
    expect(isWeexApiSupported('BTC/USDT')).toBe(true);
    expect(isWeexApiSupported('BTC/USDT:USDT')).toBe(true);
    expect(isWeexApiSupported('1000PEPE/USDT:USDT')).toBe(true);
    expect(isWeexApiSupported('MSTU/USDT:USDT')).toBe(false);
    expect(isWeexApiSupported('MSTU/USDT')).toBe(false);
  });
});
