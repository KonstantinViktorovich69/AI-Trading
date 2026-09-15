import { TradeIntent } from './tradeIntent.ts';
import { EntryDecision } from '../services/strategyEngine.ts';

export interface ApprovedExecutionIntent {
  intent: TradeIntent;
  decision: EntryDecision;
  calculatedAmount: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  tpStages?: any[];
  gridOrders?: any[];
  isReal: boolean;
}

export interface ApprovedCloseIntent {
  tradeId: string;
  symbol: string;
  marketType: 'FUTURES' | 'SPOT';
  closeRatio?: number;
  reason?: string;
}

export interface ExecutionResult {
  success: boolean;
  entryPrice?: number;
  orderId?: string;
  error?: string;
}

export interface RiskOrderResult {
  success: boolean;
  error?: string;
}

export interface FuturesExecutionPort {
  openFutures(input: ApprovedExecutionIntent): Promise<ExecutionResult>;
  setFuturesRiskOrders(input: ApprovedExecutionIntent): Promise<RiskOrderResult>;
}

export interface SpotExecutionPort {
  openSpotBuy(input: ApprovedExecutionIntent): Promise<ExecutionResult>;
  closeSpotPosition(input: ApprovedCloseIntent): Promise<ExecutionResult>;
}
