import { describe, it, expect } from 'vitest';
import {
  getCostModel,
  roundTripCostPct,
  calculateTieredSlippageRoundTrip,
  DEFAULT_COST_MODEL
} from './costModel.ts';
import { getUnifiedTradeClosePnl } from '../quant.ts';
import { calculateNetPnlPct, evaluateExitPolicy } from './exitPolicy.ts';
import { netReturnPct } from './learningCells.ts';
import { buildExitPolicyConfig } from './virtualTradeEngine.ts';

describe('Unified Cost Model (T4.1)', () => {
  it('returns canonical default cost model (0.06% fee per side, 0.04% slippage, version 2)', () => {
    const model = getCostModel();
    expect(model.feeRatePerSide).toBe(0.0006);
    expect(model.slippageRoundTrip).toBe(0.0004);
    expect(model.version).toBe(2);
    expect(model.slippageTierModelEnabled).toBe(false);

    const costFraction = roundTripCostPct(model);
    expect(costFraction).toBeCloseTo(0.0016, 6); // 0.16% round-trip
  });

  it('allows overriding cost model values via settings', () => {
    const customSettings = {
      costModel: {
        feeRatePerSide: 0.0008,
        slippageRoundTrip: 0.0005,
        version: 2
      },
      slippageTierModelEnabled: true
    };
    const model = getCostModel(customSettings);
    expect(model.feeRatePerSide).toBe(0.0008);
    expect(model.slippageRoundTrip).toBe(0.0005);
    expect(model.slippageTierModelEnabled).toBe(true);
    expect(roundTripCostPct(model)).toBeCloseTo(0.0021, 6);
  });

  it('calculates zero-price-movement PnL exactly equal to -(2 * 0.0006 + 0.0004) * leverage * 100', () => {
    const costModel = getCostModel();
    const leverage = 5;
    const amount = 10;
    
    // Trade with zero price movement (100 -> 100)
    const result = getUnifiedTradeClosePnl('SHORT', 100, 100, amount, leverage, costModel);
    
    const expectedPnlPct = -(2 * 0.0006 + 0.0004) * leverage * 100; // -0.8%
    expect(result.pnlPercent).toBeCloseTo(expectedPnlPct, 6);
    expect(result.feeUsd).toBeCloseTo(amount * leverage * (0.0006 * 2), 6); // 0.06 USD
    expect(result.slippageUsd).toBeCloseTo(amount * leverage * 0.0004, 6); // 0.02 USD
    expect(result.grossPnlUsd).toBeCloseTo(0, 6);
    expect(result.pnlUsd).toBeCloseTo(-0.08, 6);
    expect(result.costModelVersion).toBe(2);
  });

  it('preserves exact legacy behaviour and numbers when costModel is omitted', () => {
    // Exact tests from quant.test.ts
    const shortResult = getUnifiedTradeClosePnl('SHORT', 100, 95, 10, 5);
    expect(shortResult.leveragedPct).toBeCloseTo(25);
    expect(shortResult.feeUsd).toBeCloseTo(0.05);
    expect(shortResult.pnlUsd).toBeCloseTo(2.45);
    expect(shortResult.slippageUsd).toBe(0);

    const longResult = getUnifiedTradeClosePnl('LONG', 100, 105, 10, 5);
    expect(longResult.leveragedPct).toBeCloseTo(25);
    expect(longResult.feeUsd).toBeCloseTo(0.05);
    expect(longResult.pnlUsd).toBeCloseTo(2.45);
    expect(longResult.slippageUsd).toBe(0);
  });

  it('correctly calculates profit with costModel v2 for LONG and SHORT trades', () => {
    const costModel = getCostModel();
    const amount = 100;
    const leverage = 10;
    
    // 1% price increase in LONG position:
    // Raw profit: 1% * 10 = 10% * 100 = 10 USD
    // Fees: 100 * 10 * 0.0012 = 1.2 USD
    // Slippage: 100 * 10 * 0.0004 = 0.4 USD
    // Total cost: 1.6 USD
    // Net PnL USD: 10 - 1.6 = 8.4 USD (8.4%)
    const longRes = getUnifiedTradeClosePnl('LONG', 100, 101, amount, leverage, costModel);
    expect(longRes.grossPnlUsd).toBeCloseTo(10, 4);
    expect(longRes.feeUsd).toBeCloseTo(1.2, 4);
    expect(longRes.slippageUsd).toBeCloseTo(0.4, 4);
    expect(longRes.pnlUsd).toBeCloseTo(8.4, 4);
    expect(longRes.pnlPercent).toBeCloseTo(8.4, 4);
    expect(longRes.costModelVersion).toBe(2);

    // 1% price decrease in SHORT position:
    const shortRes = getUnifiedTradeClosePnl('SHORT', 100, 99, amount, leverage, costModel);
    expect(shortRes.grossPnlUsd).toBeCloseTo(10, 4);
    expect(shortRes.feeUsd).toBeCloseTo(1.2, 4);
    expect(shortRes.slippageUsd).toBeCloseTo(0.4, 4);
    expect(shortRes.pnlUsd).toBeCloseTo(8.4, 4);
    expect(shortRes.pnlPercent).toBeCloseTo(8.4, 4);
    expect(shortRes.costModelVersion).toBe(2);
  });

  it('dynamically scales slippage when slippageTierModelEnabled is true and volume is low', () => {
    const baseSlippage = 0.0004;

    // Disabled flag -> unchanged
    expect(calculateTieredSlippageRoundTrip(baseSlippage, 20000, false)).toBe(baseSlippage);

    // Enabled flag, low liquidity (< $50k) -> 2.5x slippage
    expect(calculateTieredSlippageRoundTrip(baseSlippage, 30000, true)).toBeCloseTo(0.001, 6);

    // Enabled flag, medium liquidity (< $200k) -> 1.5x slippage
    expect(calculateTieredSlippageRoundTrip(baseSlippage, 100000, true)).toBeCloseTo(0.0006, 6);

    // Enabled flag, high liquidity (>= $200k) -> normal slippage
    expect(calculateTieredSlippageRoundTrip(baseSlippage, 500000, true)).toBe(baseSlippage);
  });

  it('ensures exitPolicy and buildExitPolicyConfig share the same CostModel parameters', () => {
    const globalSettings = {
      costModel: {
        feeRatePerSide: 0.0006,
        slippageRoundTrip: 0.0004,
        version: 2
      }
    };
    const trade = { side: 'SHORT', entryPrice: 100, leverage: 1 };
    const exitConfig = buildExitPolicyConfig(globalSettings, trade);

    expect(exitConfig.costModel).toBeDefined();
    expect(exitConfig.estimatedFeePct).toBe(0.0006);
    expect(exitConfig.estimatedSlippagePct).toBe(0.0004);

    // When market has no estimates, it uses exitConfig's costModel
    const { netPnlPct, grossPnlPct } = calculateNetPnlPct(
      {
        id: '1',
        symbol: 'BTCUSDT',
        side: 'SHORT',
        entryPrice: 100,
        amount: 100,
        leverage: 1,
        createdAt: Date.now()
      },
      {
        currentPrice: 100,
        bid: 99.95,
        ask: 100.05
      },
      exitConfig
    );

    expect(grossPnlPct).toBeCloseTo(0);
    // netPnlPct should subtract round trip (0.06% * 2 + 0.04% = 0.16%)
    expect(netPnlPct).toBeCloseTo(-0.16, 4);
  });

  it('netReturnPct in learningCells computes honest return according to costModelVersion', () => {
    // 1. Trade with recorded pnl
    const tradeWithPnl = {
      initialAmount: 100,
      leverage: 2,
      pnl: 5.0, // already contains fees
      costModelVersion: 2
    };
    // netReturnPct = (5 / 200) * 100 = 2.5%
    expect(netReturnPct(tradeWithPnl)).toBeCloseTo(2.5, 4);

    // 2. Trade without recorded pnl, fallback to prices with costModelVersion: 2 (0.16% fee)
    const tradeFallbackV2 = {
      side: 'LONG',
      entryPrice: 100,
      closePrice: 101, // +1.0% raw
      initialAmount: 100,
      leverage: 1,
      costModelVersion: 2
    };
    // 1.0 - 0.16 = 0.84%
    expect(netReturnPct(tradeFallbackV2)).toBeCloseTo(0.84, 4);

    // 3. Trade without recorded pnl, fallback to prices with legacy version (0.10% fee)
    const tradeFallbackLegacy = {
      side: 'LONG',
      entryPrice: 100,
      closePrice: 101, // +1.0% raw
      initialAmount: 100,
      leverage: 1
    };
    // 1.0 - 0.10 = 0.90%
    expect(netReturnPct(tradeFallbackLegacy)).toBeCloseTo(0.90, 4);
  });

  it('computes shadow taker cost model (0.08% per side = 0.20% round-trip with 0.04% slippage) without changing costModel v2', async () => {
    const { getShadowTakerCostModel, WEEX_TAKER_FEE_PER_SIDE } = await import('./costModel.ts');
    const v2 = getCostModel();
    const taker = getShadowTakerCostModel(v2);

    expect(v2.feeRatePerSide).toBe(0.0006);
    expect(WEEX_TAKER_FEE_PER_SIDE).toBe(0.0008);
    expect(taker.feeRatePerSide).toBe(0.0008);
    expect(taker.slippageRoundTrip).toBe(0.0004);
    expect(roundTripCostPct(v2)).toBeCloseTo(0.0016, 6);
    expect(roundTripCostPct(taker)).toBeCloseTo(0.0020, 6);

    const amount = 100;
    const leverage = 5;
    // +1% favorable move at 5x = +5.00% raw ROE
    // v2 net = 5.00% - (0.16% * 5) = +4.20%
    // taker net = 5.00% - (0.20% * 5) = +4.00%
    const v2Res = getUnifiedTradeClosePnl('LONG', 100, 101, amount, leverage, v2);
    const takerRes = getUnifiedTradeClosePnl('LONG', 100, 101, amount, leverage, taker);
    expect(v2Res.pnlPercent).toBeCloseTo(4.20, 4);
    expect(takerRes.pnlPercent).toBeCloseTo(4.00, 4);
    expect(takerRes.feeUsd).toBeCloseTo(0.80, 4); // 500 * 0.0016
    expect(takerRes.slippageUsd).toBeCloseTo(0.20, 4); // 500 * 0.0004
    expect(takerRes.pnlUsd).toBeCloseTo(4.00, 4);
  });
});

