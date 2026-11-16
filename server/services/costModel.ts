/**
 * Unified Cost Model (Fee + Slippage Single Source of Truth)
 * Canonical reference:
 *   feeRatePerSide: 0.0006 (0.06% maker/taker average on futures)
 *   slippageRoundTrip: 0.0004 (0.04% round-trip execution slippage)
 *   totalRoundTrip: feeRatePerSide * 2 + slippageRoundTrip = 0.0016 (0.16% notional)
 *   version: 2
 */

export interface CostModel {
  feeRatePerSide: number;
  slippageRoundTrip: number;
  version: number;
  slippageTierModelEnabled?: boolean;
}

export const DEFAULT_COST_MODEL: CostModel = {
  feeRatePerSide: 0.0006,
  slippageRoundTrip: 0.0004,
  version: 2,
  slippageTierModelEnabled: false
};

/**
 * Returns effective cost model based on settings.
 */
export function getCostModel(settings?: any): CostModel {
  const custom = settings?.costModel;
  const slippageTierModelEnabled = settings?.slippageTierModelEnabled ?? false;

  const feeRatePerSide = typeof custom?.feeRatePerSide === 'number' && custom.feeRatePerSide >= 0
    ? custom.feeRatePerSide
    : DEFAULT_COST_MODEL.feeRatePerSide;

  const slippageRoundTrip = typeof custom?.slippageRoundTrip === 'number' && custom.slippageRoundTrip >= 0
    ? custom.slippageRoundTrip
    : DEFAULT_COST_MODEL.slippageRoundTrip;

  const version = typeof custom?.version === 'number' ? custom.version : DEFAULT_COST_MODEL.version;

  return {
    feeRatePerSide,
    slippageRoundTrip,
    version,
    slippageTierModelEnabled
  };
}

/**
 * Calculates total round-trip cost as a decimal fraction of notional value.
 * e.g., 0.0006 * 2 + 0.0004 = 0.0016 (0.16%)
 */
export function roundTripCostPct(costModel: CostModel): number {
  return costModel.feeRatePerSide * 2 + costModel.slippageRoundTrip;
}

/**
 * Dynamic slippage tier adjustment based on 24h volume.
 * Reuses logic from slippageFeeSimulator:
 * If volume24h < 50,000, slippage multiplier increases.
 */
export function calculateTieredSlippageRoundTrip(
  baseSlippageRoundTrip: number,
  volume24h?: number,
  slippageTierModelEnabled: boolean = false
): number {
  if (!slippageTierModelEnabled || typeof volume24h !== 'number' || volume24h <= 0) {
    return baseSlippageRoundTrip;
  }

  // Tier 1: Liquidity < $50,000 -> 2.5x slippage
  if (volume24h < 50000) {
    return +(baseSlippageRoundTrip * 2.5).toFixed(6);
  }
  // Tier 2: Liquidity < $200,000 -> 1.5x slippage
  if (volume24h < 200000) {
    return +(baseSlippageRoundTrip * 1.5).toFixed(6);
  }
  // Tier 3: Liquidity >= $200,000 -> normal base slippage
  return baseSlippageRoundTrip;
}

/**
 * Empirical WEEX Futures v3 taker fee rate per side (0.08% per side = 0.16% round-trip),
 * confirmed on 1025/1026 contracts in GET /capi/v3/market/exchangeInfo.
 * Used strictly for shadow field netPnlTakerFee without altering costModel v2.
 */
export const WEEX_TAKER_FEE_PER_SIDE = 0.0008;

export function getShadowTakerCostModel(baseCostModel?: CostModel): CostModel {
  return {
    feeRatePerSide: WEEX_TAKER_FEE_PER_SIDE,
    slippageRoundTrip: baseCostModel?.slippageRoundTrip ?? DEFAULT_COST_MODEL.slippageRoundTrip,
    version: baseCostModel?.version ?? DEFAULT_COST_MODEL.version,
    slippageTierModelEnabled: baseCostModel?.slippageTierModelEnabled ?? false
  };
}

