import { describe, it, expect, beforeEach } from 'vitest';
import { 
  isPatternBlacklisted, 
  updatePatternBlacklistFromStats, 
  extractPatternFromTrade,
  getBlacklistedPatterns 
} from './signalEngine.ts';
import { isTraditionalEquitySymbol } from './marketSignalScanner.ts';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';
import { calculateOteEntryZone } from './oteEntryCalculator.ts';

describe('System Enhancements & Bugfixes Audit', () => {
  describe('1. Pattern Blacklist & Extraction', () => {
    it('seeds known unprofitable SAR reversal patterns by default with high conviction', () => {
      const prolivCheck = isPatternBlacklisted('💥 ПРОЛИВ (SAR Bottom Reversal)');
      expect(prolivCheck.blacklisted).toBe(true);
      expect(prolivCheck.reason).toContain('25.5%');

      const slivCheck = isPatternBlacklisted('💀 СЛИВ МОНЕТЫ (SAR Reversal at Peak)');
      expect(slivCheck.blacklisted).toBe(true);
      expect(slivCheck.reason).toContain('27.1%');
    });

    it('correctly matches fuzzy/substring pattern names', () => {
      expect(isPatternBlacklisted('ПРОЛИВ (SAR Bottom Reversal)').blacklisted).toBe(true);
      expect(isPatternBlacklisted('СЛИВ МОНЕТЫ (SAR Peak)').blacklisted).toBe(true);
      expect(isPatternBlacklisted('SAR Bottom Reversal').blacklisted).toBe(true);
      expect(isPatternBlacklisted('SAR Reversal at Peak').blacklisted).toBe(true);
    });

    it('does NOT falsely block unrelated high-quality patterns', () => {
      expect(isPatternBlacklisted('💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)').blacklisted).toBe(false);
      expect(isPatternBlacklisted('💎 ИДЕАЛЬНЫЙ ЛОНГ (Smart Liquidity Floor)').blacklisted).toBe(false);
      expect(isPatternBlacklisted('⚡ 1m Spire Climax').blacklisted).toBe(false);
      expect(isPatternBlacklisted('🧹 False Breakout').blacklisted).toBe(false);
    });

    it('extracts pattern name properly from various real trade object formats', () => {
      expect(extractPatternFromTrade({
        id: 'T1',
        triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)'
      })).toBe('💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)');

      expect(extractPatternFromTrade({
        id: 'T2',
        decisionTrace: {
          triggerPattern: '💥 ПРОЛИВ (SAR Bottom Reversal)'
        }
      })).toBe('💥 ПРОЛИВ (SAR Bottom Reversal)');

      expect(extractPatternFromTrade({
        id: 'T3',
        patternName: 'Wick Zone Retest'
      })).toBe('Wick Zone Retest');

      expect(extractPatternFromTrade({
        id: 'T4',
        type: 'CLOSE',
        triggerPattern: 'Parabolic Exhaustion'
      })).toBe('Parabolic Exhaustion');
    });

    it('dynamically blacklists any newly failing pattern with winrate < 45%', () => {
      const mockFailingTrades = [
        { triggerPattern: 'Test Toxic Pattern', pnl: -10, outcome: 0, status: 'CLOSED' },
        { triggerPattern: 'Test Toxic Pattern', pnl: -15, outcome: 0, status: 'CLOSED' },
        { triggerPattern: 'Test Toxic Pattern', pnl: 5, outcome: 1, status: 'CLOSED' },
        { triggerPattern: 'Test Toxic Pattern', pnl: -12, outcome: 0, status: 'CLOSED' },
      ];

      updatePatternBlacklistFromStats(mockFailingTrades);

      const check = isPatternBlacklisted('Test Toxic Pattern');
      expect(check.blacklisted).toBe(true);
      expect(check.reason).toContain('Винрейт 25.0% < 45%');
    });
  });

  describe('2. TradFi Equities & CFD Filter', () => {
    it('correctly identifies and excludes traditional US equities from crypto scalp scanner', () => {
      expect(isTraditionalEquitySymbol('DKNG')).toBe(true);
      expect(isTraditionalEquitySymbol('DKNG/USDT:USDT')).toBe(true);
      expect(isTraditionalEquitySymbol('HPE')).toBe(true);
      expect(isTraditionalEquitySymbol('HPE/USDT:USDT')).toBe(true);
      expect(isTraditionalEquitySymbol('AAL')).toBe(true);
      expect(isTraditionalEquitySymbol('PYPL')).toBe(true);
      expect(isTraditionalEquitySymbol('INTC')).toBe(true);
      expect(isTraditionalEquitySymbol('BIIB')).toBe(true);
      expect(isTraditionalEquitySymbol('HOOD')).toBe(true);
    });

    it('correctly allows genuine crypto symbols', () => {
      expect(isTraditionalEquitySymbol('BTC')).toBe(false);
      expect(isTraditionalEquitySymbol('BTC/USDT:USDT')).toBe(false);
      expect(isTraditionalEquitySymbol('ETH/USDT:USDT')).toBe(false);
      expect(isTraditionalEquitySymbol('SOL/USDT:USDT')).toBe(false);
      expect(isTraditionalEquitySymbol('XRP/USDT:USDT')).toBe(false);
      expect(isTraditionalEquitySymbol('DOGE/USDT:USDT')).toBe(false);
    });
  });

  describe('3. SignalPerformanceAnalyticsService Rolling WinRate Feedback', () => {
    it('allows trade entry when pattern has insufficient trade history (< 3 closed trades)', () => {
      const fewTrades = [
        { triggerPattern: 'New Pattern', pnl: -5, status: 'CLOSED', closeTime: 1000 }
      ];
      const res = SignalPerformanceAnalyticsService.evaluatePatternRollingPerformance(fewTrades, 'New Pattern', 20);
      expect(res.allowed).toBe(true);
      expect(res.totalTrades).toBe(1);
    });

    it('rejects entry when rolling win rate over last 20 trades is under 45%', () => {
      // 10 trades: 3 wins (30%), 7 losses (70%)
      const failingTrades = [
        { triggerPattern: 'Failing Scalp Pattern', pnl: -10, outcome: 0, status: 'CLOSED', closeTime: 10 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -15, outcome: 0, status: 'CLOSED', closeTime: 20 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: 20, outcome: 1, status: 'CLOSED', closeTime: 30 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -8, outcome: 0, status: 'CLOSED', closeTime: 40 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -12, outcome: 0, status: 'CLOSED', closeTime: 50 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: 25, outcome: 1, status: 'CLOSED', closeTime: 60 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -14, outcome: 0, status: 'CLOSED', closeTime: 70 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -9, outcome: 0, status: 'CLOSED', closeTime: 80 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: 18, outcome: 1, status: 'CLOSED', closeTime: 90 },
        { triggerPattern: 'Failing Scalp Pattern', pnl: -11, outcome: 0, status: 'CLOSED', closeTime: 100 }
      ];

      const res = SignalPerformanceAnalyticsService.evaluatePatternRollingPerformance(failingTrades, 'Failing Scalp Pattern', 20);
      expect(res.allowed).toBe(false);
      expect(res.winRate).toBe(30);
      expect(res.reason).toContain('Скользящий винрейт');
      expect(res.reason).toContain('30% (< 45% порога)');
    });

    it('approves entry when rolling win rate is healthy (>= 45%)', () => {
      const winningTrades = [
        { triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', pnl: 25, outcome: 1, status: 'CLOSED', closeTime: 10 },
        { triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', pnl: -10, outcome: 0, status: 'CLOSED', closeTime: 20 },
        { triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', pnl: 30, outcome: 1, status: 'CLOSED', closeTime: 30 },
        { triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', pnl: 20, outcome: 1, status: 'CLOSED', closeTime: 40 },
        { triggerPattern: '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', pnl: -8, outcome: 0, status: 'CLOSED', closeTime: 50 },
      ];

      const res = SignalPerformanceAnalyticsService.evaluatePatternRollingPerformance(winningTrades, '💎 ИДЕАЛЬНЫЙ ШОРТ (Smart Liquidity Lock)', 20);
      expect(res.allowed).toBe(true);
      expect(res.winRate).toBe(60);
    });
  });

  describe('4. Exit Tuning & OTE Limit Entry Calibration', () => {
    it('calibrates breakeven activation to require pure movement >= +1.20% unleveraged', () => {
      const isBreakevenQualified = (unleveragedPnl: number, pnlNow: number) => {
        return unleveragedPnl >= 1.20 || pnlNow >= 5.00;
      };

      // Below threshold (noise zone)
      expect(isBreakevenQualified(0.50, 2.50)).toBe(false);
      expect(isBreakevenQualified(1.00, 4.00)).toBe(false);

      // Above threshold (sustained breakout)
      expect(isBreakevenQualified(1.20, 3.00)).toBe(true);
      expect(isBreakevenQualified(1.50, 4.50)).toBe(true);
      expect(isBreakevenQualified(0.90, 5.00)).toBe(true);
    });

    it('computes correct OTE entry target zone (mid-wick / 61.8% retracement)', () => {
      // Local high 100, local low 90, price 95
      const oteShort = calculateOteEntryZone({
        isSellSignal: true,
        price: 95,
        localHigh5m: 100,
        localLow5m: 90
      });

      expect(oteShort.isValid).toBe(true);
      // For SHORT, limit entry is positioned above current price in upper wick/rebound area
      expect(oteShort.targetPrice).toBeGreaterThan(95);
      expect(oteShort.targetPrice).toBeLessThanOrEqual(100);

      const oteLong = calculateOteEntryZone({
        isSellSignal: false,
        price: 95,
        localHigh5m: 100,
        localLow5m: 90
      });

      expect(oteLong.isValid).toBe(true);
      // For LONG, limit entry is positioned below current price in discount/retrace area
      expect(oteLong.targetPrice).toBeLessThan(95);
      expect(oteLong.targetPrice).toBeGreaterThanOrEqual(90);
    });
  });
});
