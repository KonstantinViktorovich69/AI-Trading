import { describe, it, expect } from 'vitest';
import { getCommitteePrompt } from './committee.ts';

describe('getCommitteePrompt', () => {
  it('actually interpolates rules and dataJson instead of leaving literal placeholders', () => {
    const result = getCommitteePrompt('UNIQUE_RULES_MARKER_12345', 'UNIQUE_DATA_MARKER_67890');
    expect(result).toContain('UNIQUE_RULES_MARKER_12345');
    expect(result).toContain('UNIQUE_DATA_MARKER_67890');
    expect(result).not.toContain('${rules}');
    expect(result).not.toContain('${dataJson}');
  });
});
