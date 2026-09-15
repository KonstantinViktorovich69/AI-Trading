import type { DecisionSource } from './tradeSchema.ts';
import type { SignalDecision } from './strategyEngine.ts';

export interface DecisionCorrelationContext {
  correlationId: string;
  proposedTradeId: string;
  signalId: string;
  entryIntentId?: string;
  strategyId: string;
  strategyVersion: string;
  stateRevision: number;
  emittedAt: number;
  timestamp?: number;
}

export interface AgentDecisionEnvelope {
  decisionId: string;
  agentName: 'HUNTER' | 'BEAR' | 'COMMITTEE' | 'SYSTEM_FALLBACK';
  signalId?: string;
  tradeId?: string;
  proposedTradeId?: string;
  correlationId?: string;
  stateRevision?: number;
  strategyId: string;
  strategyVersion: string;
  action: 'APPROVE' | 'REJECT' | 'HOLD' | 'NO_TRADE';
  confidence: number;
  approved: boolean;
  decisionSource: DecisionSource;
  rationale: string;
  inputDataHash?: string;
  createdAt: number;
  emittedAt?: number;
}

/**
 * Creates AI Fallback Envelope when AI key is missing, rate-limited, or fails.
 */
export function createAiFallbackDecision(
  signal: Partial<SignalDecision>,
  contextType: 'NEW_ENTRY' | 'ACTIVE_POSITION'
): AgentDecisionEnvelope {
  const decisionId = `dec_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY);

  const rationale = hasKey
    ? 'AI сервис временно недоступен (таймаут/ошибка). Применен защитный режим (Fallback).'
    : 'Ключ AI (GEMINI_API_KEY) не настроен. Сигналы и позиции обрабатываются через детерминированный движок рисков (Fallback).';

  if (contextType === 'NEW_ENTRY') {
    return {
      decisionId,
      agentName: 'SYSTEM_FALLBACK',
      signalId: signal.signalId,
      strategyId: signal.strategyId || 'CANONICAL_QUANT_SCALP_V2',
      strategyVersion: signal.strategyVersion || '2.1.0',
      action: 'NO_TRADE',
      confidence: 0,
      approved: false,
      decisionSource: 'FALLBACK',
      rationale,
      createdAt: Date.now()
    };
  } else {
    return {
      decisionId,
      agentName: 'SYSTEM_FALLBACK',
      signalId: signal.signalId,
      strategyId: signal.strategyId || 'CANONICAL_QUANT_SCALP_V2',
      strategyVersion: signal.strategyVersion || '2.1.0',
      action: 'HOLD',
      confidence: 50,
      approved: true, // Allow position to be managed by deterministic ExitPolicy
      decisionSource: 'FALLBACK',
      rationale: `${rationale} Передача управления в ExitPolicy.`,
      createdAt: Date.now()
    };
  }
}

/**
 * Committee Consensus Evaluator
 */
export function evaluateCommitteeConsensus(
  hunterDecision: AgentDecisionEnvelope,
  bearDecision: AgentDecisionEnvelope,
  isConsensusCheckEnabled: boolean = true
): AgentDecisionEnvelope {
  const committeeDecisionId = `comm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  if (!isConsensusCheckEnabled) {
    // Shadow mode
    return {
      decisionId: committeeDecisionId,
      agentName: 'COMMITTEE',
      signalId: hunterDecision.signalId,
      strategyId: hunterDecision.strategyId,
      strategyVersion: hunterDecision.strategyVersion,
      action: hunterDecision.action,
      confidence: hunterDecision.confidence,
      approved: hunterDecision.approved,
      decisionSource: 'COMMITTEE',
      rationale: `[Теневой режим Комитета] Принято решение Охотника: ${hunterDecision.rationale}`,
      createdAt: Date.now()
    };
  }

  // Active Committee Rule: Both Hunter and Bear must approve, or Hunter approve & Bear no hard reject
  if (hunterDecision.approved && !bearDecision.approved && bearDecision.action === 'REJECT') {
    return {
      decisionId: committeeDecisionId,
      agentName: 'COMMITTEE',
      signalId: hunterDecision.signalId,
      strategyId: hunterDecision.strategyId,
      strategyVersion: hunterDecision.strategyVersion,
      action: 'REJECT',
      confidence: Math.min(hunterDecision.confidence, bearDecision.confidence),
      approved: false,
      decisionSource: 'COMMITTEE',
      rationale: `Комитет отклонил сигнал: Риск-менеджер (Медведь) наложил вето (${bearDecision.rationale})`,
      createdAt: Date.now()
    };
  }

  const avgConfidence = Math.round((hunterDecision.confidence + bearDecision.confidence) / 2);
  const isApproved = hunterDecision.approved && (bearDecision.approved || bearDecision.action !== 'REJECT');

  return {
    decisionId: committeeDecisionId,
    agentName: 'COMMITTEE',
    signalId: hunterDecision.signalId,
    strategyId: hunterDecision.strategyId,
    strategyVersion: hunterDecision.strategyVersion,
    action: isApproved ? 'APPROVE' : 'REJECT',
    confidence: avgConfidence,
    approved: isApproved,
    decisionSource: 'COMMITTEE',
    rationale: `Консенсус Комитета достигнут (${hunterDecision.agentName} + ${bearDecision.agentName}). Уверенность: ${avgConfidence}%`,
    createdAt: Date.now()
  };
}
