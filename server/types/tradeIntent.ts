export type TradeSide = 'LONG' | 'SHORT';
export type TradeAction = 'BUY' | 'SELL';
export type MarketType = 'FUTURES' | 'SPOT';
export type TradingMarketMode = 'FUTURES' | 'SPOT' | 'HYBRID';
export type AllowedTradingDirections = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH';

export interface MarketSnapshot {
  price: number;
  high: number;
  low: number;
  open: number;
  vwap: number;
  sar: number;
  rsi: number;
  change24h: number;
  volume24h: number;
  avgVolume: number;
  bidSpreadPct?: number;
  orderBookImbalance?: number;
  fundingRate?: number;
  htfTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface TradeIntent {
  intentId: string;
  correlationId: string;
  signalId: string;
  symbol: string;
  side: TradeSide;
  action: TradeAction;
  marketType: MarketType;
  requestedMode: TradingMarketMode;
  allowedDirections: AllowedTradingDirections;
  strategyId: string;
  strategyVersion: string;
  source: 'SCANNER' | 'MANUAL' | 'RECOVERY';
  createdAt: number;
  marketSnapshot: MarketSnapshot;
  pattern?: string;
  score?: number;
  gateDiagnostics?: Record<string, boolean>;
  modeResolutionReason?: string;
}

export type RejectionReasonCode =
  | 'SIGNAL_DIRECTION_UNRESOLVED'
  | 'MARKET_DATA_INCOMPLETE'
  | 'DIRECTION_NOT_ALLOWED'
  | 'INVALID_TRADING_MARKET_MODE'
  | 'INVALID_ALLOWED_DIRECTIONS'
  | 'TRADE_INTENT_REQUIRED_FOR_AUTOPILOT'
  | 'SPOT_SHORT_UNSUPPORTED'
  | 'SIDE_MISMATCH_BETWEEN_INTENT_AND_STRATEGY'
  | 'EXECUTION_SIDE_INVARIANT_VIOLATION'
  | 'DATA_INCOMPLETE'
  | 'HIGH_SPREAD'
  | 'LOW_LIQUIDITY'
  | 'EXTREME_FUNDING'
  | 'NO_PATTERN'
  | 'DIRECTION_MISMATCH'
  | 'PATTERN_BLACKLISTED'
  | 'CONFIDENCE_TOO_LOW'
  | 'COMMITTEE_VETO'
  | 'SHORT_LATE_ENTRY'
  | 'SHORT_BTC_HYPERGROWTH'
  | 'SHORT_BULL_REGIME'
  | 'SHORT_WIDE_SPREAD'
  | 'SHORT_MISSING_REVERSAL_CONFIRMATION'
  | 'SPOT_REAL_EXECUTION_NOT_CONFIGURED';

export interface ResolvedMarketRoute {
  resolvedMarketType: MarketType;
  side: TradeSide;
  action: TradeAction;
  reason?: string;
}

export interface RouteRejection {
  rejected: true;
  reasonCode: RejectionReasonCode;
  reason: string;
}

export type ModeResolutionResult =
  | { success: true; route: ResolvedMarketRoute }
  | { success: false; rejection: RouteRejection };
