import { describe, it, expect } from 'vitest';
import { validateMarketSnapshot, resolveTradeMarketMode, createTradeIntent } from './tradeIntentResolver.ts';
import { evaluateStrategySignal, evaluateEntryDecision, CANONICAL_STRATEGY_ID, CANONICAL_STRATEGY_VERSION } from './strategyEngine.ts';
import { runCanonicalAutoEntry, type AutoEntryExecutionPort } from './autoEntryService.ts';
import { type MarketSnapshot, type TradeIntent } from '../types/tradeIntent.ts';

describe('Directional Symmetry & TradeIntent Integrity', () => {
  const validSnapshot: MarketSnapshot = {
    price: 65000,
    high: 65500,
    low: 64800,
    open: 65200,
    vwap: 65100,
    sar: 65400,
    rsi: 48,
    volume24h: 250000,
    avgVolume: 100000,
    change24h: -1.5,
    orderBookImbalance: 0.1
  };

  describe('1. validateMarketSnapshot (Fail-Closed Data Completeness)', () => {
    it('approves complete, valid market snapshot', () => {
      const result = validateMarketSnapshot(validSnapshot);
      expect(result.valid).toBe(true);
    });

    it('rejects missing or non-object snapshots', () => {
      expect(validateMarketSnapshot(null as any).valid).toBe(false);
      expect(validateMarketSnapshot(undefined as any).valid).toBe(false);
    });

    it('rejects snapshots with zero or NaN price', () => {
      expect(validateMarketSnapshot({ ...validSnapshot, price: 0 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, price: NaN }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, price: -10 }).valid).toBe(false);
    });

    it('rejects snapshots with invalid high, low, open, vwap, or sar', () => {
      expect(validateMarketSnapshot({ ...validSnapshot, high: 0 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, low: NaN }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, open: -5 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, vwap: 0 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, sar: NaN }).valid).toBe(false);
    });

    it('rejects snapshots with invalid volume24h or out-of-range rsi', () => {
      expect(validateMarketSnapshot({ ...validSnapshot, volume24h: -1 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, rsi: 105 }).valid).toBe(false);
      expect(validateMarketSnapshot({ ...validSnapshot, rsi: -5 }).valid).toBe(false);
    });
  });

  describe('2. resolveTradeMarketMode (Symmetric Direction & Fail-Closed SPOT SHORT)', () => {
    it('resolves FUTURES SHORT cleanly when FUTURES mode is requested', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'FUTURES', allowedTradingDirections: 'BOTH' },
        { side: 'SHORT', action: 'SELL' }
      );
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.route.resolvedMarketType).toBe('FUTURES');
        expect(res.route.side).toBe('SHORT');
        expect(res.route.action).toBe('SELL');
      }
    });

    it('resolves FUTURES LONG cleanly when FUTURES mode is requested', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'FUTURES', allowedTradingDirections: 'BOTH' },
        { side: 'LONG', action: 'BUY' }
      );
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.route.resolvedMarketType).toBe('FUTURES');
        expect(res.route.side).toBe('LONG');
        expect(res.route.action).toBe('BUY');
      }
    });

    it('strictly fails-closed on SPOT SHORT request without fallback to futures', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'SPOT', allowedTradingDirections: 'BOTH' },
        { side: 'SHORT', action: 'SELL' }
      );
      expect(res.success).toBe(false);
      if (res.success === false) {
        expect(res.rejection.rejected).toBe(true);
        expect(res.rejection.reasonCode).toBe('SPOT_SHORT_UNSUPPORTED');
        expect(res.rejection.reason).toContain('не поддерживает SHORT');
      }
    });

    it('approves SPOT LONG accumulation in SPOT mode', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'SPOT', allowedTradingDirections: 'BOTH' },
        { side: 'LONG', action: 'BUY' }
      );
      expect(res.success).toBe(true);
      if (res.success === true) {
        expect(res.route.resolvedMarketType).toBe('SPOT');
        expect(res.route.side).toBe('LONG');
        expect(res.route.action).toBe('BUY');
      }
    });

    it('enforces LONG_ONLY gate symmetrically against SHORT signals', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'FUTURES', allowedTradingDirections: 'LONG_ONLY' },
        { side: 'SHORT', action: 'SELL' }
      );
      expect(res.success).toBe(false);
      if (res.success === false) {
        expect(res.rejection.reasonCode).toBe('DIRECTION_NOT_ALLOWED');
      }
    });

    it('enforces SHORT_ONLY gate symmetrically against LONG signals', () => {
      const res = resolveTradeMarketMode(
        { requestedMode: 'FUTURES', allowedTradingDirections: 'SHORT_ONLY' },
        { side: 'LONG', action: 'BUY' }
      );
      expect(res.success).toBe(false);
      if (res.success === false) {
        expect(res.rejection.reasonCode).toBe('DIRECTION_NOT_ALLOWED');
      }
    });
  });

  describe('3. createTradeIntent (Lineage & Immutable Intent Creation)', () => {
    it('creates a fully validated TradeIntent with complete metadata', () => {
      const result = createTradeIntent({
        symbol: 'BTCUSDT',
        signal: { id: 'sig_test_123', side: 'SHORT', pattern: 'SAR Peak Reversal', aiScore: 88 },
        settings: { requestedMode: 'FUTURES', allowedTradingDirections: 'BOTH' },
        marketSnapshot: validSnapshot
      });

      expect(result.success).toBe(true);
      if (result.success === true) {
        const intent = result.intent;
        expect(intent.symbol).toBe('BTCUSDT');
        expect(intent.side).toBe('SHORT');
        expect(intent.action).toBe('SELL');
        expect(intent.marketType).toBe('FUTURES');
        expect(intent.strategyId).toBe(CANONICAL_STRATEGY_ID);
        expect(intent.strategyVersion).toBe(CANONICAL_STRATEGY_VERSION);
        expect(intent.intentId).toBeDefined();
        expect(intent.correlationId).toBeDefined();
        expect(intent.signalId).toBe('sig_test_123');
        expect(intent.pattern).toBe('SAR Peak Reversal');
      }
    });

    it('fails-closed when market snapshot is incomplete', () => {
      const result = createTradeIntent({
        symbol: 'BTCUSDT',
        signal: { side: 'LONG' },
        settings: { requestedMode: 'FUTURES' },
        marketSnapshot: { ...validSnapshot, price: 0 }
      });

      expect(result.success).toBe(false);
      if (result.success === false) {
        expect(result.rejection.reasonCode).toBe('MARKET_DATA_INCOMPLETE');
      }
    });
  });

  describe('4. Strategy Engine Directional Symmetry & Side Invariant Gates', () => {
    it('enforces sideInvariantMatch gate when intent.side is SHORT', () => {
      const intentRes = createTradeIntent({
        symbol: 'BTCUSDT',
        signal: { side: 'SHORT', action: 'SELL' },
        settings: { requestedMode: 'FUTURES' },
        marketSnapshot: validSnapshot
      });
      expect(intentRes.success).toBe(true);
      if (!intentRes.success) return;

      const decision = evaluateEntryDecision({
        symbol: 'BTCUSDT',
        marketType: 'FUTURES',
        tradingMode: 'FUTURES',
        price: validSnapshot.price,
        high: validSnapshot.high,
        low: validSnapshot.low,
        open: validSnapshot.open,
        vwap: validSnapshot.vwap,
        sar: validSnapshot.sar,
        volume24h: validSnapshot.volume24h,
        tradeIntent: intentRes.intent
      });

      expect(decision.gateDiagnostics.sideInvariantMatch).toBe(true);
      expect(decision.side).toBe('SHORT');
    });

    it('enforces sideInvariantMatch gate when intent.side is LONG', () => {
      const longSnapshot: MarketSnapshot = {
        ...validSnapshot,
        price: 65000,
        sar: 64500,
        vwap: 64800,
        rsi: 35
      };

      const intentRes = createTradeIntent({
        symbol: 'BTCUSDT',
        signal: { side: 'LONG', action: 'BUY' },
        settings: { requestedMode: 'FUTURES' },
        marketSnapshot: longSnapshot
      });
      expect(intentRes.success).toBe(true);
      if (!intentRes.success) return;

      const decision = evaluateEntryDecision({
        symbol: 'BTCUSDT',
        marketType: 'FUTURES',
        tradingMode: 'FUTURES',
        price: longSnapshot.price,
        high: longSnapshot.high,
        low: longSnapshot.low,
        open: longSnapshot.open,
        vwap: longSnapshot.vwap,
        sar: longSnapshot.sar,
        volume24h: longSnapshot.volume24h,
        tradeIntent: intentRes.intent
      });

      expect(decision.gateDiagnostics.sideInvariantMatch).toBe(true);
      expect(decision.side).toBe('LONG');
    });

    it('symmetrically applies equal confidence standards to SHORT and LONG', () => {
      const shortContext = {
        symbol: 'BTCUSDT',
        price: 65000,
        high: 65500,
        low: 64800,
        open: 65200,
        vwap: 65100,
        sar: 65400,
        volume24h: 250000,
        side: 'SHORT' as const,
        action: 'SELL' as const
      };

      const longContext = {
        symbol: 'BTCUSDT',
        price: 65000,
        high: 65500,
        low: 64800,
        open: 64800,
        vwap: 64900,
        sar: 64600,
        volume24h: 250000,
        side: 'LONG' as const,
        action: 'BUY' as const
      };

      const shortSignal = evaluateStrategySignal(shortContext as any);
      const longSignal = evaluateStrategySignal(longContext as any);

      expect(shortSignal.action).toBe('SELL');
      expect(shortSignal.side).toBe('SHORT');
      expect(longSignal.action).toBe('BUY');
      expect(longSignal.side).toBe('LONG');
      expect(shortSignal.confidence).toBeGreaterThanOrEqual(60);
      expect(longSignal.confidence).toBeGreaterThanOrEqual(60);
    });
  });

  describe('5. Auto-Entry Pipeline (Futures & Spot Port Routing)', () => {
    it('executes virtual SHORT trade with full lineage fields and port separation', async () => {
      const savedTrades: any[] = [];
      const mockPort: AutoEntryExecutionPort = {
        saveTradeDB: async (trade) => { savedTrades.push(trade); },
        saveBalanceDB: async () => {},
        reservePaperMargin: async () => ({ success: true, newBalance: 950 }),
        getAvailableVirtualBalance: () => 1000,
        getAtomicStoreRevision: () => 42
      };

      const intentRes = createTradeIntent({
        symbol: 'ETHUSDT',
        signal: { id: 'sig_eth_short', side: 'SHORT', action: 'SELL' },
        settings: { requestedMode: 'FUTURES' },
        marketSnapshot: { ...validSnapshot, price: 3500, high: 3550, low: 3480, open: 3520, vwap: 3510, sar: 3540 }
      });
      expect(intentRes.success).toBe(true);
      if (!intentRes.success) return;

      const result = await runCanonicalAutoEntry({
        symbol: 'ETHUSDT',
        isReal: false,
        marketInput: {
          symbol: 'ETHUSDT',
          marketType: 'FUTURES',
          tradingMode: 'FUTURES',
          price: 3500,
          high: 3550,
          low: 3480,
          open: 3520,
          vwap: 3510,
          sar: 3540,
          volume24h: 200000
        },
        tradeIntent: intentRes.intent,
        currentSig: { side: 'SHORT', action: 'SELL' },
        calculatedAmount: 50,
        leverage: 10,
        stopLoss: 3550,
        takeProfit: 3400,
        virtualBalance: 1000,
        stateRevision: 42
      }, mockPort);

      expect(result.executed).toBe(true);
      expect(result.status).toBe('OPEN');
      expect(result.side).toBe('SHORT');
      expect(result.trade).toBeDefined();
      expect(result.trade.side).toBe('SHORT');
      expect(result.trade.marketType).toBe('FUTURES');
      expect(result.trade.tradeIntentId).toBe(intentRes.intent.intentId);
    });

    it('executes virtual LONG trade with full lineage fields and port separation', async () => {
      const savedTrades: any[] = [];
      const mockPort: AutoEntryExecutionPort = {
        saveTradeDB: async (trade) => { savedTrades.push(trade); },
        saveBalanceDB: async () => {},
        reservePaperMargin: async () => ({ success: true, newBalance: 950 }),
        getAvailableVirtualBalance: () => 1000,
        getAtomicStoreRevision: () => 43
      };

      const intentRes = createTradeIntent({
        symbol: 'SOLUSDT',
        signal: { id: 'sig_sol_long', side: 'LONG', action: 'BUY' },
        settings: { requestedMode: 'FUTURES' },
        marketSnapshot: { ...validSnapshot, price: 150, high: 155, low: 148, open: 149, vwap: 149.5, sar: 148 }
      });
      expect(intentRes.success).toBe(true);
      if (!intentRes.success) return;

      const result = await runCanonicalAutoEntry({
        symbol: 'SOLUSDT',
        isReal: false,
        marketInput: {
          symbol: 'SOLUSDT',
          marketType: 'FUTURES',
          tradingMode: 'FUTURES',
          price: 150,
          high: 155,
          low: 148,
          open: 149,
          vwap: 149.5,
          sar: 148,
          volume24h: 200000
        },
        tradeIntent: intentRes.intent,
        currentSig: { side: 'LONG', action: 'BUY' },
        calculatedAmount: 50,
        leverage: 10,
        stopLoss: 145,
        takeProfit: 160,
        virtualBalance: 1000,
        stateRevision: 43
      }, mockPort);

      expect(result.executed).toBe(true);
      expect(result.status).toBe('OPEN');
      expect(result.side).toBe('LONG');
      expect(result.trade).toBeDefined();
      expect(result.trade.side).toBe('LONG');
      expect(result.trade.marketType).toBe('FUTURES');
      expect(result.trade.tradeIntentId).toBe(intentRes.intent.intentId);
    });
  });
});
