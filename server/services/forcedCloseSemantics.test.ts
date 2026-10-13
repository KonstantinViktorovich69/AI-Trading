import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { isOperationalTrade, calculateOperationalWinRate } from './tradeMetrics.ts';
import { createPaperTradeRouter, type PaperTradeRouterContext } from '../routes/paperTradeRoutes.ts';
import { findTickerInMap, normalizeSymbol } from '../utils/symbolUtils.ts';

describe('Forced close semantics & operational trade filtering', () => {
  describe('1) isOperationalTrade filtering semantics', () => {
    it('returns false for trades with isForcedReset, isSystemCleanup, or closeReasonCode === FORCED_RESET, and true for regular paper trades', () => {
      const regularPaperTrade = {
        id: 't-normal',
        symbol: 'BTC/USDT',
        status: 'CLOSED',
        dataOrigin: 'PAPER',
        entryPrice: 100,
        closePrice: 105,
        pnl: 5,
        pnlPercent: 5
      };
      expect(isOperationalTrade(regularPaperTrade)).toBe(true);

      const forcedResetTrade = {
        ...regularPaperTrade,
        id: 't-forced-reset',
        isForcedReset: true
      };
      expect(isOperationalTrade(forcedResetTrade)).toBe(false);

      const systemCleanupTrade = {
        ...regularPaperTrade,
        id: 't-system-cleanup',
        isSystemCleanup: true
      };
      expect(isOperationalTrade(systemCleanupTrade)).toBe(false);

      const codeForcedResetTrade = {
        ...regularPaperTrade,
        id: 't-code-forced-reset',
        closeReasonCode: 'FORCED_RESET'
      };
      expect(isOperationalTrade(codeForcedResetTrade)).toBe(false);
    });
  });

  describe('2) calculateOperationalWinRate excludes forced / cleanup trades', () => {
    it('does not count forced reset or system cleanup trades in operational win rate stats', () => {
      const trades = [
        { id: '1', dataOrigin: 'PAPER', status: 'CLOSED', pnl: 20 },
        { id: '2', dataOrigin: 'PAPER', status: 'CLOSED', pnl: -10 },
        { id: '3', dataOrigin: 'PAPER', status: 'CLOSED', pnl: 0, isForcedReset: true },
        { id: '4', dataOrigin: 'PAPER', status: 'CLOSED', pnl: -15, isSystemCleanup: true },
        { id: '5', dataOrigin: 'PAPER', status: 'CLOSED', pnl: 30, closeReasonCode: 'FORCED_RESET' }
      ];

      const stats = calculateOperationalWinRate(trades);
      expect(stats.total).toBe(2);
      expect(stats.wins).toBe(1);
      expect(stats.losses).toBe(1);
      expect(stats.winRate).toBe(50);
    });
  });

  describe('3) Router POST /paper-trade/balance/update WEEX ticker semantics', () => {
    function setupApp(virtualTrades: any[], ccxtTickers: any) {
      let balance = 1000;
      let startOfDay = 1000;
      let startOfWeek = 1000;

      const fakeCtx: PaperTradeRouterContext = {
        getVirtualTrades: () => virtualTrades,
        getVirtualBalance: () => balance,
        setVirtualBalance: (bal: number) => { balance = bal; },
        getStartOfDayBalance: () => startOfDay,
        setStartOfDayBalance: (bal: number) => { startOfDay = bal; },
        getStartOfDayRealBalance: () => 0,
        setStartOfDayRealBalance: () => {},
        getStartOfWeekBalance: () => startOfWeek,
        setStartOfWeekBalance: (bal: number) => { startOfWeek = bal; },
        getIsCircuitBreakerActive: () => false,
        setIsCircuitBreakerActive: () => {},
        getLastBtcShockTime: () => 0,
        getGlobalSettings: () => ({ uiStatsResetTimestamp: 0 }),
        getWsTickers: () => ({}),
        getGlobalCcxtTickers: () => ccxtTickers,
        getSignalsData: () => [],
        getModelWeights: () => ({}),
        getAtomicStoreRevision: () => 1,
        saveTradeDB: vi.fn().mockResolvedValue(undefined),
        saveBalanceDB: vi.fn(),
        normalizeSymbol,
        findTickerInMap,
        validatePaperTradeInput: () => ({ valid: true }),
        acquireExecutionLock: () => true,
        releaseExecutionLock: () => {},
        executeRealOpenOnExchange: vi.fn().mockResolvedValue({}),
        getUnifiedTradeClosePnl: (side, entry, close, amount, leverage) => {
          const mult = side === 'LONG' ? (close - entry) / entry : (entry - close) / entry;
          return { pnlUsd: amount * mult * (leverage || 1), feeUsd: 0 };
        },
        getExchangeLink: () => '',
        getTradingAdvice: () => '',
        getChartImageHtml: () => '',
        sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
        streamEmitter: { emit: vi.fn().mockReturnValue(true) },
        log400: vi.fn()
      };

      const app = express();
      app.use(express.json());
      app.use('/', createPaperTradeRouter(fakeCtx));
      return { app, fakeCtx, getBalance: () => balance };
    }

    async function makeRequest(app: express.Express, path: string, body: any) {
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const addr = server.address() as any;
      const port = addr.port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        return { status: res.status, data };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    it('closes with WEEX ticker price, closePriceSource=TICKER, and forced reset flags when WEEX ticker is present', async () => {
      const trades: any[] = [
        {
          id: 'trade-weex',
          symbol: 'BTC/USDT',
          status: 'OPEN',
          isReal: false,
          entryPrice: 100,
          amount: 50,
          leverage: 1,
          side: 'LONG'
        }
      ];
      const ccxt = {
        weex: {
          'BTC/USDT': { last: 135, price: 135, close: 135 }
        }
      };

      const { app } = setupApp(trades, ccxt);
      const res = await makeRequest(app, '/paper-trade/balance/update', {
        amount: 2500,
        closeActiveTrades: true
      });

      expect(res.status).toBe(200);
      expect(trades[0].status).toBe('CLOSED');
      expect(trades[0].closePrice).toBe(135);
      expect(trades[0].closePriceSource).toBe('TICKER');
      expect(trades[0].isForcedReset).toBe(true);
      expect(trades[0].closeReasonCode).toBe('FORCED_RESET');
      expect(trades[0].closeReason).toBe('FORCED_RESET: Сделка принудительно закрыта при смене виртуального баланса');
    });

    it('ignores Binance ticker and closes by entryPrice with closePriceSource=ENTRY_FALLBACK when only Binance ticker exists', async () => {
      const trades: any[] = [
        {
          id: 'trade-binance-only',
          symbol: 'ETH/USDT',
          status: 'OPEN',
          isReal: false,
          entryPrice: 200,
          amount: 50,
          leverage: 1,
          side: 'LONG'
        }
      ];
      const ccxt = {
        binance: {
          'ETH/USDT': { last: 250 }
        }
      };

      const { app } = setupApp(trades, ccxt);
      const res = await makeRequest(app, '/paper-trade/balance/update', {
        amount: 2500,
        closeActiveTrades: true
      });

      expect(res.status).toBe(200);
      expect(trades[0].status).toBe('CLOSED');
      expect(trades[0].closePrice).toBe(200); // entryPrice fallback
      expect(trades[0].closePriceSource).toBe('ENTRY_FALLBACK');
      expect(trades[0].isForcedReset).toBe(true);
      expect(trades[0].closeReasonCode).toBe('FORCED_RESET');
      expect(trades[0].closeReason).toBe('FORCED_RESET: Сделка принудительно закрыта при смене виртуального баланса');
    });

    it('closes by entryPrice with closePriceSource=ENTRY_FALLBACK when no tickers exist', async () => {
      const trades: any[] = [
        {
          id: 'trade-no-tickers',
          symbol: 'SOL/USDT',
          status: 'OPEN',
          isReal: false,
          entryPrice: 50,
          amount: 50,
          leverage: 1,
          side: 'LONG'
        }
      ];
      const ccxt = {};

      const { app } = setupApp(trades, ccxt);
      const res = await makeRequest(app, '/paper-trade/balance/update', {
        amount: 3000,
        closeActiveTrades: true
      });

      expect(res.status).toBe(200);
      expect(trades[0].status).toBe('CLOSED');
      expect(trades[0].closePrice).toBe(50);
      expect(trades[0].closePriceSource).toBe('ENTRY_FALLBACK');
      expect(trades[0].isForcedReset).toBe(true);
      expect(trades[0].closeReasonCode).toBe('FORCED_RESET');
    });
  });

  describe('4) Router POST /paper-trade/close with closePrice <= 0', () => {
    function setupApp(virtualTrades: any[], ccxtTickers: any) {
      const fakeCtx: PaperTradeRouterContext = {
        getVirtualTrades: () => virtualTrades,
        getVirtualBalance: () => 1000,
        setVirtualBalance: () => {},
        getStartOfDayBalance: () => 1000,
        setStartOfDayBalance: () => {},
        getStartOfDayRealBalance: () => 0,
        setStartOfDayRealBalance: () => {},
        getStartOfWeekBalance: () => 1000,
        setStartOfWeekBalance: () => {},
        getIsCircuitBreakerActive: () => false,
        setIsCircuitBreakerActive: () => {},
        getLastBtcShockTime: () => 0,
        getGlobalSettings: () => ({}),
        getWsTickers: () => ({}),
        getGlobalCcxtTickers: () => ccxtTickers,
        getSignalsData: () => [],
        getModelWeights: () => ({}),
        getAtomicStoreRevision: () => 1,
        saveTradeDB: vi.fn().mockResolvedValue(undefined),
        saveBalanceDB: vi.fn(),
        normalizeSymbol,
        findTickerInMap,
        validatePaperTradeInput: () => ({ valid: true }),
        acquireExecutionLock: () => true,
        releaseExecutionLock: () => {},
        executeRealOpenOnExchange: vi.fn().mockResolvedValue({}),
        getUnifiedTradeClosePnl: (side, entry, close, amount, leverage) => {
          const mult = side === 'LONG' ? (close - entry) / entry : (entry - close) / entry;
          return { pnlUsd: amount * mult * (leverage || 1), feeUsd: 0 };
        },
        getExchangeLink: () => '',
        getTradingAdvice: () => '',
        getChartImageHtml: () => '',
        sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
        streamEmitter: { emit: vi.fn().mockReturnValue(true) },
        log400: vi.fn()
      };

      const app = express();
      app.use(express.json());
      app.use('/', createPaperTradeRouter(fakeCtx));
      return { app };
    }

    async function makeRequest(app: express.Express, path: string, body: any) {
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const addr = server.address() as any;
      const port = addr.port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        return { status: res.status, data };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    it('takes price from WEEX ticker when closePrice is 0 and WEEX ticker is available', async () => {
      const trades: any[] = [
        {
          id: 'trade-manual-close-weex',
          symbol: 'BTC/USDT',
          status: 'OPEN',
          isReal: false,
          entryPrice: 100,
          amount: 50,
          leverage: 1,
          side: 'LONG'
        }
      ];
      const ccxt = {
        weex: {
          'BTC/USDT': { last: 142 }
        }
      };

      const { app } = setupApp(trades, ccxt);
      const res = await makeRequest(app, '/paper-trade/close', {
        id: 'trade-manual-close-weex',
        closePrice: 0
      });

      expect(res.status).toBe(200);
      expect(trades[0].status).toBe('CLOSED');
      expect(trades[0].closePrice).toBe(142);
    });

    it('falls back to entryPrice when closePrice is 0 and no WEEX ticker is available (even if Binance has ticker)', async () => {
      const trades: any[] = [
        {
          id: 'trade-manual-close-no-weex',
          symbol: 'ETH/USDT',
          status: 'OPEN',
          isReal: false,
          entryPrice: 300,
          amount: 50,
          leverage: 1,
          side: 'LONG'
        }
      ];
      const ccxt = {
        binance: {
          'ETH/USDT': { last: 350 }
        }
      };

      const { app } = setupApp(trades, ccxt);
      const res = await makeRequest(app, '/paper-trade/close', {
        id: 'trade-manual-close-no-weex',
        closePrice: 0
      });

      expect(res.status).toBe(200);
      expect(trades[0].status).toBe('CLOSED');
      expect(trades[0].closePrice).toBe(300); // entryPrice fallback
    });
  });
});
