import { describe, it, expect } from 'vitest';
import { getRuleTesterPrompt } from './ruleTester.ts';

describe('getRuleTesterPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getRuleTesterPrompt(
      'UNIQUE_RULE_111',
      'UNIQUE_SYMBOL_222',
      'UNIQUE_SIDE_333',
      'UNIQUE_ENTRY_444'
    );
    expect(result).toContain('UNIQUE_RULE_111');
    expect(result).toContain('UNIQUE_SYMBOL_222');
    expect(result).toContain('UNIQUE_SIDE_333');
    expect(result).toContain('UNIQUE_ENTRY_444');
    
    expect(result).not.toContain('${rule}');
    expect(result).not.toContain('${tradeSymbol}');
    expect(result).not.toContain('${tradeSide}');
    expect(result).not.toContain('${tradeEntryPrice}');
  });
});
