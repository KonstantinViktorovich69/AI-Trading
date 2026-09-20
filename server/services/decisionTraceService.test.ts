import { describe, it, expect } from 'vitest';
import { 
  DecisionTraceService, 
  DISSENT_PENALTY_MULTIPLIER, 
  DecisionTraceBuildParams 
} from './decisionTraceService.ts';

describe('DecisionTraceService - consensusScore and dissent penalty', () => {
  it('exports DISSENT_PENALTY_MULTIPLIER set to 1.5', () => {
    expect(DISSENT_PENALTY_MULTIPLIER).toBe(1.5);
  });

  it('calculates score identically to legacy formula when there are NO dissenters (all APPROVE)', () => {
    const params: DecisionTraceBuildParams = {
      symbol: 'BTCUSDT',
      side: 'LONG',
      marketRegime: 'TREND_UP',
      agentWeights: { scout: 1.0, bull: 1.0, liquidity: 1.2, risk: 1.5 },
      rawAgentScores: {
        scout: { score: 85, reason: 'Breakout', vote: 'APPROVE_LONG' },
        bull: { score: 90, reason: 'Bullish candle', vote: 'APPROVE_LONG' },
        liquidity: { score: 80, reason: 'Sweep', vote: 'APPROVE_LONG' },
        risk: { score: 75, reason: 'Risk acceptable', vote: 'APPROVE_LONG' }
      }
    };

    const trace = DecisionTraceService.buildTrace(params);

    // Legacy formula: Math.round(weightedSum / totalWeight)
    const weights = [1.0, 1.0, 1.2, 1.5];
    const scores = [85, 90, 80, 75];
    const totalWeight = weights.reduce((a, b) => a + b, 0); // 4.7
    const weightedSum = scores.reduce((acc, s, idx) => acc + s * weights[idx], 0); // 85*1 + 90*1 + 80*1.2 + 75*1.5 = 85 + 90 + 96 + 112.5 = 383.5
    const legacyExpected = Math.round(weightedSum / totalWeight); // 383.5 / 4.7 = 81.5957... -> 82

    expect(trace.consensusScore).toBe(legacyExpected);
    expect(trace.consensusScore).toBe(82);
  });

  it('calculates score identically to legacy formula when there are APPROVE and HOLD votes (no dissent)', () => {
    const params: DecisionTraceBuildParams = {
      symbol: 'ETHUSDT',
      side: 'SHORT',
      marketRegime: 'TREND_DOWN',
      agentWeights: { scout: 1.0, bear: 1.0, liquidity: 1.0, risk: 1.2 },
      rawAgentScores: {
        scout: { score: 80, reason: 'Drop signal', vote: 'APPROVE_SHORT' },
        bear: { score: 85, reason: 'Bearish momentum', vote: 'APPROVE_SHORT' },
        liquidity: { score: 70, reason: 'Uncertain liquidity', vote: 'HOLD' },
        risk: { score: 60, reason: 'Borderline volatility', vote: 'HOLD' }
      }
    };

    const trace = DecisionTraceService.buildTrace(params);

    // Legacy formula:
    // scout: 80 * 1.0 = 80
    // bear: 85 * 1.0 = 85
    // liquidity: (70 * 0.5) * 1.0 = 35
    // risk: (60 * 0.5) * 1.2 = 36
    // weightedSum = 80 + 85 + 35 + 36 = 236
    // totalWeight = 1.0 + 1.0 + 1.0 + 1.2 = 4.2
    // legacyExpected = Math.round(236 / 4.2) = Math.round(56.19) = 56
    const legacyExpected = Math.round(236 / 4.2);

    expect(trace.consensusScore).toBe(legacyExpected);
    expect(trace.consensusScore).toBe(56);
  });

  it('penalizes noticeably when one agent with high confidence and weight dissents', () => {
    // Baseline with 3 APPROVE_LONG and 1 HOLD
    const baselineParams: DecisionTraceBuildParams = {
      symbol: 'SOLUSDT',
      side: 'LONG',
      agentWeights: { scout: 1.0, bull: 1.0, liquidity: 1.0, risk: 1.5 },
      marketRegime: 'RANGING_FLAT',
      rawAgentScores: {
        scout: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        bull: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        liquidity: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        risk: { score: 80, reason: 'Caution', vote: 'HOLD' }
      }
    };
    const baselineTrace = DecisionTraceService.buildTrace(baselineParams);
    // Baseline: (85*1 + 85*1 + 85*1 + 40*1.5) / 4.5 = (255 + 60) / 4.5 = 315 / 4.5 = 70
    expect(baselineTrace.consensusScore).toBe(70);

    // Now Risk Sentinel explicitly REJECTS with high confidence 85 and weight 1.5
    const dissenterParams: DecisionTraceBuildParams = {
      symbol: 'SOLUSDT',
      side: 'LONG',
      agentWeights: { scout: 1.0, bull: 1.0, liquidity: 1.0, risk: 1.5 },
      marketRegime: 'RANGING_FLAT',
      rawAgentScores: {
        scout: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        bull: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        liquidity: { score: 85, reason: 'Good', vote: 'APPROVE_LONG' },
        risk: { score: 85, reason: 'Critical danger detected', vote: 'REJECT' }
      }
    };
    const dissenterTrace = DecisionTraceService.buildTrace(dissenterParams);

    // Under old formula without penalty:
    // weightedSum = 85*1 + 85*1 + 85*1 + 0 = 255
    // totalWeight = 4.5
    // oldScore = Math.round(255 / 4.5) = 57
    //
    // Under new formula with dissent penalty:
    // weightedSum = 255
    // dissentPenalty = 85 * 1.5 (weight) * 1.5 (multiplier) = 191.25
    // rawScore = (255 - 191.25) / 4.5 = 63.75 / 4.5 = 14.166...
    // consensusScore = Math.round(14.166...) = 14
    expect(dissenterTrace.consensusScore).toBe(14);
    expect(dissenterTrace.consensusScore).toBeLessThan(57); // Noticeably lower than old formula
  });

  it('drastically drops score when multiple agents dissent simultaneously', () => {
    const params: DecisionTraceBuildParams = {
      symbol: 'AVAXUSDT',
      side: 'LONG',
      agentWeights: { scout: 1.0, bull: 1.0, bear: 1.0, risk: 1.2 },
      marketRegime: 'RANGING_FLAT',
      rawAgentScores: {
        scout: { score: 75, reason: 'Impulse', vote: 'APPROVE_LONG' },
        bull: { score: 70, reason: 'Support', vote: 'APPROVE_LONG' },
        bear: { score: 80, reason: 'Heavy resistance', vote: 'APPROVE_SHORT' }, // dissenting vote against LONG
        risk: { score: 85, reason: 'Overleveraged market', vote: 'REJECT' }       // dissenting vote against LONG
      }
    };

    const trace = DecisionTraceService.buildTrace(params);

    // weightedSum = 75*1.0 + 70*1.0 = 145
    // totalWeight = 1.0 + 1.0 + 1.0 + 1.2 = 4.2
    // dissentPenalty = (80 * 1.0 * 1.5) + (85 * 1.2 * 1.5) = 120 + 153 = 273
    // rawScore = (145 - 273) / 4.2 = -128 / 4.2 = -30.476
    // consensusScore = Math.max(0, Math.round(-30.476)) = 0
    expect(trace.consensusScore).toBe(0);
  });

  it('handles extreme case where ALL agents dissent without dropping below 0', () => {
    const params: DecisionTraceBuildParams = {
      symbol: 'DOGEUSDT',
      side: 'SHORT',
      agentWeights: { scout: 1.0, bull: 1.0, bear: 1.0, risk: 1.5, liquidity: 1.0 },
      marketRegime: 'TREND_UP',
      rawAgentScores: {
        scout: { score: 95, reason: 'No short', vote: 'REJECT' },
        bull: { score: 90, reason: 'Bullish market', vote: 'APPROVE_LONG' }, // opposing vote against SHORT
        bear: { score: 80, reason: 'Bear trap', vote: 'HOLD' },
        risk: { score: 99, reason: 'Extreme risk', vote: 'REJECT' },
        liquidity: { score: 85, reason: 'No liquidity sweep', vote: 'REJECT' }
      }
    };

    const trace = DecisionTraceService.buildTrace(params);

    // Dissenters: scout (REJECT), bull (APPROVE_LONG), risk (REJECT), liquidity (REJECT)
    // weightedSum from bear (HOLD): 80 * 0.5 * 1.0 = 40
    // dissentPenalty:
    //   scout: 95 * 1.0 * 1.5 = 142.5
    //   bull: 90 * 1.0 * 1.5 = 135
    //   risk: 99 * 1.5 * 1.5 = 222.75
    //   liquidity: 85 * 1.0 * 1.5 = 127.5
    // Total dissent penalty is ~627.75, far exceeding weightedSum 40
    // rawScore is deeply negative
    expect(trace.consensusScore).toBe(0);
    expect(trace.consensusScore).toBeGreaterThanOrEqual(0);
  });

  it('correctly defaults to 50 when no agent votes are provided (totalWeight === 0)', () => {
    const params: DecisionTraceBuildParams = {
      symbol: 'BTCUSDT',
      side: 'LONG',
      marketRegime: 'RANGING_FLAT',
      rawAgentScores: {}
    };

    const trace = DecisionTraceService.buildTrace(params);
    expect(trace.consensusScore).toBe(50);
  });
});
