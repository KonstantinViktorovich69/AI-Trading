import { describe, it, expect } from 'vitest';
import { getSettingsOptimizerPrompt } from './settingsOptimizer.ts';

describe('getSettingsOptimizerPrompt', () => {
  it('actually interpolates all parameters with unique markers', () => {
    const result = getSettingsOptimizerPrompt(
      'UNIQUE_SETTINGS_111',
      'UNIQUE_MESSAGE_222'
    );
    expect(result).toContain('UNIQUE_SETTINGS_111');
    expect(result).toContain('UNIQUE_MESSAGE_222');
    
    expect(result).not.toContain('${currentSettingsString}');
    expect(result).not.toContain('${message}');
  });
});
