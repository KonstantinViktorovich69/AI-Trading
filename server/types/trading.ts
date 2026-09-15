export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGING_FLAT' | 'HIGH_VOLATILITY' | 'EXTREME_SQUEEZE' | 'NEUTRAL';

export interface DecisionFactor {
  name: string;
  category: 'TECHNICAL' | 'ORDERBOOK' | 'VOLUME' | 'STRUCTURE' | 'RISK' | 'SENTIMENT';
  value: string | number;
  weight: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  passed: boolean;
  notes?: string;
}

export interface AgentVoteTrace {
  agentId: string;
  agentName: string;
  role: 'SCOUT' | 'BULL_ANALYST' | 'BEAR_ANALYST' | 'RISK_SENTINEL' | 'LIQUIDITY_HUNTER' | 'CHIEF_JUDGE';
  vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD';
  confidence: number;
  assignedWeight: number;
  weightedScore: number;
  reason: string;
  timestamp: number;
}

export interface DecisionTrace {
  id: string;
  timestamp: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  marketRegime: MarketRegime;
  regimeConfidence: number;
  factors: DecisionFactor[];
  agentVotes: AgentVoteTrace[];
  consensusScore: number;
  requiredScore: number;
  passedConsensus: boolean;
  rejectionReasons?: string[];
  executionMode: 'REAL' | 'PAPER' | 'BACKTEST';
  triggerPattern?: string;
  metadata?: Record<string, any>;
}

export interface SignalData {
  symbol: string;
  exchange: string;
  signal: 'SHORT' | 'LONG' | 'NEUTRAL';
  marketType?: 'FUTURES' | 'SPOT';
  aiScore: number;
  price: number;
  change24h?: number;
  volume24h?: number;
  vwap?: number;
  sarStatus?: 'BEARISH' | 'BULLISH';
  wickRatio?: number;
  timeframe?: string;
  reason?: string;
  timestamp: number;
  patternName?: string;
  isLiquiditySweep?: boolean;
  isBinanceCrossListed?: boolean;
  marketRegime?: MarketRegime;
  decisionTrace?: DecisionTrace;
}

export type TradingMode = 'FUTURES' | 'SPOT' | 'COMBINED';

export interface SystemTradingSettings {
  tradingMode: TradingMode;
  excludeBinanceCrossListed: boolean;
  minVolumeUsdt: number;
  minAiScore: number;
  futuresLeverage: number;
  spotDcaEnabled: boolean;
}

export interface TradePosition {
  id: string;
  symbol: string;
  exchange: string;
  marketType?: 'FUTURES' | 'SPOT';
  side: 'SHORT' | 'LONG';
  status: 'OPEN' | 'CLOSED';
  entryPrice: number;
  closePrice?: number;
  amount: number;
  leverage: number;
  pnl?: number;
  pnlPercent?: number;
  stopLoss?: number;
  takeProfit?: number;
  signalAiScore?: number;
  isReal?: boolean;
  mode?: 'AUTO' | 'MANUAL';
  openTime: number;
  closeTime?: number;
  marketRegime?: MarketRegime;
  decisionTrace?: DecisionTrace;
  history?: Array<{
    timestamp: number;
    type: string;
    price: number;
    message?: string;
  }>;
}

export interface KnowledgeRule {
  id: string;
  title: string;
  category: 'PATTERN' | 'RISK' | 'INDICATOR' | 'REGIME' | 'GENERAL';
  sideTarget?: 'LONG' | 'SHORT' | 'BOTH';
  marketRegimeTarget?: MarketRegime | 'ALL';
  ruleText: string;
  confidenceScore: number;
  winRate: number;
  totalTrades: number;
  isArchived: boolean;
  archivalReason?: string;
  marketRegime?: string;
  createdAt: number;
  updatedAt: number;
}

