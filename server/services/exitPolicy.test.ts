import { describe, it, expect } from 'vitest';
import { evaluateExitPolicy, type ExitTradeSnapshot, type ExitMarketSnapshot, type ExitPolicySettings } from './exitPolicy.ts';

describe('ExitPolicy - Deterministic State Machine & Minimum Net PnL Protection', () => {
  const baseTrade: ExitTradeSnapshot = {
    id: 'trade_101',
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 60000,
    currentPrice: 60000,
    amount: 100,
    leverage: 10,
    stopLoss: 55000, // Safe distance below
    createdAt: Date.now() - 3600 * 1000 // 1 hour ago
  };

  const baseMarket: ExitMarketSnapshot = {
    currentPrice: 60000,
    bid: 59990,
    ask: 60010,
    estimatedFeePct: 0.0006,
    estimatedSlippagePct: 0.0004
  };

  const baseSettings: ExitPolicySettings = {
    minNormalAutoCloseNetPnlPct: 4.0,
    minPttpActivationNetPnlPct: 1.0,
    minPttpPeakNetPnlPct: 6.0,
    pttpTrailingDropPct: 25.0
  };

  it('triggers STOP_LOSS when price crosses stop level regardless of net PnL threshold', () => {
    const slTrade: ExitTradeSnapshot = { ...baseTrade, stopLoss: 59000 };
    const slMarket: ExitMarketSnapshot = { ...baseMarket, currentPrice: 58500 };

    const decision = evaluateExitPolicy(slTrade, slMarket, baseSettings);
    expect(decision.kind).toBe('FULL_CLOSE');
    expect(decision.reasonCode).toBe('STOP_LOSS');
  });

  it('triggers TAKE_PROFIT when price hits target level', () => {
    const tpTrade: ExitTradeSnapshot = { ...baseTrade, takeProfit: 63000 };
    const tpMarket: ExitMarketSnapshot = { ...baseMarket, currentPrice: 63500 };

    const decision = evaluateExitPolicy(tpTrade, tpMarket, baseSettings);
    expect(decision.kind).toBe('FULL_CLOSE');
    expect(decision.reasonCode).toBe('TAKE_PROFIT');
  });

  it('triggers PTTP exit when peak profit gives back >=25% and current net PnL >= 4.0%', () => {
    const pttpTrade: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 60000,
      highestPrice: 66000, // Gross PnL peak = +10% * 10 = +100%
      stopLoss: 58000
    };
    // Current price dropped to 64000 -> Gross PnL = +6.66% * 10 = +66.6% -> Net PnL ~ +64.6% (well above 4.0%)
    const pttpMarket: ExitMarketSnapshot = { ...baseMarket, currentPrice: 64000 };

    const decision = evaluateExitPolicy(pttpTrade, pttpMarket, baseSettings);
    expect(decision.kind).toBe('FULL_CLOSE');
    expect(decision.reasonCode).toBe('PTTP');
  });

  it('blocks PTTP close if current net PnL is below minNormalAutoCloseNetPnlPct (4.0%)', () => {
    const lowPnlPttpTrade: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 60000,
      highestPrice: 61000, // Gross PnL peak = +16.6% -> Net PnL ~ 14.6%
      stopLoss: 60085 // Stop loss already at trailing level
    };
    // Current price 60300 -> Gross PnL = +5% -> Net PnL ~ 3.0% (< 4.0% threshold)
    // Profit gave back from 14.6% peak to 3.0% (~79% drop >= 25% pttpDropPct)
    const lowPnlMarket: ExitMarketSnapshot = { ...baseMarket, currentPrice: 60300 };

    const decision = evaluateExitPolicy(lowPnlPttpTrade, lowPnlMarket, baseSettings);
    expect(decision.kind).toBe('HOLD');
    expect(decision.diagnostics.pttpBlockedByMinPnlThreshold).toBe(true);
  });

  it('triggers MOVE_STOP when protective trailing stop threshold is reached', () => {
    const trailTrade: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 60000,
      highestPrice: 60600,
      stopLoss: 58000
    };
    const trailMarket: ExitMarketSnapshot = { ...baseMarket, currentPrice: 60600 };

    const decision = evaluateExitPolicy(trailTrade, trailMarket, { ...baseSettings, trailingStopTriggerPnlPct: 5.0, trailingStopDistancePct: 1.5 });
    expect(decision.kind).toBe('MOVE_STOP');
    expect(decision.reasonCode).toBe('TRAILING_STOP');
    expect(decision.newStopLoss).toBeGreaterThan(0);
  });

  it('handles MAX_LIFETIME with safe semantics (HOLD below floor, emergency close when explicit)', () => {
    const oldTradeBelowFloor: ExitTradeSnapshot = {
      ...baseTrade,
      createdAt: Date.now() - 25 * 3600 * 1000 // 25 hours old, PnL < 4%
    };

    // 1. Default (omitted / false emergency flag) -> HOLD below floor
    const decisionHold = evaluateExitPolicy(oldTradeBelowFloor, baseMarket, baseSettings);
    expect(decisionHold.kind).toBe('HOLD');
    expect(decisionHold.diagnostics.maxLifetimeBlockedByMinPnlThreshold).toBe(true);

    // 2. Explicit emergency flag true -> EMERGENCY_FULL_CLOSE
    const decisionEmergency = evaluateExitPolicy(oldTradeBelowFloor, baseMarket, {
      ...baseSettings,
      allowEmergencyMaxLifetime: true
    });
    expect(decisionEmergency.kind).toBe('EMERGENCY_FULL_CLOSE');
    expect(decisionEmergency.reasonCode).toBe('EMERGENCY_MAX_LIFETIME');

    // 3. Trade above profit floor -> normal FULL_CLOSE
    const oldTradeAboveFloor: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 100,
      stopLoss: 98,
      createdAt: Date.now() - 25 * 3600 * 1000
    };
    const decisionNormal = evaluateExitPolicy(oldTradeAboveFloor, { currentPrice: 100.65, bid: 100.63, ask: 100.67 }, baseSettings); // +4.7% net PnL (> 4% floor, < 5% trailing trigger)
    expect(decisionNormal.kind).toBe('FULL_CLOSE');
    expect(decisionNormal.reasonCode).toBe('MAX_LIFETIME');
  });

  it('triggers TIMEOUT_SAFETY when trade stalls in stagnation flat/loss for >= timeoutStagnationHours', () => {
    const stagnantTrade: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 100,
      stopLoss: 95,
      createdAt: Date.now() - 4 * 3600 * 1000 // 4 hours old
    };
    // Current price is 100.02 (almost zero profit, flat/stagnant)
    const stagnantMarket: ExitMarketSnapshot = {
      currentPrice: 100.02,
      bid: 100.01,
      ask: 100.03
    };

    // 1. With enableStagnationTimeout: true -> FULL_CLOSE with TIMEOUT_SAFETY
    const decisionClose = evaluateExitPolicy(stagnantTrade, stagnantMarket, {
      ...baseSettings,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 3.5,
      maxStagnationPnlPct: 1.0
    });
    expect(decisionClose.kind).toBe('FULL_CLOSE');
    expect(decisionClose.reasonCode).toBe('TIMEOUT_SAFETY');
    expect(decisionClose.reasonText).toContain('Тайм-стоп скальпинга');

    // 2. With enableStagnationTimeout: false or omitted -> retains default HOLD
    const decisionHold = evaluateExitPolicy(stagnantTrade, stagnantMarket, baseSettings);
    expect(decisionHold.kind).toBe('HOLD');
  });

  it('triggers TIMEOUT_SAFETY even if trade had previous peak but fell back into stagnation flat', () => {
    const pastImpulseTrade: ExitTradeSnapshot = {
      ...baseTrade,
      entryPrice: 100,
      highestPrice: 106, // Had a peak earlier
      stopLoss: 95,
      createdAt: Date.now() - 4 * 3600 * 1000 // 4 hours old
    };
    // Current price fell back to 100.05 (+0.25% net, hovering in flat)
    const currentMarket: ExitMarketSnapshot = {
      currentPrice: 100.05,
      bid: 100.04,
      ask: 100.06
    };

    const decision = evaluateExitPolicy(pastImpulseTrade, currentMarket, {
      ...baseSettings,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 3.5,
      maxStagnationPnlPct: 1.0
    });
    expect(decision.kind).toBe('FULL_CLOSE');
    expect(decision.reasonCode).toBe('TIMEOUT_SAFETY');
    expect(decision.reasonText).toContain('Тайм-стоп скальпинга');
  });
});
