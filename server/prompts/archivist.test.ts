import { describe, it, expect } from 'vitest';
import { getArchivistPrompt } from './archivist.ts';

describe('getArchivistPrompt', () => {
  it('actually interpolates currentRules, successRateThreshold and usageThreshold instead of leaving literal placeholders', () => {
    const result = getArchivistPrompt('UNIQUE_RULES_MARKER_999', 0.42, 7);
    expect(result).toContain('UNIQUE_RULES_MARKER_999');
    expect(result).toContain('0.42');
    expect(result).toContain('7');
    expect(result).not.toContain('${currentRules}');
    expect(result).not.toContain('${successRateThreshold}');
    expect(result).not.toContain('${usageThreshold}');
  });
});
