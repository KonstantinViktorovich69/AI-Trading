import { describe, it, expect } from 'vitest';
import { createAiFallbackDecision, evaluateCommitteeConsensus, type AgentDecisionEnvelope } from './agentEngine.ts';

describe('AgentEngine - Decision Envelopes & AI Fallback Mode', () => {
  it('creates NO_TRADE fallback envelope for new entry when AI fails or key is unconfigured', () => {
    const fallback = createAiFallbackDecision({ signalId: 'sig_100', strategyId: 'CANONICAL_V2' }, 'NEW_ENTRY');

    expect(fallback.agentName).toBe('SYSTEM_FALLBACK');
    expect(fallback.action).toBe('NO_TRADE');
    expect(fallback.approved).toBe(false);
    expect(fallback.decisionSource).toBe('FALLBACK');
    expect(fallback.decisionId).toBeDefined();
  });

  it('creates HOLD fallback envelope for active position during AI outage', () => {
    const fallback = createAiFallbackDecision({ signalId: 'sig_101' }, 'ACTIVE_POSITION');

    expect(fallback.agentName).toBe('SYSTEM_FALLBACK');
    expect(fallback.action).toBe('HOLD');
    expect(fallback.approved).toBe(true);
    expect(fallback.decisionSource).toBe('FALLBACK');
  });

  it('evaluates committee veto when Risk-Bear rejects Hunter approval', () => {
    const hunter: AgentDecisionEnvelope = {
      decisionId: 'dec_h_1',
      agentName: 'HUNTER',
      signalId: 'sig_102',
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      action: 'APPROVE',
      confidence: 85,
      approved: true,
      decisionSource: 'AI',
      rationale: 'Strong momentum',
      createdAt: Date.now()
    };

    const bear: AgentDecisionEnvelope = {
      decisionId: 'dec_b_1',
      agentName: 'BEAR',
      signalId: 'sig_102',
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      action: 'REJECT',
      confidence: 90,
      approved: false,
      decisionSource: 'RULE_ENGINE',
      rationale: 'Overbought resistance level',
      createdAt: Date.now()
    };

    const consensus = evaluateCommitteeConsensus(hunter, bear, true);
    expect(consensus.action).toBe('REJECT');
    expect(consensus.approved).toBe(false);
    expect(consensus.decisionSource).toBe('COMMITTEE');
    expect(consensus.rationale).toContain('Медведь');
  });
});
