import { describe, it, expect } from 'vitest';
import { evaluateStrategySignal, validateMarketDataCompleteness, type StrategyContext } from './strategyEngine.ts';

describe('StrategyEngine - Canonical Entry & Symmetric Risk Gates', () => {
  const baseCtx: StrategyContext = {
    symbol: 'BTCUSDT',
    marketType: 'FUTURES',
    tradingMode: 'FUTURES',
    price: 67000,
    high: 67800,
    low: 66500,
    open: 66800,
    vwap: 67200,
    sar: 67900,
    rsi: 55,
    change24h: 8.5,
    volume24h: 2500000,
    avgVolume: 800000,
    bidSpreadPct: 0.0005,
    fundingRate: 0.0001
  };

  it('fails closed when market data is incomplete or zero', () => {
    const invalidCtx: StrategyContext = { ...baseCtx, price: 0 };
    expect(validateMarketDataCompleteness(invalidCtx)).toBe(false);

    const decision = evaluateStrategySignal(invalidCtx);
    expect(decision.action).toBe('NO_TRADE');
    expect(decision.dataCompleteness).toBe('INCOMPLETE');
    expect(decision.rejectionReason).toBe('DATA_INCOMPLETE');
  });

  it('fails closed when bid spread is too wide', () => {
    const wideSpreadCtx: StrategyContext = { ...baseCtx, bidSpreadPct: 0.015 }; // 1.5% spread
    const decision = evaluateStrategySignal(wideSpreadCtx);
    expect(decision.action).toBe('NO_TRADE');
    expect(decision.rejectionReason).toBe('HIGH_SPREAD');
  });

  it('evaluates SHORT signal when short scalp conditions are met', () => {
    const decision = evaluateStrategySignal(baseCtx);
    expect(decision.dataCompleteness).toBe('COMPLETE');
    expect(decision.side).toBe('SHORT');
    expect(decision.action).toBe('SELL');
    expect(decision.confidence).toBeGreaterThanOrEqual(65);
    expect(decision.strategyId).toBe('CANONICAL_QUANT_SCALP_V2');
  });

  it('evaluates SPOT LONG signal when spot accumulation conditions are met', () => {
    const spotCtx: StrategyContext = {
      ...baseCtx,
      marketType: 'SPOT',
      tradingMode: 'SPOT',
      change24h: -5.0,
      rsi: 32,
      price: 64000,
      high: 65000,
      low: 63800,
      open: 64900,
      vwap: 64100,
      sar: 63500
    };

    const decision = evaluateStrategySignal(spotCtx);
    expect(decision.side).toBe('LONG');
    expect(decision.action).toBe('BUY');
    expect(decision.spotDcaLadder).toBeDefined();
    expect(decision.spotDcaLadder?.length).toBe(3);
  });

  it('enforces hard gates even in aggressive mode', () => {
    const aggressiveHighSpreadCtx: StrategyContext = {
      ...baseCtx,
      isAggressiveMode: true,
      bidSpreadPct: 0.025 // 2.5% spread (exceeds even aggressive max 1.2%)
    };

    const decision = evaluateStrategySignal(aggressiveHighSpreadCtx);
    expect(decision.action).toBe('NO_TRADE');
    expect(decision.rejectionReason).toBe('HIGH_SPREAD');
  });
});
