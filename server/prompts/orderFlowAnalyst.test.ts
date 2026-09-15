import { describe, it, expect } from 'vitest';
import { getOrderFlowAnalystPrompt } from './orderFlowAnalyst.ts';

describe('getOrderFlowAnalystPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getOrderFlowAnalystPrompt(
      'UNIQUE_RULES_111',
      'UNIQUE_SYMBOL_222',
      'UNIQUE_SIGNAL_333',
      'UNIQUE_TYPE_444',
      'UNIQUE_PRICE_555',
      'UNIQUE_CHANGE_666',
      'UNIQUE_VOLATILITY_777',
      'UNIQUE_RSI_888',
      'UNIQUE_FUNDING_DELTA_999',
      'UNIQUE_SHORTS_SQ_1010',
      'UNIQUE_LONGS_SQ_1111',
      'UNIQUE_AI_SCORE_1212',
      'UNIQUE_DIRECTION_1313',
      'UNIQUE_SIDE_INSTRUCTIONS_1414'
    );
    expect(result).toContain('UNIQUE_RULES_111');
    expect(result).toContain('UNIQUE_SYMBOL_222');
    expect(result).toContain('UNIQUE_SIGNAL_333');
    expect(result).toContain('UNIQUE_TYPE_444');
    expect(result).toContain('UNIQUE_PRICE_555');
    expect(result).toContain('UNIQUE_CHANGE_666');
    expect(result).toContain('UNIQUE_VOLATILITY_777');
    expect(result).toContain('UNIQUE_RSI_888');
    expect(result).toContain('UNIQUE_FUNDING_DELTA_999');
    expect(result).toContain('UNIQUE_SHORTS_SQ_1010');
    expect(result).toContain('UNIQUE_LONGS_SQ_1111');
    expect(result).toContain('UNIQUE_AI_SCORE_1212');
    expect(result).toContain('UNIQUE_DIRECTION_1313');
    expect(result).toContain('UNIQUE_SIDE_INSTRUCTIONS_1414');
    
    expect(result).not.toContain('${rules}');
    expect(result).not.toContain('${symbol}');
    expect(result).not.toContain('${signal}');
    expect(result).not.toContain('${type}');
    expect(result).not.toContain('${price}');
    expect(result).not.toContain('${change}');
    expect(result).not.toContain('${volatility}');
    expect(result).not.toContain('${trueRsi}');
    expect(result).not.toContain('${fundingDelta}');
    expect(result).not.toContain('${shortsSq}');
    expect(result).not.toContain('${longsSq}');
    expect(result).not.toContain('${finalAiScore}');
    expect(result).not.toContain('${directionLabel}');
    expect(result).not.toContain('${sideSpecificInstructions}');

    // Check literal $ prefix
    expect(result).toContain('$UNIQUE_SHORTS_SQ_1010');
    expect(result).toContain('$UNIQUE_LONGS_SQ_1111');
  });
});
