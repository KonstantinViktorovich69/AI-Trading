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
});
