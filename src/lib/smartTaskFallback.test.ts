import { describe, it, expect } from 'vitest';
import { buildSmartTaskFallback } from './smartTaskFallback.ts';

describe('buildSmartTaskFallback (T1.2)', () => {
  it('returns empty array when JSON array is expected', () => {
    const res = buildSmartTaskFallback({
      params: { config: { responseSchema: { type: 'ARRAY' } } }
    });
    expect(res).toBe('[]');
  });

  it('returns neutral retrospective without fake winRate and expertModifications', () => {
    const res = buildSmartTaskFallback({
      params: { contents: [{ parts: [{ text: 'getRetrospectivePrompt retrospectiveSummary' }] }] }
    });
    const parsed = JSON.parse(res);
    expect(parsed.retrospectiveSummary).toBe('ИИ недоступен, ретроспектива пропущена');
    expect(parsed.winRate).toBeUndefined();
    expect(parsed.expertModifications).toBe('');
    expect(parsed.agentExchangeConversations).toEqual([]);
    expect(parsed.isFallback).toBe(true);
  });

  it('returns HOLD for expert position management prompts', () => {
    const res = buildSmartTaskFallback({
      params: { contents: [{ parts: [{ text: 'expertPrompt ИИ-Ведущий Трейдер' }] }] }
    });
    const parsed = JSON.parse(res);
    expect(parsed.action).toBe('HOLD');
    expect(parsed.newSl).toBeNull();
    expect(parsed.newTp).toBeNull();
    expect(parsed.isFallback).toBe(true);
  });

  it('returns NEUTRAL/HOLD/approved=false for signal analysis prompts', () => {
    const res = buildSmartTaskFallback({
      params: { contents: [{ parts: [{ text: 'judgeDecision techAnalyst getSignalAnalysisPrompt' }] }] }
    });
    const parsed = JSON.parse(res);
    expect(parsed.consensus).toBe('НЕТ ДАННЫХ');
    expect(parsed.judgeDecision).toBe('NEUTRAL');
    expect(parsed.approved).toBe(false);
    expect(parsed.aiScore).toBe(0);
    expect(parsed.action).toBe('HOLD');
    expect(parsed.wouldBlock).toBe(true);
    expect(parsed.isFallback).toBe(true);
  });
});
