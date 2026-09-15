import { describe, it, expect } from 'vitest';
import { getPositionManagerPrompt } from './positionManager.ts';

describe('getPositionManagerPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getPositionManagerPrompt(
      'UNIQUE_SIDE_111',
      'UNIQUE_SYMBOL_222',
      'UNIQUE_RULES_333',
      'UNIQUE_ENTRY_444',
      'UNIQUE_CURRENT_555',
      'UNIQUE_LEVERAGE_666',
      'UNIQUE_AMOUNT_777',
      'UNIQUE_PNLUSD_888',
      'UNIQUE_PNLPCT_999',
      'UNIQUE_MODE_AAA',
      'UNIQUE_HISTORY_BBB'
    );
    expect(result).toContain('UNIQUE_SIDE_111');
    expect(result).toContain('UNIQUE_SYMBOL_222');
    expect(result).toContain('UNIQUE_RULES_333');
    expect(result).toContain('UNIQUE_ENTRY_444');
    expect(result).toContain('UNIQUE_CURRENT_555');
    expect(result).toContain('UNIQUE_LEVERAGE_666');
    expect(result).toContain('UNIQUE_AMOUNT_777');
    expect(result).toContain('UNIQUE_PNLUSD_888');
    expect(result).toContain('UNIQUE_PNLPCT_999');
    expect(result).toContain('UNIQUE_MODE_AAA');
    expect(result).toContain('UNIQUE_HISTORY_BBB');
    
    expect(result).not.toContain('${side}');
    expect(result).not.toContain('${symbol}');
    expect(result).not.toContain('${rules}');
    expect(result).not.toContain('${entryPrice}');
    expect(result).not.toContain('${currentPrice}');
    expect(result).not.toContain('${leverage}');
    expect(result).not.toContain('${amount}');
    expect(result).not.toContain('${pnlUsdFormatted}');
    expect(result).not.toContain('${pnlPctFormatted}');
    expect(result).not.toContain('${mode}');
    expect(result).not.toContain('${historyJson}');
  });
});
