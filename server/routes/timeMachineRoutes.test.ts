import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createTimeMachineRouter, type TimeMachineRouterContext } from './timeMachineRoutes.ts';

function createMockApp(contextOverrides: Partial<TimeMachineRouterContext> = {}) {
  const app = express();
  app.use(express.json());

  const mockKnowledge: any[] = [];
  const defaultContext: TimeMachineRouterContext = {
    getVirtualTrades: () => [
      {
        id: 'trade_1',
        symbol: 'BTC/USDT:USDT',
        side: 'LONG',
        status: 'CLOSED',
        entryPrice: 50000,
        closePrice: 51000,
        pnlPercent: 10,
        amount: 100,
        leverage: 5,
        matchedPattern: 'Test Pattern'
      }
    ],
    getGlobalTrueOhlcv: () => ({
      BTCUSDT: { rsi: 55, ema50: 49500 } // Object of indicators, NOT candles array
    }),
    getGlobalRawOHLCV: () => ({
      BTCUSDT: {
        '15m': [
          [1000, 50000, 50200, 49800, 50100, 100],
          [2000, 50100, 51200, 50000, 51000, 150]
        ]
      }
    }),
    getGlobalSettings: () => ({
      timeMachineApplyLearningsEnabled: false
    }),
    getAiKnowledgeBase: () => mockKnowledge,
    saveKnowledgeDB: vi.fn(),
    emitSignalsUpdated: vi.fn(),
    ...contextOverrides
  };

  const router = createTimeMachineRouter(defaultContext);
  app.use('/api', router);
  return { app, defaultContext, mockKnowledge };
}

describe('timeMachineRoutes (T1.4)', () => {
  it('GET /api/time-machine/summary runs successfully using raw OHLCV without TypeError', async () => {
    const { app } = createMockApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/time-machine/summary`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalAnalyzedTrades).toBe(1);
      expect(json.data.simulatedTradesCount).toBe(1);
      expect(json.data.skippedTradesCount).toBe(0);
    } finally {
      server.close();
    }
  });

  it('GET /api/time-machine/trade/:id marks trade skipped: NO_CANDLES when raw candles missing', async () => {
    const { app } = createMockApp({
      getGlobalRawOHLCV: () => ({}) // Empty raw candles
    });
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/time-machine/trade/trade_1`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.skipped).toBe('NO_CANDLES');
      expect(json.data.recommendedAction).toContain('Пропущено');
    } finally {
      server.close();
    }
  });

  it('POST /api/time-machine/apply-learnings returns 409 when flag is disabled (default)', async () => {
    const { app, defaultContext } = createMockApp({
      getGlobalSettings: () => ({ timeMachineApplyLearningsEnabled: false })
    });
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/time-machine/apply-learnings`, {
        method: 'POST'
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('timeMachineApplyLearningsEnabled=false');
      expect(defaultContext.saveKnowledgeDB).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('POST /api/time-machine/apply-learnings computes dynamic stats when enabled', async () => {
    const saveMock = vi.fn();
    const { app } = createMockApp({
      getGlobalSettings: () => ({ timeMachineApplyLearningsEnabled: true }),
      saveKnowledgeDB: saveMock
    });
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/time-machine/apply-learnings`, {
        method: 'POST'
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    } finally {
      server.close();
    }
  });
});
