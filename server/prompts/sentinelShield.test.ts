import { describe, it, expect } from 'vitest';
import { getSentinelShieldPrompt } from './sentinelShield.ts';

describe('getSentinelShieldPrompt', () => {
  it('actually interpolates all 7 parameters with unique markers', () => {
    const result = getSentinelShieldPrompt(
      'MK_BTC24', 'MK_BTC15', 'MK_REGIME', 'MK_HEALTH',
      'MK_FUNDING', 'MK_VOLAT', 'MK_SENTIMENT'
    );
    ['MK_BTC24','MK_BTC15','MK_REGIME','MK_HEALTH','MK_FUNDING','MK_VOLAT','MK_SENTIMENT'].forEach(marker => {
      expect(result).toContain(marker);
    });
    expect(result).not.toContain('${btc24');
    expect(result).not.toContain('${btc15');
    expect(result).not.toContain('${regime}');
    expect(result).not.toContain('${health}');
    expect(result).not.toContain('${globalSettings.fundingShieldLimit}');
    expect(result).not.toContain('${globalSettings.maxVolatilityLimit}');
    expect(result).not.toContain('${sentimentDetails');
  });
});
