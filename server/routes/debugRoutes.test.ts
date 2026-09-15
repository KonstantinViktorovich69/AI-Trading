import { describe, it, expect, vi } from 'vitest';
import { createDebugRouter, type DebugRouterContext } from './debugRoutes.ts';

describe('Debug Router Handlers', () => {
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

  const getHandler = (router: any, path: string, method: string) => {
    const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
    if (!layer) throw new Error(`Route ${method} ${path} not found`);
    return layer.route.stack[0].handle;
  };

  const mockContext: DebugRouterContext = {
    getGlobalTrueOhlcv: vi.fn().mockReturnValue({
      BTCUSDT: {
        sar: 65000,
        rsi1h: 60,
        vwap: 64800,
        psarStatus1m: 'BEARISH',
        isSarBearishFlipped1m: true,
        wicks: { topPct: 0.4, bottomPct: 0.1, bodySize: 100 },
        volumeSpike: 1.2
      }
    }),
    getGlobalCcxtTickers: vi.fn().mockReturnValue({
      weex: {
        'BTC/USDT:USDT': {
          symbol: 'BTC/USDT:USDT',
          last: 65000,
          high: 66000,
          low: 64000,
          percentage: 5.5,
          quoteVolume: 1000000
        }
      },
      mexc: {
        'BTC/USDT': { symbol: 'BTC/USDT', last: 65000 }
      }
    }),
    getGlobalSettings: vi.fn().mockReturnValue({
      autopilotAggressiveness: 'moderate',
      isEma200FilterEnabled: false,
      isLiquiditySweepFilterEnabled: false,
      isLateShortFilterEnabled: false
    }),
    getAiKnowledgeBase: vi.fn().mockReturnValue([]),
    getVirtualTrades: vi.fn().mockReturnValue([]),
    getSignalsCache: vi.fn().mockReturnValue({
      data: [{ symbol: 'BTC/USDT:USDT', signal: 'SHORT' }]
    }),
    updateTrueOHLCV: vi.fn().mockResolvedValue(undefined),
    updateSignalsCache: vi.fn().mockResolvedValue(undefined),
    isWeexApiSupported: vi.fn().mockReturnValue(true),
    runAiGeneration: vi.fn().mockResolvedValue({ text: '[]' }),
    safeJsonParse: vi.fn().mockReturnValue([]),
    generateProgrammaticCommitteeFallback: vi.fn().mockReturnValue({
      bullVerdict: 'Test Bull',
      bearVerdict: 'Test Bear',
      judgeVerdict: 'Test Judge',
      aiScore: 75,
      finalVerdict: 'SHORT'
    })
  };

  const router = createDebugRouter(mockContext);

  it('handles GET /debug-ohlcv', async () => {
    const handler = getHandler(router, '/debug-ohlcv', 'get');
    const req: any = {};
    const res = createMockRes();
    await handler(req, res);

    expect(res.json).toHaveBeenCalled();
    expect(res.jsonData.total).toBe(1);
    expect(res.jsonData.sample).toContain('BTCUSDT');
  });

  it('handles GET /debug/run-ohlcv', async () => {
    const handler = getHandler(router, '/debug/run-ohlcv', 'get');
    const req: any = {};
    const res = createMockRes();
    await handler(req, res);

    expect(res.jsonData.success).toBe(true);
    expect(mockContext.updateTrueOHLCV).toHaveBeenCalled();
  });

  it('handles GET /debug/run-signals', async () => {
    const handler = getHandler(router, '/debug/run-signals', 'get');
    const req: any = {};
    const res = createMockRes();
    await handler(req, res);

    expect(res.jsonData.success).toBe(true);
    expect(mockContext.updateSignalsCache).toHaveBeenCalled();
  });

  it('handles GET /debug/diagnose-signals', async () => {
    const handler = getHandler(router, '/debug/diagnose-signals', 'get');
    const req: any = {};
    const res = createMockRes();
    await handler(req, res);

    expect(res.jsonData.success).toBe(true);
    expect(Array.isArray(res.jsonData.diagnostics)).toBe(true);
    expect(res.jsonData.diagnostics[0].symbol).toBe('BTCUSDT');
  });

  it('handles GET /debug-mexc', async () => {
    const handler = getHandler(router, '/debug-mexc', 'get');
    const req: any = {};
    const res = createMockRes();
    await handler(req, res);

    expect(res.jsonData.mexcTickersCount).toBe(1);
  });

  it('handles POST /debug/inject-test-signal', async () => {
    const handler = getHandler(router, '/debug/inject-test-signal', 'post');
    const req: any = { body: { symbol: 'ETHUSDT', direction: 'SHORT', force: true } };
    const res = createMockRes();
    await handler(req, res);

    expect(res.jsonData.success).toBe(true);
    expect(res.jsonData.message).toContain('ETHUSDT');
  });
});
