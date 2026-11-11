import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { createRealTradeRouter } from '../routes/realTradeRoutes.ts';
import { createPaperTradeRouter } from '../routes/paperTradeRoutes.ts';
import { getUnifiedTradeClosePnl } from '../quant.ts';
import { getCostModel } from './costModel.ts';
import { createDefaultGlobalSettings } from './settingsManager.ts';

async function withServer(router: express.Router, mountPath: string, fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}${mountPath}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('D2 — Unified costModel parity across ALL trade close paths', () => {
  const settings = createDefaultGlobalSettings();
  const costModel = getCostModel(settings);
  const entryPrice = 2000;
  const closePrice = 2100;
  const amount = 200;
  const leverage = 5;
  const side = 'LONG';

  it('produces identical pnlUsd and v2 cost breakdown across paper close, balance update close, real sync close, and direct engine calculation', async () => {
    const directRes = getUnifiedTradeClosePnl(side, entryPrice, closePrice, amount, leverage, costModel);

    // 1. Paper trade manual close (/api/paper-trade/close)
    const manualTrade: any = {
      id: 'PARITY-PAPER-CLOSE',
      symbol: 'ETH/USDT',
      side,
      entryPrice,
      amount,
      leverage,
      status: 'OPEN',
      isReal: false,
      openTime: Date.now() - 60_000,
      history: [{ time: Date.now() - 60_000, type: 'OPEN', price: entryPrice, amount }]
    };

    // 2. Paper trade balance update close (/api/paper-trade/balance/update with closeActiveTrades: true)
    const balanceResetTrade: any = {
      id: 'PARITY-BAL-RESET',
      symbol: 'ETH/USDT',
      side,
      entryPrice,
      amount,
      leverage,
      status: 'OPEN',
      isReal: false,
      openTime: Date.now() - 60_000,
      history: [{ time: Date.now() - 60_000, type: 'OPEN', price: entryPrice, amount }]
    };

    let virtualBalance = 1000;
    const makePaperRouter = (tradesList: any[]) =>
      createPaperTradeRouter({
        getVirtualTrades: () => tradesList,
        getVirtualBalance: () => virtualBalance,
        setVirtualBalance: (b: number) => {
          virtualBalance = b;
        },
        getStartOfDayBalance: () => 1000,
        setStartOfDayBalance: vi.fn(),
        getStartOfDayRealBalance: () => 0,
        setStartOfDayRealBalance: vi.fn(),
        getStartOfWeekBalance: () => 1000,
        setStartOfWeekBalance: vi.fn(),
        getIsCircuitBreakerActive: () => false,
        setIsCircuitBreakerActive: vi.fn(),
        getLastBtcShockTime: () => 0,
        getGlobalSettings: () => settings,
        getWsTickers: () => ({}),
        getGlobalCcxtTickers: () => ({ weex: { 'ETH/USDT': { last: closePrice } } }),
        getSignalsData: () => [],
        getModelWeights: () => ({}),
        getAtomicStoreRevision: () => 1,
        saveTradeDB: vi.fn(async () => {}),
        saveBalanceDB: vi.fn(),
        normalizeSymbol: (s: string) => s.replace(/[/:]/g, '').toUpperCase(),
        findTickerInMap: (sym: string, map: any) => map?.[sym] || null,
        validatePaperTradeInput: (i: any) => ({ valid: true, value: i }),
        acquireExecutionLock: () => true,
        releaseExecutionLock: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        getUnifiedTradeClosePnl: (s, ep, cp, a, l, cm) => getUnifiedTradeClosePnl(s, ep, cp, a, l, cm),
        getExchangeLink: () => '',
        getTradingAdvice: () => '',
        getChartImageHtml: () => '',
        sendTelegramMessage: vi.fn(async () => {}),
        streamEmitter: { emit: vi.fn(() => true) },
        log400: vi.fn()
      });

    await withServer(makePaperRouter([manualTrade]), '/api', async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/paper-trade/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'PARITY-PAPER-CLOSE', closePrice })
      });
      expect(resp.status).toBe(200);
    });

    await withServer(makePaperRouter([balanceResetTrade]), '/api', async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/paper-trade/balance/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 500, closeActiveTrades: true })
      });
      expect(resp.status).toBe(200);
    });

    // 3. Real trade external sync close (/api/real-trade/positions)
    const syncedRealTrade: any = {
      id: 'PARITY-REAL-SYNC',
      symbol: 'ETH/USDT',
      side,
      entryPrice,
      amount,
      initialAmount: amount,
      leverage,
      status: 'OPEN',
      isReal: true,
      openTime: Date.now() - 120_000, // > 20s eligibility threshold
      history: [{ time: Date.now() - 120_000, type: 'OPEN', price: entryPrice, amount }]
    };

    const settingsWithExchange = {
      ...settings,
      exchangeApiConfig: { exchange: 'weex', apiKey: 'k', apiSecret: 's', password: 'p', isEnabled: true }
    };

    const mockCcxtClient = {
      has: { fetchOpenOrders: false, fetchMyTrades: true, fetchClosedOrders: false },
      fetchPositions: vi.fn(async () => []), // position closed externally
      fetchMyTrades: vi.fn(async () => [{ timestamp: Date.now(), side: 'sell', price: closePrice }])
    };

    const realRouter = createRealTradeRouter({
      getGlobalSettings: () => settingsWithExchange,
      getVirtualTrades: () => [syncedRealTrade],
      saveTradeDB: vi.fn(),
      sendTelegramMessage: vi.fn(async () => {}),
      sendTelegramTestMessage: vi.fn(async () => ({ success: true })),
      enrichExchangeError: (e: any) => String(e),
      getCcxtClient: () => mockCcxtClient,
      getUnifiedTradeClosePnl: (s, ep, cp, a, l, cm) => getUnifiedTradeClosePnl(s, ep, cp, a, l, cm),
      findTickerInMap: (sym: string, map: any) => map?.[sym] || null,
      getWsTickers: () => ({}),
      getGlobalCcxtTickers: () => ({ weex: { 'ETH/USDT': { last: closePrice } } }),
      getTradeSyncAttempts: () => new Map(),
      getRealPositionsCache: () => ({ data: [], lastUpdated: 0 }),
      setRealPositionsCache: vi.fn()
    });

    await withServer(realRouter, '/api', async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/real-trade/positions`);
      expect(resp.status).toBe(200);
    });

    // All paths must use costModelVersion=2 (0.16% notional cost = $1.60 on $1000 notional) and match exactly
    for (const closed of [manualTrade, balanceResetTrade, syncedRealTrade]) {
      expect(closed.status).toBe('CLOSED');
      expect(closed.costModelVersion).toBe(2);
      expect(closed.pnl).toBeCloseTo(directRes.pnlUsd, 8);
      expect(closed.grossPnlUsd).toBeCloseTo(directRes.grossPnlUsd, 8);
      expect(closed.feeUsd).toBeCloseTo(directRes.feeUsd, 8);
      expect(closed.slippageUsd).toBeCloseTo(directRes.slippageUsd, 8);
      expect(closed.pnlPercent).toBeCloseTo((directRes.pnlUsd / amount) * 100, 8);
    }
  });
});
