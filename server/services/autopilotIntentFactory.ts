import { type TradeIntent, type TradeSide, type TradeAction, type MarketType, type TradingMarketMode, type AllowedTradingDirections, type MarketSnapshot, type RouteRejection, type RejectionReasonCode } from '../types/tradeIntent.ts';
import { type StrategyMarketInput } from './strategyEngine.ts';

export interface SafeRejectionAuditContext {
  readonly sourcePath: 'MAIN_VIRTUAL' | 'WORKER_VIRTUAL' | 'MAIN_REAL_STUB' | 'WORKER_REAL_STUB' | string;
  readonly symbol: string;
  readonly signalId?: string;
  readonly correlationId?: string;
  readonly scannerSide?: TradeSide | 'UNKNOWN';
  readonly requestedMode?: TradingMarketMode | string;
  readonly resolvedMarketType?: MarketType | string;
  readonly reasonCode: RejectionReasonCode | string;
  readonly reason: string;
  readonly gateDiagnostics?: Readonly<Record<string, any>>;
  readonly timestamp: number;
}

export type AutopilotIntentResult =
  | {
      readonly ok: true;
      readonly intent: Readonly<TradeIntent>;
      readonly strategyContext: Readonly<StrategyMarketInput>;
    }
  | {
      readonly ok: false;
      readonly rejection: Readonly<RouteRejection>;
      readonly auditContext: Readonly<SafeRejectionAuditContext>;
    };

export interface ScannerMarketInputData {
  price: number;
  high?: number;
  low?: number;
  open?: number;
  vwap?: number;
  sar?: number;
  rsi?: number;
  change24h?: number;
  volume24h?: number;
  avgVolume?: number;
  bidSpreadPct?: number;
  orderBookImbalance?: number;
  fundingRate?: number;
  htfTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface NormalizedAutopilotSettings {
  tradingMarketMode: TradingMarketMode;
  allowedTradingDirections: AllowedTradingDirections;
  isSymmetricConfidenceFilterEnabled: boolean;
  activeStrategy: string;
  isCommitteeConsensusCheckEnabled: boolean;
}

/**
 * Validates and normalizes persisted settings into a typed configuration contract.
 * Fails closed with explicit rejection codes on invalid mode/direction settings.
 */
export function normalizeAutopilotSettings(rawSettings: any): {
  valid: true;
  settings: NormalizedAutopilotSettings;
} | {
  valid: false;
  rejection: RouteRejection;
} {
  const settingsObj = rawSettings || {};

  // 1. Resolve tradingMarketMode
  const rawMarketMode = settingsObj.tradingMarketMode !== undefined
    ? String(settingsObj.tradingMarketMode).trim().toUpperCase()
    : settingsObj.requestedMode !== undefined
      ? String(settingsObj.requestedMode).trim().toUpperCase()
      : undefined;

  let tradingMarketMode: TradingMarketMode = 'HYBRID';
  if (rawMarketMode !== undefined && rawMarketMode !== '') {
    if (rawMarketMode === 'FUTURES') {
      tradingMarketMode = 'FUTURES';
    } else if (rawMarketMode === 'SPOT') {
      tradingMarketMode = 'SPOT';
    } else if (rawMarketMode === 'HYBRID' || rawMarketMode === 'COMBINED') {
      tradingMarketMode = 'HYBRID';
    } else {
      return {
        valid: false,
        rejection: {
          rejected: true,
          reasonCode: 'INVALID_TRADING_MARKET_MODE',
          reason: `Invalid tradingMarketMode: "${rawMarketMode}". Expected FUTURES | SPOT | HYBRID.`
        }
      };
    }
  }

  // 2. Resolve allowedTradingDirections
  const rawAllowed = settingsObj.allowedTradingDirections !== undefined
    ? String(settingsObj.allowedTradingDirections).trim().toUpperCase()
    : settingsObj.allowedDirections !== undefined
      ? String(settingsObj.allowedDirections).trim().toUpperCase()
      : undefined;

  let allowedTradingDirections: AllowedTradingDirections = 'BOTH';
  if (rawAllowed !== undefined && rawAllowed !== '') {
    if (rawAllowed === 'LONG_ONLY') {
      allowedTradingDirections = 'LONG_ONLY';
    } else if (rawAllowed === 'SHORT_ONLY') {
      allowedTradingDirections = 'SHORT_ONLY';
    } else if (rawAllowed === 'BOTH') {
      allowedTradingDirections = 'BOTH';
    } else {
      return {
        valid: false,
        rejection: {
          rejected: true,
          reasonCode: 'INVALID_ALLOWED_DIRECTIONS',
          reason: `Invalid allowedTradingDirections: "${rawAllowed}". Expected LONG_ONLY | SHORT_ONLY | BOTH.`
        }
      };
    }
  }

  const isSymmetricConfidenceFilterEnabled = Boolean(settingsObj.isSymmetricConfidenceFilterEnabled);
  const activeStrategy = typeof settingsObj.activeStrategy === 'string' && settingsObj.activeStrategy.trim() !== ''
    ? settingsObj.activeStrategy.trim()
    : 'ADAPTIVE_DYNAMIC';
  const isCommitteeConsensusCheckEnabled = settingsObj.isCommitteeConsensusCheckEnabled !== false;

  return {
    valid: true,
    settings: {
      tradingMarketMode,
      allowedTradingDirections,
      isSymmetricConfidenceFilterEnabled,
      activeStrategy,
      isCommitteeConsensusCheckEnabled
    }
  };
}

/**
 * Deterministically resolves direction from scanner signal without fallback to default LONG.
 */
export function extractScannerSignalDirection(scannerSignal: any): { side: TradeSide; action: TradeAction } | null {
  if (!scannerSignal || typeof scannerSignal !== 'object') {
    return null;
  }

  // 1. Explicit side and action
  if (scannerSignal.side === 'SHORT' || scannerSignal.action === 'SELL') {
    return { side: 'SHORT', action: 'SELL' };
  }
  if (scannerSignal.side === 'LONG' || scannerSignal.action === 'BUY') {
    return { side: 'LONG', action: 'BUY' };
  }

  // 2. Explicit boolean isSellSignal
  if (typeof scannerSignal.isSellSignal === 'boolean') {
    return scannerSignal.isSellSignal
      ? { side: 'SHORT', action: 'SELL' }
      : { side: 'LONG', action: 'BUY' };
  }

  // 3. Bounded parser on signal string
  if (typeof scannerSignal.signal === 'string') {
    const sig = scannerSignal.signal.toUpperCase();
    if (sig.includes('STRONG_SELL') || sig.includes('SELL') || sig.includes('SHORT')) {
      return { side: 'SHORT', action: 'SELL' };
    }
    if (sig.includes('STRONG_BUY') || sig.includes('BUY') || sig.includes('LONG')) {
      return { side: 'LONG', action: 'BUY' };
    }
  }

  // 4. Bounded parser on signal type
  if (typeof scannerSignal.type === 'string') {
    const typ = scannerSignal.type.toUpperCase();
    if (typ.includes('ШОРТ') || typ.includes('SHORT') || typ.includes('СЛИВ') || typ.includes('ПРОДАЖ')) {
      return { side: 'SHORT', action: 'SELL' };
    }
    if (typ.includes('ЛОНГ') || typ.includes('LONG') || typ.includes('СПОТ') || typ.includes('ПОКУПК') || typ.includes('ACCUMULATION')) {
      return { side: 'LONG', action: 'BUY' };
    }
  }

  return null;
}

/**
 * Shared, pure, unit-testable factory converting raw scanner inputs into an immutable TradeIntent.
 * Used by all 4 production call sites in server.ts and tests.
 */
export function createAutopilotTradeIntentFromScanner(params: {
  scannerSignal: any;
  symbol: string;
  rawSettings: any;
  rawMarketInput: ScannerMarketInputData;
  sourcePath: 'MAIN_VIRTUAL' | 'WORKER_VIRTUAL' | 'MAIN_REAL_STUB' | 'WORKER_REAL_STUB' | string;
  correlationId?: string;
  signalId?: string;
  strategyId?: string;
  strategyVersion?: string;
}): AutopilotIntentResult {
  const { scannerSignal, symbol, rawSettings, rawMarketInput, sourcePath } = params;
  const now = Date.now();
  const correlationId = params.correlationId || `corr_${now}_${Math.random().toString(36).substring(2, 9)}`;
  const signalId = params.signalId || scannerSignal?.id || `sig_${now}_${Math.random().toString(36).substring(2, 7)}`;
  const intentId = `intent_${now}_${Math.random().toString(36).substring(2, 9)}`;

  // 1. Settings normalization
  const settingsResult = normalizeAutopilotSettings(rawSettings);
  if (settingsResult.valid === false) {
    const rejection = settingsResult.rejection;
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: 'UNKNOWN',
        reasonCode: rejection.reasonCode,
        reason: rejection.reason,
        timestamp: now
      }
    };
  }
  const normSettings = settingsResult.settings;

  // 2. Direction normalization
  const dir = extractScannerSignalDirection(scannerSignal);
  if (!dir) {
    const rejection: RouteRejection = {
      rejected: true,
      reasonCode: 'SIGNAL_DIRECTION_UNRESOLVED',
      reason: 'Не удалось однозначно определить направление сигнала (LONG/SHORT) из сканера'
    };
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: 'UNKNOWN',
        requestedMode: normSettings.tradingMarketMode,
        reasonCode: 'SIGNAL_DIRECTION_UNRESOLVED',
        reason: rejection.reason,
        timestamp: now
      }
    };
  }
  const { side, action } = dir;

  // 3. Directional policy gate
  if (normSettings.allowedTradingDirections === 'LONG_ONLY' && side === 'SHORT') {
    const rejection: RouteRejection = {
      rejected: true,
      reasonCode: 'DIRECTION_NOT_ALLOWED',
      reason: 'Направление SHORT заблокировано настройкой LONG_ONLY'
    };
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: side,
        requestedMode: normSettings.tradingMarketMode,
        reasonCode: 'DIRECTION_NOT_ALLOWED',
        reason: rejection.reason,
        timestamp: now
      }
    };
  }

  if (normSettings.allowedTradingDirections === 'SHORT_ONLY' && side === 'LONG') {
    const rejection: RouteRejection = {
      rejected: true,
      reasonCode: 'DIRECTION_NOT_ALLOWED',
      reason: 'Направление LONG заблокировано настройкой SHORT_ONLY'
    };
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: side,
        requestedMode: normSettings.tradingMarketMode,
        reasonCode: 'DIRECTION_NOT_ALLOWED',
        reason: rejection.reason,
        timestamp: now
      }
    };
  }

  // 4. Market mode routing resolution
  const isSpotSignalSetup = Boolean(
    scannerSignal?.marketType === 'SPOT' ||
    (typeof scannerSignal?.type === 'string' && (scannerSignal.type.includes('Спот') || scannerSignal.type.includes('Spot'))) ||
    scannerSignal?.isSpotBuySetup === true
  );

  let resolvedMarketType: MarketType = 'FUTURES';
  let modeResolutionReason = '';

  if (normSettings.tradingMarketMode === 'FUTURES') {
    resolvedMarketType = 'FUTURES';
    modeResolutionReason = `FUTURES ${side} execution approved`;
  } else if (normSettings.tradingMarketMode === 'SPOT') {
    if (side === 'SHORT' || action === 'SELL') {
      const rejection: RouteRejection = {
        rejected: true,
        reasonCode: 'SPOT_SHORT_UNSUPPORTED',
        reason: 'Спотовая торговля не поддерживает SHORT позиции (fail-closed, без fallback в futures)'
      };
      return {
        ok: false,
        rejection,
        auditContext: {
          sourcePath,
          symbol,
          signalId,
          correlationId,
          scannerSide: side,
          requestedMode: normSettings.tradingMarketMode,
          resolvedMarketType: 'SPOT',
          reasonCode: 'SPOT_SHORT_UNSUPPORTED',
          reason: rejection.reason,
          timestamp: now
        }
      };
    }
    resolvedMarketType = 'SPOT';
    modeResolutionReason = 'SPOT LONG accumulation execution approved';
  } else {
    // HYBRID mode
    if (side === 'SHORT') {
      if (scannerSignal?.marketType === 'SPOT' && (scannerSignal?.signal === 'SPOT_SHORT' || scannerSignal?.type?.includes('Spot Short'))) {
        const rejection: RouteRejection = {
          rejected: true,
          reasonCode: 'SPOT_SHORT_UNSUPPORTED',
          reason: 'Спотовая торговля не поддерживает SHORT позиции'
        };
        return {
          ok: false,
          rejection,
          auditContext: {
            sourcePath,
            symbol,
            signalId,
            correlationId,
            scannerSide: side,
            requestedMode: normSettings.tradingMarketMode,
            resolvedMarketType: 'SPOT',
            reasonCode: 'SPOT_SHORT_UNSUPPORTED',
            reason: rejection.reason,
            timestamp: now
          }
        };
      }
      resolvedMarketType = 'FUTURES';
      modeResolutionReason = 'HYBRID mode routed SHORT signal to FUTURES';
    } else {
      // LONG in HYBRID
      if (isSpotSignalSetup) {
        resolvedMarketType = 'SPOT';
        modeResolutionReason = 'HYBRID mode routed Spot Accumulation LONG to SPOT';
      } else {
        resolvedMarketType = 'FUTURES';
        modeResolutionReason = 'HYBRID mode routed Trend LONG to FUTURES';
      }
    }
  }

  // 5. Market snapshot completeness check
  if (!rawMarketInput || typeof rawMarketInput !== 'object') {
    const rejection: RouteRejection = {
      rejected: true,
      reasonCode: 'MARKET_DATA_INCOMPLETE',
      reason: 'Missing market input data'
    };
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: side,
        requestedMode: normSettings.tradingMarketMode,
        resolvedMarketType,
        reasonCode: 'MARKET_DATA_INCOMPLETE',
        reason: rejection.reason,
        timestamp: now
      }
    };
  }

  const {
    price,
    high = rawMarketInput.price,
    low = rawMarketInput.price,
    open = rawMarketInput.price,
    vwap = rawMarketInput.price,
    sar = rawMarketInput.price,
    rsi = 50,
    change24h = 0,
    volume24h = 0,
    avgVolume = 0,
    bidSpreadPct,
    orderBookImbalance,
    fundingRate,
    htfTrend
  } = rawMarketInput;

  if (
    typeof price !== 'number' || isNaN(price) || price <= 0 ||
    typeof high !== 'number' || isNaN(high) || high <= 0 ||
    typeof low !== 'number' || isNaN(low) || low <= 0 ||
    typeof open !== 'number' || isNaN(open) || open <= 0 ||
    typeof vwap !== 'number' || isNaN(vwap) || vwap <= 0 ||
    typeof sar !== 'number' || isNaN(sar) || sar <= 0 ||
    typeof rsi !== 'number' || isNaN(rsi) || rsi < 0 || rsi > 100 ||
    typeof volume24h !== 'number' || isNaN(volume24h) || volume24h < 0 ||
    typeof avgVolume !== 'number' || isNaN(avgVolume) || avgVolume < 0 ||
    typeof change24h !== 'number' || isNaN(change24h)
  ) {
    const rejection: RouteRejection = {
      rejected: true,
      reasonCode: 'MARKET_DATA_INCOMPLETE',
      reason: `Рыночные данные неполные или содержат некорректные значения (price=${price}, high=${high}, low=${low}, open=${open}, vwap=${vwap}, sar=${sar}, rsi=${rsi})`
    };
    return {
      ok: false,
      rejection,
      auditContext: {
        sourcePath,
        symbol,
        signalId,
        correlationId,
        scannerSide: side,
        requestedMode: normSettings.tradingMarketMode,
        resolvedMarketType,
        reasonCode: 'MARKET_DATA_INCOMPLETE',
        reason: rejection.reason,
        timestamp: now
      }
    };
  }

  const snapshot: MarketSnapshot = Object.freeze({
    price,
    high,
    low,
    open,
    vwap,
    sar,
    rsi,
    change24h,
    volume24h,
    avgVolume,
    bidSpreadPct,
    orderBookImbalance,
    fundingRate,
    htfTrend
  });

  const intent: TradeIntent = Object.freeze({
    intentId,
    correlationId,
    signalId,
    symbol,
    side,
    action,
    marketType: resolvedMarketType,
    requestedMode: normSettings.tradingMarketMode,
    allowedDirections: normSettings.allowedTradingDirections,
    strategyId: params.strategyId || 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: params.strategyVersion || '2.1.0',
    source: 'SCANNER',
    createdAt: now,
    marketSnapshot: snapshot,
    pattern: scannerSignal?.pattern || scannerSignal?.type,
    score: scannerSignal?.aiScore,
    modeResolutionReason
  });

  const strategyContext: StrategyMarketInput = Object.freeze({
    symbol,
    marketType: intent.marketType,
    tradingMode: intent.requestedMode,
    side: intent.side,
    action: intent.action,
    allowedTradingDirections: intent.allowedDirections,
    allowedDirections: intent.allowedDirections,
    isSymmetricConfidenceFilterEnabled: normSettings.isSymmetricConfidenceFilterEnabled,
    activeStrategy: normSettings.activeStrategy,
    isCommitteeConsensusEnabled: normSettings.isCommitteeConsensusCheckEnabled,
    price: snapshot.price,
    high: snapshot.high,
    low: snapshot.low,
    open: snapshot.open,
    vwap: snapshot.vwap,
    sar: snapshot.sar,
    rsi: snapshot.rsi,
    change24h: snapshot.change24h,
    volume24h: snapshot.volume24h,
    avgVolume: snapshot.avgVolume,
    bidSpreadPct: snapshot.bidSpreadPct,
    orderBookImbalance: snapshot.orderBookImbalance,
    fundingRate: snapshot.fundingRate,
    htfTrend: snapshot.htfTrend,
    tradeIntent: intent
  });

  return {
    ok: true,
    intent,
    strategyContext
  };
}
