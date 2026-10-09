import { describe, it, expect } from 'vitest';

describe('buildExitPolicyConfig snapshot test', () => {
  it('captures the exact legacy exit policy config literals before refactoring', () => {
    const makeLegacyConfig = (globalSettings: any, trade: any) => ({
      minNormalAutoCloseNetPnlPct: 6.0,
      minPttpActivationNetPnlPct: 12.0,
      minPttpPeakNetPnlPct: 18.0,
      pttpTrailingDropPct: 35.0,
      maxLifetimeHours: (globalSettings as any).maxLifetimeHours ?? 24,
      allowEmergencyMaxLifetime: (globalSettings as any).allowEmergencyMaxLifetime ?? true,
      timeoutProfitHours: 18,
      minTimeoutProfitNetPnlPct: 6.0,
      enableStagnationTimeout: true,
      timeoutStagnationHours: (globalSettings as any).timeoutStagnationHours ?? 8.0,
      maxStagnationPnlPct: 0.5,
      enableMultiTp: trade.isMultiTp !== false,
      multiTpTargets: trade.tpStages,
      bypassProfitFloorForMultiTp: true,
      bypassProfitFloorForPrimaryTp: true,
      enableTrailingStop: true,
      trailingStopTriggerPnlPct: 14.0,
      trailingStopDistancePct: 3.0
    });

    // Variant 1: default/empty settings, trade isMultiTp true
    const cfg1 = makeLegacyConfig({}, { isMultiTp: true, tpStages: [{ closeRatio: 0.25 }] });
    expect(cfg1).toEqual({
      minNormalAutoCloseNetPnlPct: 6.0,
      minPttpActivationNetPnlPct: 12.0,
      minPttpPeakNetPnlPct: 18.0,
      pttpTrailingDropPct: 35.0,
      maxLifetimeHours: 24,
      allowEmergencyMaxLifetime: true,
      timeoutProfitHours: 18,
      minTimeoutProfitNetPnlPct: 6.0,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 8.0,
      maxStagnationPnlPct: 0.5,
      enableMultiTp: true,
      multiTpTargets: [{ closeRatio: 0.25 }],
      bypassProfitFloorForMultiTp: true,
      bypassProfitFloorForPrimaryTp: true,
      enableTrailingStop: true,
      trailingStopTriggerPnlPct: 14.0,
      trailingStopDistancePct: 3.0
    });

    // Variant 2: custom settings, trade isMultiTp false
    const cfg2 = makeLegacyConfig({ maxLifetimeHours: 12, allowEmergencyMaxLifetime: false, timeoutStagnationHours: 4.5 }, { isMultiTp: false });
    expect(cfg2).toEqual({
      minNormalAutoCloseNetPnlPct: 6.0,
      minPttpActivationNetPnlPct: 12.0,
      minPttpPeakNetPnlPct: 18.0,
      pttpTrailingDropPct: 35.0,
      maxLifetimeHours: 12,
      allowEmergencyMaxLifetime: false,
      timeoutProfitHours: 18,
      minTimeoutProfitNetPnlPct: 6.0,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 4.5,
      maxStagnationPnlPct: 0.5,
      enableMultiTp: false,
      multiTpTargets: undefined,
      bypassProfitFloorForMultiTp: true,
      bypassProfitFloorForPrimaryTp: true,
      enableTrailingStop: true,
      trailingStopTriggerPnlPct: 14.0,
      trailingStopDistancePct: 3.0
    });

    // Variant 3: undefined isMultiTp (defaults to true), explicit 0 values in settings
    const cfg3 = makeLegacyConfig({ maxLifetimeHours: 48, timeoutStagnationHours: 10 }, { tpStages: [] });
    expect(cfg3).toEqual({
      minNormalAutoCloseNetPnlPct: 6.0,
      minPttpActivationNetPnlPct: 12.0,
      minPttpPeakNetPnlPct: 18.0,
      pttpTrailingDropPct: 35.0,
      maxLifetimeHours: 48,
      allowEmergencyMaxLifetime: true,
      timeoutProfitHours: 18,
      minTimeoutProfitNetPnlPct: 6.0,
      enableStagnationTimeout: true,
      timeoutStagnationHours: 10,
      maxStagnationPnlPct: 0.5,
      enableMultiTp: true,
      multiTpTargets: [],
      bypassProfitFloorForMultiTp: true,
      bypassProfitFloorForPrimaryTp: true,
      enableTrailingStop: true,
      trailingStopTriggerPnlPct: 14.0,
      trailingStopDistancePct: 3.0
    });
  });
});
