import { describe, it, expect } from 'vitest';
import { getSocialScraperPrompt } from './socialScraper.ts';

describe('getSocialScraperPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getSocialScraperPrompt(
      'UNIQUE_SYMBOL_111',
      'UNIQUE_CHANGE_222',
      'UNIQUE_VOL_333'
    );
    expect(result).toContain('UNIQUE_SYMBOL_111');
    expect(result).toContain('UNIQUE_CHANGE_222');
    expect(result).toContain('UNIQUE_VOL_333');
    
    expect(result).not.toContain('${symbol}');
    expect(result).not.toContain('${change}');
    expect(result).not.toContain('${vol}');

    // Check that literal $ before sum is preserved
    expect(result).toContain('$UNIQUE_VOL_333');
  });
});
