import { describe, it, expect } from 'vitest';
import { getMarketPulsePrompt } from './marketPulse.ts';

describe('getMarketPulsePrompt', () => {
  it('actually interpolates context, shortsSq and longsSq instead of leaving literal placeholders', () => {
    const result = getMarketPulsePrompt('UNIQUE_CONTEXT_MARKER_111', 'UNIQUE_SHORTS_222', 'UNIQUE_LONGS_333');
    expect(result).toContain('UNIQUE_CONTEXT_MARKER_111');
    expect(result).toContain('UNIQUE_SHORTS_222');
    expect(result).toContain('UNIQUE_LONGS_333');
    expect(result).not.toContain('${context}');
    expect(result).not.toContain('${shortsSq}');
    expect(result).not.toContain('${longsSq}');
    // Отдельно проверяем, что буквальный "$" перед суммами не потерялся:
    expect(result).toContain('$UNIQUE_SHORTS_222');
    expect(result).toContain('$UNIQUE_LONGS_333');
  });
});
