import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCleanLearningTrade,
  netReturnPct,
  cellKeys,
  computeCellStats,
  verdictForCell,
  resolveVerdict,
  walkForwardEvaluate
} from './learningCells.ts';
import {
  getCellVerdict,
  recomputeLearningCells,
  getAllLearningCells,
  resetLearningCellServiceForTest
} from './learningCellService.ts';

describe('Aggregated Learning Cells (Промт 3/4)', () => {
  beforeEach(() => {
    resetLearningCellServiceForTest();
  });

  describe('Block A: Pure Functions (learningCells.ts)', () => {
    it('isCleanLearningTrade: filters out dirty trades properly', () => {
      const validTrade = {
        id: 't_clean_1',
        status: 'CLOSED',
        isPaper: true,
        gapAffected: false,
        dataOrigin: 'PAPER',
        closeReasonCode: 'TAKE_PROFIT',
        entryPrice: 100,
        closePrice: 105,
        amount: 10,
        leverage: 5,
        pnl: 2.5
      };
      expect(isCleanLearningTrade(validTrade)).toBe(true);

      // Not closed
      expect(isCleanLearningTrade({ ...validTrade, status: 'OPEN', closeTime: undefined, closedAt: undefined })).toBe(false);

      // gapAffected
      expect(isCleanLearningTrade({ ...validTrade, gapAffected: true })).toBe(false);

      // Funding farm
      expect(isCleanLearningTrade({ ...validTrade, mode: 'FUNDING_FARM' })).toBe(false);
      expect(isCleanLearningTrade({ ...validTrade, isFundingFarm: true })).toBe(false);

      // SEED / FORCED_RESET origin
      expect(isCleanLearningTrade({ ...validTrade, dataOrigin: 'SEED' })).toBe(false);
      expect(isCleanLearningTrade({ ...validTrade, dataOrigin: 'HISTORICAL_SEED' })).toBe(false);
      expect(isCleanLearningTrade({ ...validTrade, dataOrigin: 'FORCED_RESET' })).toBe(false);

      // closeReasonCode MANUAL / FORCED_RESET
      expect(isCleanLearningTrade({ ...validTrade, closeReasonCode: 'MANUAL' })).toBe(false);
      expect(isCleanLearningTrade({ ...validTrade, closeReasonCode: 'FORCED_RESET' })).toBe(false);

      // Outlier price glitch (> 25%)
      expect(isCleanLearningTrade({ ...validTrade, entryPrice: 100, closePrice: 130 })).toBe(false);

      // Outlier net return (> 25%)
      expect(isCleanLearningTrade({ ...validTrade, entryPrice: 100, closePrice: 101, pnl: 50, amount: 1, leverage: 1 })).toBe(false);
    });

    it('netReturnPct: computes correctly using pnl / (amount * leverage) * 100', () => {
      const trade = {
        amount: 20,
        leverage: 10,
        pnl: 4.0 // denominator = 200 => (4 / 200) * 100 = 2%
      };
      expect(netReturnPct(trade)).toBeCloseTo(2.0, 4);

      // Fallback calculation with model fee -0.10%
      const fallbackTrade = {
        side: 'LONG',
        entryPrice: 100,
        closePrice: 105,
        amount: 10,
        leverage: 1
      };
      // Raw = 5%, minus fee 0.10% = 4.90%
      expect(netReturnPct(fallbackTrade)).toBeCloseTo(4.90, 4);
    });

    it('cellKeys: produces 3 levels (fine, mid, coarse)', () => {
      const trade = {
        matchedPattern: 'SPIRE_SPIKE_REVERSAL',
        side: 'SHORT',
        marketRegime: 'BEAR'
      };
      const keys = cellKeys(trade);
      expect(keys.fine).toContain('SHORT|BEAR');
      expect(keys.mid).toContain('SHORT');
      expect(keys.coarse.length).toBeGreaterThan(0);
    });

    it('computeCellStats: computes stats, weights, decay and CI95', () => {
      const now = Date.now();
      const mockTrades: any[] = [];
      for (let i = 0; i < 35; i++) {
        mockTrades.push({
          id: `t_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          closeTime: now - (35 - i) * 60000,
          matchedPattern: 'TEST_PATTERN',
          side: 'LONG',
          marketRegime: 'BULL',
          configVersion: 'cfg_v1'
        });
      }

      const stats = computeCellStats(mockTrades, { currentConfigVersion: 'cfg_v1' });
      const coarseKey = Object.keys(stats).find(k => !k.includes('|'));
      expect(coarseKey).toBeDefined();
      const s = stats[coarseKey!];
      expect(s.n).toBe(35);
      expect(s.wins).toBe(35);
      expect(s.winRate).toBe(1.0);
      expect(s.avgNetPct).toBeGreaterThan(0);
      expect(s.expectancyCI95).toBeDefined();
      expect(s.expectancyCI95!.lo).toBeGreaterThan(0);
    });

    it('verdictForCell: checks BLOCK, PENALIZE, BOOST and protected patterns', () => {
      // 1. n < 20 => NEUTRAL
      expect(verdictForCell({
        cellKey: 'P|LONG',
        n: 15,
        wins: 15,
        winRate: 1,
        wilson: { lo: 0.8, hi: 1, center: 0.9 },
        avgNetPct: 5,
        profitFactor: 5,
        expectancyCI95: null
      }).verdict).toBe('NEUTRAL');

      // 2. BLOCK: n >= 30 and expectancyCI95.hi < 0
      const blockStats = {
        cellKey: 'P|LONG',
        n: 35,
        wins: 5,
        winRate: 0.14,
        wilson: { lo: 0.05, hi: 0.3, center: 0.15 },
        avgNetPct: -2.5,
        profitFactor: 0.3,
        expectancyCI95: { lo: -4.0, hi: -0.5 }
      };
      const blockRes = verdictForCell(blockStats, { protectedPattern: false });
      expect(blockRes.verdict).toBe('BLOCK');
      expect(blockRes.adjustment).toBe(-10);

      // Protected pattern with PENALIZE_ONLY downgrades BLOCK to PENALIZE with wouldBlockIfFullPolicy
      const protectedRes = verdictForCell(blockStats, { protectedPattern: true, policy: 'PENALIZE_ONLY' });
      expect(protectedRes.verdict).toBe('PENALIZE');
      expect(protectedRes.adjustment).toBe(-10);
      expect(protectedRes.wouldBlockIfFullPolicy).toBe(true);

      // Protected pattern with FULL keeps BLOCK
      const fullRes = verdictForCell(blockStats, { protectedPattern: true, policy: 'FULL' });
      expect(fullRes.verdict).toBe('BLOCK');

      // Protected pattern with IGNORE is always NEUTRAL
      const ignoreRes = verdictForCell(blockStats, { protectedPattern: true, policy: 'IGNORE' });
      expect(ignoreRes.verdict).toBe('NEUTRAL');

      // 3. PENALIZE tiers
      const pen50 = {
        cellKey: 'P|LONG',
        n: 25,
        wins: 5,
        winRate: 0.2,
        wilson: { lo: 0.1, hi: 0.3, center: 0.2 },
        avgNetPct: -1.5,
        profitFactor: 0.45,
        expectancyCI95: { lo: -2.5, hi: 0.5 }
      };
      expect(verdictForCell(pen50).adjustment).toBe(-10);

      const pen70 = { ...pen50, profitFactor: 0.65 };
      expect(verdictForCell(pen70).adjustment).toBe(-7);

      const pen90 = { ...pen50, profitFactor: 0.85 };
      expect(verdictForCell(pen90).adjustment).toBe(-4);

      // 4. BOOST
      const boostStats = {
        cellKey: 'P|LONG',
        n: 35,
        wins: 25,
        winRate: 0.71,
        wilson: { lo: 0.55, hi: 0.85, center: 0.7 },
        avgNetPct: 2.0,
        profitFactor: 2.5,
        expectancyCI95: { lo: 0.5, hi: 3.5 }
      };
      expect(verdictForCell(boostStats).verdict).toBe('BOOST');
      expect(verdictForCell(boostStats).adjustment).toBe(4);

      // n >= 60 gives +6
      expect(verdictForCell({ ...boostStats, n: 65 }).adjustment).toBe(6);
    });

    it('resolveVerdict: uses fine -> mid -> coarse hierarchy', () => {
      const statsMap = {
        'PAT|LONG|BULL': { cellKey: 'PAT|LONG|BULL', n: 10 } as any, // n < 20, skipped
        'PAT|LONG': {
          cellKey: 'PAT|LONG',
          n: 35,
          wins: 30,
          winRate: 0.85,
          wilson: { lo: 0.7, hi: 0.95, center: 0.85 },
          avgNetPct: 3.0,
          profitFactor: 3.0,
          expectancyCI95: { lo: 1.0, hi: 5.0 }
        } as any,
        'PAT': { cellKey: 'PAT', n: 100 } as any
      };
      const keys = { fine: 'PAT|LONG|BULL', mid: 'PAT|LONG', coarse: 'PAT' };
      const resolved = resolveVerdict(statsMap, keys);
      expect(resolved.level).toBe('mid');
      expect(resolved.verdict).toBe('BOOST');
    });

    it('walkForwardEvaluate: evaluates lookahead-free and partitions results', () => {
      const now = Date.now();
      const mockTrades: any[] = [];
      for (let i = 0; i < 40; i++) {
        mockTrades.push({
          id: `t_wf_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          openTime: now + i * 60000,
          closeTime: now + i * 60000 + 30000,
          matchedPattern: 'WF_TEST',
          side: 'LONG',
          marketRegime: 'BULL'
        });
      }

      const wf = walkForwardEvaluate(mockTrades, { maxTrades: 50 });
      expect(wf.evaluatedTradesCount).toBe(40);
      expect(wf.groups).toBeDefined();
      expect(wf.groups.NEUTRAL).toBeDefined();
    });
  });

  describe('Block B: Learning Cell Service runtime', () => {
    it('recomputes and serves getCellVerdict properly', () => {
      const mockTrades: any[] = [];
      const now = Date.now();
      for (let i = 0; i < 35; i++) {
        mockTrades.push({
          id: `t_svc_${i}`,
          status: 'CLOSED',
          isPaper: true,
          gapAffected: false,
          dataOrigin: 'PAPER',
          closeReasonCode: 'TAKE_PROFIT',
          entryPrice: 100,
          closePrice: 102,
          amount: 10,
          leverage: 5,
          pnl: 1.0,
          openTime: now + i * 60000,
          closeTime: now + i * 60000 + 30000,
          matchedPattern: 'SPIRE_CLIMAX',
          side: 'SHORT',
          marketRegime: 'BEAR'
        });
      }

      recomputeLearningCells(mockTrades);
      expect(Object.keys(getAllLearningCells()).length).toBeGreaterThan(0);

      const verdict = getCellVerdict({
        pattern: 'SPIRE_CLIMAX',
        side: 'SHORT',
        regime: 'BEAR'
      });
      expect(verdict).toBeDefined();
      expect(verdict.verdict).toBe('BOOST');
      expect(verdict.adjustment).toBe(4);
    });
  });
});
