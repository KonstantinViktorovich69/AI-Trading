import { describe, it, expect } from 'vitest';
import { getTradeEvaluationPrompt } from './tradeEvaluation.ts';

describe('getTradeEvaluationPrompt', () => {
  it('actually interpolates all parameters with unique markers and handles plus sign', () => {
    const result = getTradeEvaluationPrompt(
      'UNIQUE_SYMBOL_111',
      'UNIQUE_SIDE_222',
      'UNIQUE_ENTRY_333',
      'UNIQUE_EXIT_444',
      12.34,
      56.78,
      'UNIQUE_REASON_555'
    );
    expect(result).toContain('UNIQUE_SYMBOL_111');
    expect(result).toContain('UNIQUE_SIDE_222');
    expect(result).toContain('UNIQUE_ENTRY_333');
    expect(result).toContain('UNIQUE_EXIT_444');
    expect(result).toContain('12.34%');
    expect(result).toContain('56.78 USDT');
    expect(result).toContain('UNIQUE_REASON_555');
    expect(result).toContain('закрылась в плюс');
    
    expect(result).not.toContain('${symbol}');
    expect(result).not.toContain('${side}');
    expect(result).not.toContain('${entryPrice}');
    expect(result).not.toContain('${exitPrice}');
    expect(result).not.toContain('${reason}');
  });

  it('handles minus sign for negative pnlPct', () => {
    const result = getTradeEvaluationPrompt(
      'SYMBOL',
      'SIDE',
      100,
      90,
      -5.67,
      -10.20,
      'REASON'
    );
    expect(result).toContain('закрылась в минус');
  });
});
