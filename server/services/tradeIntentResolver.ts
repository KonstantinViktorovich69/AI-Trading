import type {
  TradeIntent,
  TradeSide,
  TradeAction,
  MarketType,
  TradingMarketMode,
  AllowedTradingDirections,
  MarketSnapshot,
  ModeResolutionResult,
  RouteRejection,
  ResolvedMarketRoute
} from '../types/tradeIntent.ts';

export const CANONICAL_STRATEGY_ID = 'CANONICAL_QUANT_SCALP_V2';
export const CANONICAL_STRATEGY_VERSION = '2.1.0';

/**
 * Validates MarketSnapshot values to enforce the fail-closed MARKET_DATA_INCOMPLETE policy.
 * Artificial fallback multipliers (e.g. price * 1.01) are strictly rejected.
 */
export function validateMarketSnapshot(snapshot: MarketSnapshot): { valid: boolean; reason?: string } {
  if (!snapshot || typeof snapshot !== 'object') {
    return { valid: false, reason: 'MarketSnapshot is missing or invalid' };
  }
  if (typeof snapshot.price !== 'number' || isNaN(snapshot.price) || snapshot.price <= 0) {
    return { valid: false, reason: `Invalid price: ${snapshot.price}` };
  }
  if (typeof snapshot.high !== 'number' || isNaN(snapshot.high) || snapshot.high <= 0) {
    return { valid: false, reason: `Invalid high: ${snapshot.high}` };
  }
  if (typeof snapshot.low !== 'number' || isNaN(snapshot.low) || snapshot.low <= 0) {
    return { valid: false, reason: `Invalid low: ${snapshot.low}` };
  }
  if (typeof snapshot.open !== 'number' || isNaN(snapshot.open) || snapshot.open <= 0) {
    return { valid: false, reason: `Invalid open: ${snapshot.open}` };
  }
  if (typeof snapshot.vwap !== 'number' || isNaN(snapshot.vwap) || snapshot.vwap <= 0) {
    return { valid: false, reason: `Invalid vwap: ${snapshot.vwap}` };
  }
  if (typeof snapshot.sar !== 'number' || isNaN(snapshot.sar) || snapshot.sar <= 0) {
    return { valid: false, reason: `Invalid sar: ${snapshot.sar}` };
  }
  if (typeof snapshot.volume24h !== 'number' || isNaN(snapshot.volume24h) || snapshot.volume24h < 0) {
    return { valid: false, reason: `Invalid volume24h: ${snapshot.volume24h}` };
  }
  if (snapshot.rsi !== undefined && (typeof snapshot.rsi !== 'number' || isNaN(snapshot.rsi) || snapshot.rsi < 0 || snapshot.rsi > 100)) {
    return { valid: false, reason: `Invalid rsi: ${snapshot.rsi}` };
  }
  return { valid: true };
}

/**
 * Pure, deterministic unit-testable market mode and direction resolver.
 * Enforces:
 * 1. Single source of truth for TradeSide and TradeAction.
 * 2. allowedTradingDirections Gate (LONG_ONLY / SHORT_ONLY / BOTH).
 * 3. Fail-closed SPOT SHORT prohibition without fallback to futures.
 */
export function resolveTradeMarketMode(
  settings: {
    tradingMode?: string;
    requestedMode?: string;
    allowedTradingDirections?: string;
    allowedDirections?: string;
  } | undefined,
  scannerSignal: any
): ModeResolutionResult {
  // 1. Resolve Allowed Trading Directions
  let allowedDirections: AllowedTradingDirections = 'BOTH';
  const rawAllowed = (settings?.allowedTradingDirections || settings?.allowedDirections || '').toUpperCase();
  if (rawAllowed === 'LONG_ONLY') {
    allowedDirections = 'LONG_ONLY';
  } else if (rawAllowed === 'SHORT_ONLY') {
    allowedDirections = 'SHORT_ONLY';
  } else if (rawAllowed === 'BOTH') {
    allowedDirections = 'BOTH';
  } else if (rawAllowed) {
    // Unknown value -> fail-closed or default BOTH with telemetry
    console.warn(`[MODE_RESOLVER] LEGACY_SETTINGS_DEFAULT_APPLIED: Unknown allowedDirections "${rawAllowed}", defaulting to BOTH`);
    allowedDirections = 'BOTH';
  }

  // 2. Resolve Requested Market Mode (FUTURES / SPOT / HYBRID)
  let requestedMode: TradingMarketMode = 'HYBRID';
  const rawMode = (settings?.requestedMode || settings?.tradingMode || '').toUpperCase();
  if (rawMode === 'FUTURES') {
    requestedMode = 'FUTURES';
  } else if (rawMode === 'SPOT') {
    requestedMode = 'SPOT';
  } else if (rawMode === 'HYBRID' || rawMode === 'COMBINED') {
    requestedMode = 'HYBRID';
  }

  // 3. Resolve Signal Direction (LONG / SHORT)
  let side: TradeSide | null = null;
  let action: TradeAction | null = null;

  if (scannerSignal) {
    // Check explicit side/action fields first
    if (scannerSignal.side === 'SHORT' || scannerSignal.action === 'SELL') {
      side = 'SHORT';
      action = 'SELL';
    } else if (scannerSignal.side === 'LONG' || scannerSignal.action === 'BUY') {
      side = 'LONG';
      action = 'BUY';
    } else if (typeof scannerSignal.isSellSignal === 'boolean') {
      if (scannerSignal.isSellSignal) {
        side = 'SHORT';
        action = 'SELL';
      } else {
        side = 'LONG';
        action = 'BUY';
      }
    } else if (typeof scannerSignal.signal === 'string') {
      const sigStr = scannerSignal.signal.toUpperCase();
      if (sigStr.includes('SELL') || sigStr.includes('SHORT')) {
        side = 'SHORT';
        action = 'SELL';
      } else if (sigStr.includes('BUY') || sigStr.includes('LONG')) {
        side = 'LONG';
        action = 'BUY';
      }
    } else if (typeof scannerSignal.type === 'string') {
      const typeStr = scannerSignal.type.toUpperCase();
      if (typeStr.includes('ШОРТ') || typeStr.includes('SHORT') || typeStr.includes('СЛИВ') || typeStr.includes('ПРОДАЖ')) {
        side = 'SHORT';
        action = 'SELL';
      } else if (typeStr.includes('ЛОНГ') || typeStr.includes('LONG') || typeStr.includes('СПОТ') || typeStr.includes('ПОКУПК') || typeStr.includes('ACCUMULATION')) {
        side = 'LONG';
        action = 'BUY';
      }
    }
  }

  if (!side || !action) {
    return {
      success: false,
      rejection: {
        rejected: true,
        reasonCode: 'SIGNAL_DIRECTION_UNRESOLVED',
        reason: 'Не удалось однозначно определить направление сигнала (LONG/SHORT)'
      }
    };
  }

  // 4. Directional Policy Gate
  if (allowedDirections === 'LONG_ONLY' && side === 'SHORT') {
    return {
      success: false,
      rejection: {
        rejected: true,
        reasonCode: 'DIRECTION_NOT_ALLOWED',
        reason: 'Направление SHORT заблокировано настройкой LONG_ONLY'
      }
    };
  }

  if (allowedDirections === 'SHORT_ONLY' && side === 'LONG') {
    return {
      success: false,
      rejection: {
        rejected: true,
        reasonCode: 'DIRECTION_NOT_ALLOWED',
        reason: 'Направление LONG заблокировано настройкой SHORT_ONLY'
      }
    };
  }

  // 5. Market Mode & Routing Resolution
  const isSpotSignalSetup = (
    scannerSignal?.marketType === 'SPOT' ||
    (typeof scannerSignal?.type === 'string' && (scannerSignal.type.includes('Спот') || scannerSignal.type.includes('Spot'))) ||
    scannerSignal?.isSpotBuySetup === true
  );

  if (requestedMode === 'FUTURES') {
    // Mode FUTURES allows Futures LONG and Futures SHORT
    return {
      success: true,
      route: {
        resolvedMarketType: 'FUTURES',
        side,
        action,
        reason: `FUTURES ${side} execution approved`
      }
    };
  }

  if (requestedMode === 'SPOT') {
    // Standard spot account cannot open short positions without margin/borrow
    if (side === 'SHORT' || action === 'SELL') {
      return {
        success: false,
        rejection: {
          rejected: true,
          reasonCode: 'SPOT_SHORT_UNSUPPORTED',
          reason: 'Спотовая торговля не поддерживает SHORT позиции (fail-closed, без fallback в futures)'
        }
      };
    }

    return {
      success: true,
      route: {
        resolvedMarketType: 'SPOT',
        side: 'LONG',
        action: 'BUY',
        reason: 'SPOT LONG accumulation execution approved'
      }
    };
  }

  // requestedMode === 'HYBRID'
  if (side === 'SHORT') {
    // In hybrid mode, short signals route strictly to Futures
    // If the signal was specifically flagged as SPOT SHORT, reject it
    if (scannerSignal?.marketType === 'SPOT' && (scannerSignal?.signal === 'SPOT_SHORT' || scannerSignal?.type?.includes('Spot Short'))) {
      return {
        success: false,
        rejection: {
          rejected: true,
          reasonCode: 'SPOT_SHORT_UNSUPPORTED',
          reason: 'Спотовая торговля не поддерживает SHORT позиции'
        }
      };
    }

    return {
      success: true,
      route: {
        resolvedMarketType: 'FUTURES',
        side: 'SHORT',
        action: 'SELL',
        reason: 'HYBRID mode routed SHORT signal to FUTURES'
      }
    };
  }

  // In hybrid mode, LONG can be SPOT (if accumulation pattern) or FUTURES
  if (isSpotSignalSetup) {
    return {
      success: true,
      route: {
        resolvedMarketType: 'SPOT',
        side: 'LONG',
        action: 'BUY',
        reason: 'HYBRID mode routed Spot Accumulation LONG to SPOT'
      }
    };
  }

  return {
    success: true,
    route: {
      resolvedMarketType: 'FUTURES',
      side: 'LONG',
      action: 'BUY',
      reason: 'HYBRID mode routed Trend LONG to FUTURES'
    }
  };
}

export interface CreateTradeIntentParams {
  symbol: string;
  signal: any;
  settings?: any;
  marketSnapshot: MarketSnapshot;
  source?: 'SCANNER' | 'MANUAL' | 'RECOVERY';
  correlationId?: string;
  signalId?: string;
  strategyId?: string;
  strategyVersion?: string;
}

export type CreateTradeIntentResult =
  | { success: true; intent: TradeIntent }
  | { success: false; rejection: RouteRejection };

/**
 * Creates an immutable, fully validated TradeIntent.
 * Fail-closed if market data is incomplete or mode routing rejects the signal.
 */
export function createTradeIntent(params: CreateTradeIntentParams): CreateTradeIntentResult {
  const snapshotCheck = validateMarketSnapshot(params.marketSnapshot);
  if (!snapshotCheck.valid) {
    return {
      success: false,
      rejection: {
        rejected: true,
        reasonCode: 'MARKET_DATA_INCOMPLETE',
        reason: `Рыночные данные неполные: ${snapshotCheck.reason}`
      }
    };
  }

  const modeResolution = resolveTradeMarketMode(params.settings, params.signal);
  if (modeResolution.success === false) {
    return {
      success: false,
      rejection: modeResolution.rejection
    };
  }

  const route = modeResolution.route;
  const now = Date.now();
  const correlationId = params.correlationId || `corr_${now}_${Math.random().toString(36).substring(2, 9)}`;
  const signalId = params.signalId || params.signal?.id || `sig_${now}_${Math.random().toString(36).substring(2, 7)}`;
  const intentId = `intent_${now}_${Math.random().toString(36).substring(2, 9)}`;

  const allowedDirections: AllowedTradingDirections =
    params.settings?.allowedTradingDirections === 'LONG_ONLY'
      ? 'LONG_ONLY'
      : params.settings?.allowedTradingDirections === 'SHORT_ONLY'
        ? 'SHORT_ONLY'
        : 'BOTH';

  const requestedMode: TradingMarketMode =
    params.settings?.requestedMode === 'FUTURES' || params.settings?.tradingMode === 'FUTURES'
      ? 'FUTURES'
      : params.settings?.requestedMode === 'SPOT' || params.settings?.tradingMode === 'SPOT'
        ? 'SPOT'
        : 'HYBRID';

  const intent: TradeIntent = {
    intentId,
    correlationId,
    signalId,
    symbol: params.symbol,
    side: route.side,
    action: route.action,
    marketType: route.resolvedMarketType,
    requestedMode,
    allowedDirections,
    strategyId: params.strategyId || CANONICAL_STRATEGY_ID,
    strategyVersion: params.strategyVersion || CANONICAL_STRATEGY_VERSION,
    source: params.source || 'SCANNER',
    createdAt: now,
    marketSnapshot: { ...params.marketSnapshot },
    pattern: params.signal?.pattern || params.signal?.type,
    score: params.signal?.aiScore,
    modeResolutionReason: route.reason
  };

  return {
    success: true,
    intent
  };
}
