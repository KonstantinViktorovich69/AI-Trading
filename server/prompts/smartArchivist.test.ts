import { describe, it, expect } from 'vitest';
import { getSmartArchivistPrompt } from './smartArchivist.ts';

describe('getSmartArchivistPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getSmartArchivistPrompt(
      'UNIQUE_REGIME_111',
      'UNIQUE_HEALTH_222',
      999333,
      'UNIQUE_ACTIVE_JSON_444',
      'UNIQUE_ARCHIVED_JSON_555'
    );
    expect(result).toContain('UNIQUE_REGIME_111');
    expect(result).toContain('UNIQUE_HEALTH_222');
    expect(result).toContain('999333');
    expect(result).toContain('UNIQUE_ACTIVE_JSON_444');
    expect(result).toContain('UNIQUE_ARCHIVED_JSON_555');
    
    expect(result).not.toContain('${regime}');
    expect(result).not.toContain('${health}');
    expect(result).not.toContain('${activeRulesCount}');
    expect(result).not.toContain('${activeRulesJson}');
    expect(result).not.toContain('${archivedRulesJson}');
  });
});
