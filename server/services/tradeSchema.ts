export type DataOrigin = 
  | 'LIVE' 
  | 'LIVE_WEEX'
  | 'PAPER' 
  | 'PAPER_SIM'
  | 'SEED' 
  | 'HISTORICAL_SEED'
  | 'FORCED_RESET' 
  | 'MANUAL_IMPORT' 
  | 'LEGACY_UNKNOWN';
export type DecisionSource = 'RULE_ENGINE' | 'AI' | 'COMMITTEE' | 'FALLBACK' | 'FALLBACK_RULE' | 'MANUAL';
export type CloseReasonCode =
  | 'TAKE_PROFIT'
  | 'MULTI_TP_PARTIAL'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'PTTP'
  | 'TIMEOUT_PROFIT'
  | 'TIMEOUT_SAFETY'
  | 'MAX_LIFETIME'
  | 'EMERGENCY_MAX_LIFETIME'
  | 'EMERGENCY_HARD_STOP'
  | 'MANUAL'
  | 'EXCHANGE_FILLED'
  | 'FORCED_RESET'
  | 'UNKNOWN';

export interface TradeAuditFields {
  dataOrigin: DataOrigin;
  decisionSource: DecisionSource;
  strategyId?: string;
  strategyVersion?: string;
  signalId?: string;
  correlationId?: string;
  matchedRuleIds?: string[];
  committeeDecisionId?: string;
  agentDecisionIds?: string[];
  closeReasonCode?: CloseReasonCode;
  closeReasonText?: string;
  stateRevision?: number;
  createdAt?: number;
  updatedAt?: number;
}

export function inferDataOrigin(trade: any): DataOrigin {
  if (!trade) return 'LEGACY_UNKNOWN';
  if (trade.dataOrigin) return trade.dataOrigin;

  // Check ID patterns or explicit attributes
  const tradeId = String(trade.id || '');
  if (tradeId.startsWith('hist_trade_') || tradeId.startsWith('seed_')) {
    return 'SEED';
  }

  const allText = `${trade.closeReason || ''} ${trade.closeReasonText || ''} ${trade.exitReason || ''} ${trade.aiEvaluation || ''} ${trade.learnedRule || ''}`.toUpperCase();
  if (
    allText.includes('ПРИНУДИТЕЛЬНО ЗАКРЫТА ПРИ СМЕНЕ ВИРТУАЛЬНОГО БАЛАНСА') ||
    allText.includes('FORCED_RESET') ||
    trade.isForcedReset === true
  ) {
    return 'FORCED_RESET';
  }

  if (trade.isReal || trade.mode === 'REAL' || trade.marketType === 'real') {
    return 'LIVE';
  }

  if (trade.isPaper || trade.mode === 'PAPER' || trade.mode === 'AUTO' || trade.mode === 'SEMI_AUTO' || trade.mode === 'MANUAL' || trade.mode === 'virtual') {
    return 'PAPER';
  }

  return 'LEGACY_UNKNOWN';
}

export function inferDecisionSource(trade: any): DecisionSource {
  if (!trade) return 'RULE_ENGINE';
  if (trade.decisionSource) return trade.decisionSource;
  if (trade.committeeDecisionId || trade.committeeApproved) return 'COMMITTEE';
  if (trade.aiApproved || trade.aiAnalysis) return 'AI';
  if (trade.mode === 'MANUAL' || trade.isManual) return 'MANUAL';
  return 'RULE_ENGINE';
}

export function inferCloseReasonCode(trade: any): CloseReasonCode {
  if (!trade) return 'UNKNOWN';
  if (trade.closeReasonCode && trade.closeReasonCode !== 'UNKNOWN') return trade.closeReasonCode;

  const reasonStr = `${trade.closeReason || ''} ${trade.closeReasonText || ''} ${trade.exitReason || ''} ${trade.aiEvaluation || ''} ${trade.learnedRule || ''} ${trade.notes || ''} ${trade.feedback || ''} ${trade.aiAdvice || ''}`.toUpperCase();

  if (reasonStr.includes('FORCED_RESET') || reasonStr.includes('СМЕНЕ ВИРТУАЛЬНОГО БАЛАНСА') || trade.isForcedReset === true) return 'FORCED_RESET';
  if (reasonStr.includes('TAKE_PROFIT') || reasonStr.includes('TAKE PROFIT') || reasonStr.includes('TP_HIT') || reasonStr.includes('ТЕЙК') || reasonStr.includes('ПРОФИТ')) return 'TAKE_PROFIT';
  if (reasonStr.includes('PARTIAL') || reasonStr.includes('MULTI_TP')) return 'MULTI_TP_PARTIAL';
  if (reasonStr.includes('STOP_LOSS') || reasonStr.includes('STOP LOSS') || reasonStr.includes('SL_HIT') || reasonStr.includes('СТОП') || reasonStr.includes('ЛОСС')) return 'STOP_LOSS';
  if (reasonStr.includes('TRAILING') || reasonStr.includes('ТРЕЙЛИНГ')) return 'TRAILING_STOP';
  if (reasonStr.includes('PTTP') || reasonStr.includes('ПИКОВ') || reasonStr.includes('ФИКСАЦИЯ СКАЛЬПА')) return 'PTTP';
  if (reasonStr.includes('TIMEOUT_PROFIT') || reasonStr.includes('ТАЙМАУТ')) return 'TIMEOUT_PROFIT';
  if (reasonStr.includes('TIMEOUT_SAFETY') || reasonStr.includes('BREAKEVEN') || reasonStr.includes('БЕЗУБЫТ') || reasonStr.includes('БЕЗОПАСН')) return 'TIMEOUT_SAFETY';
  if (reasonStr.includes('MAX_LIFETIME') || reasonStr.includes('ВРЕМЯ ЖИЗНИ')) return 'MAX_LIFETIME';
  if (reasonStr.includes('EMERGENCY') || reasonStr.includes('HARD_STOP') || reasonStr.includes('ЛИКВИДАЦИ')) return 'EMERGENCY_HARD_STOP';
  if (reasonStr.includes('MANUAL') || reasonStr.includes('РУЧН')) return 'MANUAL';
  if (reasonStr.includes('EXCHANGE')) return 'EXCHANGE_FILLED';

  // Numerical PnL inference fallback
  if (typeof trade.pnl === 'number' || typeof trade.pnlPercent === 'number' || typeof trade.realizedPnl === 'number') {
    const pnlVal = Number(trade.pnl || trade.pnlPercent || trade.realizedPnl || 0);
    if (pnlVal > 0) return 'TAKE_PROFIT';
    if (pnlVal < 0) return 'STOP_LOSS';
  }

  return 'UNKNOWN';
}
