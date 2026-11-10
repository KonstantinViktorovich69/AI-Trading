import { describe, it, expect } from 'vitest';
import { buildExitPolicyConfig } from './virtualTradeEngine.ts';
import { evaluateExitPolicy } from './exitPolicy.ts';
import { evaluateStrategySignal, type StrategyContext } from './strategyEngine.ts';
import { getCostModel } from './costModel.ts';
import { createSystemRouter, type SystemRouterContext } from '../routes/systemRoutes.ts';

describe('Phase 5: Exit Policy Consistency & Strict Liquidity Gate', () => {
  describe('T5.1: buildExitPolicyConfig and Exit Thresholds from Settings', () => {
    it('uses canonical defaults when settings are empty', () => {
      const cfg = buildExitPolicyConfig({}, { isMultiTp: true, tpStages: [] });
      expect(cfg.minNormalAutoCloseNetPnlPct).toBe(6.0);
      expect(cfg.minPttpActivationNetPnlPct).toBe(12.0);
      expect(cfg.minPttpPeakNetPnlPct).toBe(18.0);
      expect(cfg.pttpTrailingDropPct).toBe(35.0);
      expect(cfg.maxLifetimeHours).toBe(24);
      expect(cfg.allowEmergencyMaxLifetime).toBe(true);
      expect(cfg.timeoutProfitHours).toBe(18);
      expect(cfg.minTimeoutProfitNetPnlPct).toBe(6.0);
      expect(cfg.enableStagnationTimeout).toBe(true);
      expect(cfg.timeoutStagnationHours).toBe(8.0);
      expect(cfg.maxStagnationPnlPct).toBe(0.5);
      expect(cfg.bypassProfitFloorForMultiTp).toBe(true);
      expect(cfg.bypassProfitFloorForPrimaryTp).toBe(true);
      expect(cfg.enableTrailingStop).toBe(true);
      expect(cfg.trailingStopTriggerPnlPct).toBe(14.0);
      expect(cfg.trailingStopDistancePct).toBe(3.0);
    });

    it('faithfully respects user-defined exit thresholds and flags when specified', () => {
      const customSettings = {
        exitTrailingTriggerPct: 10.0,
        exitTrailingDistancePct: 2.0,
        exitEnableTrailingStop: false,
        exitMinPttpActivationNetPnlPct: 8.0,
        exitMinPttpPeakNetPnlPct: 14.0,
        exitPttpTrailingDropPct: 20.0,
        exitBypassProfitFloorForPrimaryTp: false,
        exitBypassProfitFloorForMultiTp: false,
        exitMinNormalAutoCloseNetPnlPct: 4.0,
        exitTimeoutProfitHours: 12,
        exitMinTimeoutProfitNetPnlPct: 4.0,
        exitEnableStagnationTimeout: false,
        exitMaxStagnationPnlPct: 0.8,
        exitMaxLifetimeHours: 36,
        exitTimeoutStagnationHours: 5.0
      };

      const cfg = buildExitPolicyConfig(customSettings, { isMultiTp: true, tpStages: [] });
      expect(cfg.trailingStopTriggerPnlPct).toBe(10.0);
      expect(cfg.trailingStopDistancePct).toBe(2.0);
      expect(cfg.enableTrailingStop).toBe(false);
      expect(cfg.minPttpActivationNetPnlPct).toBe(8.0);
      expect(cfg.minPttpPeakNetPnlPct).toBe(14.0);
      expect(cfg.pttpTrailingDropPct).toBe(20.0);
      expect(cfg.bypassProfitFloorForPrimaryTp).toBe(false);
      expect(cfg.bypassProfitFloorForMultiTp).toBe(false);
      expect(cfg.minNormalAutoCloseNetPnlPct).toBe(4.0);
      expect(cfg.timeoutProfitHours).toBe(12);
      expect(cfg.minTimeoutProfitNetPnlPct).toBe(4.0);
      expect(cfg.enableStagnationTimeout).toBe(false);
      expect(cfg.maxStagnationPnlPct).toBe(0.8);
      expect(cfg.maxLifetimeHours).toBe(36);
      expect(cfg.timeoutStagnationHours).toBe(5.0);
    });
  });

  describe('T5.2: Effective Configuration Visibility', () => {
    it('returns effective exit policy, cost model, flags, and versions via /api/system/effective-config', async () => {
      const mockSettings = {
        modelSideAwareFeatures: true,
        strictLiquidityGate: false,
        requireModelMaturity: true,
        modelMinSamplesForAdjustment: 120,
        costModel: {
          feeRatePerSide: 0.0006,
          slippageRoundTrip: 0.0004,
          version: 2
        }
      };

      const mockCtx: Partial<SystemRouterContext> = {
        getGlobalSettings: () => mockSettings,
        getVirtualTrades: () => [],
        getKnowledgeBase: () => [],
        getSignalsCache: () => ({ data: [] }),
        streamEmitter: { emit: () => true }
      };

      const router = createSystemRouter(mockCtx as SystemRouterContext);
      
      // Extract handler for GET /system/effective-config
      const route = router.stack.find(
        (s: any) => s.route && (s.route.path === '/system/effective-config' || s.route.path === '/effective-config')
      );
      expect(route).toBeDefined();

      let jsonResponse: any = null;
      const res: any = {
        json: (data: any) => { jsonResponse = data; return res; },
        status: () => res
      };

      route.route.stack[0].handle({ query: {} } as any, res, () => {});

      expect(jsonResponse).toBeDefined();
      expect(jsonResponse.success).toBe(true);
      expect(jsonResponse.exitPolicy).toBeDefined();
      expect(jsonResponse.costModel.version).toBe(2);
      expect(jsonResponse.flags.strictLiquidityGate).toBe(false);
      expect(jsonResponse.flags.modelSideAwareFeatures).toBe(true);
      expect(jsonResponse.flags.requireModelMaturity).toBe(true);
      expect(jsonResponse.flags.modelMinSamplesForAdjustment).toBe(120);
      expect(jsonResponse.versions.featuresVersion).toBe(2);
      expect(jsonResponse.versions.costModelVersion).toBe(2);
    });
  });

  describe('T5.3: Strict Liquidity Gate [B]', () => {
    const baseContext: StrategyContext = {
      symbol: 'LOWVOLUSDT',
      price: 10,
      high: 11,
      low: 9,
      open: 10,
      bidSpreadPct: 0.0005,
      change24h: 18, // > 15% move
      volume24h: 20000, // < 50k
      fundingRate: 0.0001,
      orderBookImbalance: 0.6,
      rsi: 75,
      vwap: 9.8,
      sar: 10.2,
      hunterScore: 85,
      bearScore: 20,
      committeeScore: 82,
      isCommitteeApproved: true,
      action: 'SELL',
      side: 'SHORT'
    };

    it('allows low volume (<50k) coin with >15% price change in legacy mode (strictLiquidityGate=false) and logs shadow flag', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        strictLiquidityGate: false
      });

      // Legacy allows it because change24h = 18% >= 15%
      expect(decision.gateDiagnostics.liquiditySafety).toBe(true);
      expect(decision.gateDiagnostics.strictLiquidityWouldBlock).toBe(true);
      expect(decision.action).not.toBe('NO_TRADE');
    });

    it('strictly blocks low volume (<50k) coin with >15% move when strictLiquidityGate=true', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        strictLiquidityGate: true
      });

      // Strict blocks it: volume24h $20,000 < $50,000 and < $25,000
      expect(decision.gateDiagnostics.liquiditySafety).toBe(false);
      expect(decision.gateDiagnostics.strictLiquidityWouldBlock).toBe(true);
      expect(decision.action).toBe('NO_TRADE');
      expect(decision.rejectionReason).toBe('LOW_LIQUIDITY');
    });

    it('allows coin with volume between $25k and $50k when volume spike is >= 4.0x under strictLiquidityGate=true', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        volume24h: 35000, // Between 25k and 50k
        volumeSpike: 4.5, // 4.5x spike >= 4.0x
        strictLiquidityGate: true
      });

      expect(decision.gateDiagnostics.liquiditySafety).toBe(true);
      expect(decision.gateDiagnostics.strictLiquidityWouldBlock).toBe(false);
      expect(decision.action).not.toBe('NO_TRADE');
    });

    it('blocks coin with volume < $25k even with a 5x volume spike under strictLiquidityGate=true', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        volume24h: 18000, // < 25k
        volumeSpike: 5.0, // Large spike, but volume is too thin
        strictLiquidityGate: true
      });

      expect(decision.gateDiagnostics.liquiditySafety).toBe(false);
      expect(decision.gateDiagnostics.strictLiquidityWouldBlock).toBe(true);
      expect(decision.action).toBe('NO_TRADE');
    });
  });
});
