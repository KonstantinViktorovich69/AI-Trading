import { describe, it, expect } from 'vitest';
import { getSignalAnalysisPrompt } from './signalAnalysis.ts';

describe('getSignalAnalysisPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getSignalAnalysisPrompt(
      'UNIQUE_SIGNAL_JSON_111',
      'UNIQUE_RULES_222'
    );
    expect(result).toContain('UNIQUE_SIGNAL_JSON_111');
    expect(result).toContain('UNIQUE_RULES_222');
    
    expect(result).not.toContain('${signalJson}');
    expect(result).not.toContain('${rules}');
  });
});
