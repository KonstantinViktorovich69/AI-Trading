import { describe, it, expect } from 'vitest';
import {
  getTradingSessionForHour,
  getTradingSession,
  getCurrentSessionInfo,
  calculateSessionStats,
  calculateHourlyStats,
  evaluateSessionFilter,
  isSessionStatsTrade,
  sanitizeAllowedSessions,
  sanitizeBlockedHours,
  PROFIT_FACTOR_CAP,
  TRADING_SESSIONS,
  type TradingSessionId
} from './sessionTradingService.ts';

describe('sessionTradingService', () => {
  describe('Session Classification & Boundaries', () => {
    it('classifies all 24 UTC hours correctly', () => {
      // Asian (00:00 - 08:00 UTC)
      for (let h = 0; h < 8; h++) {
        expect(getTradingSessionForHour(h)).toBe('ASIAN');
      }

      // London / Europe (08:00 - 13:00 UTC)
      for (let h = 8; h < 13; h++) {
        expect(getTradingSessionForHour(h)).toBe('LONDON');
      }

      // Overlap London + NY (13:00 - 17:00 UTC)
      for (let h = 13; h < 17; h++) {
        expect(getTradingSessionForHour(h)).toBe('OVERLAP_LONDON_NY');
      }

      // New York (17:00 - 22:00 UTC)
      for (let h = 17; h < 22; h++) {
        expect(getTradingSessionForHour(h)).toBe('NEW_YORK');
      }

      // Pacific / Late Off-Hours (22:00 - 24:00 UTC)
      for (let h = 22; h < 24; h++) {
        expect(getTradingSessionForHour(h)).toBe('PACIFIC_OFF_HOURS');
      }
    });

    it('handles negative or wrapping hours cleanly', () => {
      expect(getTradingSessionForHour(24)).toBe('ASIAN');
      expect(getTradingSessionForHour(-1)).toBe('PACIFIC_OFF_HOURS'); // hour 23
    });

    it('returns session for Date objects', () => {
      const d1 = new Date('2026-10-12T14:30:00Z');
      expect(getTradingSession(d1)).toBe('OVERLAP_LONDON_NY');

      const d2 = new Date('2026-10-12T05:00:00Z');
      expect(getTradingSession(d2)).toBe('ASIAN');
    });

    it('provides current session info with metadata and recommendation', () => {
      const d = new Date('2026-10-12T14:30:00Z');
      const info = getCurrentSessionInfo(d);
      expect(info.session.id).toBe('OVERLAP_LONDON_NY');
      expect(info.isPeakLiquidity).toBe(true);
      expect(info.recommendation).toContain('Справочная информация о сессии');
      expect(info.utcTimeFormatted).toBe('14:30 UTC');
    });
  });

  describe('Statistics Calculations', () => {
    const mockTrades = [
      // Asian trade: 05:00 UTC, Loss, Short
      {
        status: 'CLOSED',
        openTime: new Date('2026-10-12T05:00:00Z').getTime(),
        pnl: -10,
        side: 'SHORT'
      },
      // Asian trade: 06:00 UTC, Win, Long
      {
        status: 'CLOSED',
        openTime: new Date('2026-10-12T06:00:00Z').getTime(),
        pnl: 15,
        side: 'LONG'
      },
      // Overlap trade: 14:00 UTC, Win, Short
      {
        status: 'CLOSED',
        openTime: new Date('2026-10-12T14:00:00Z').getTime(),
        pnl: 25,
        side: 'SHORT'
      },
      // Overlap trade: 15:00 UTC, Win, Long
      {
        status: 'CLOSED',
        openTime: new Date('2026-10-12T15:00:00Z').getTime(),
        pnl: 30,
        side: 'LONG'
      },
      // Ignored open trade
      {
        status: 'OPEN',
        openTime: new Date('2026-10-12T15:30:00Z').getTime(),
        pnl: 0,
        side: 'LONG'
      }
    ];

    it('calculates session metrics correctly', () => {
      const stats = calculateSessionStats(mockTrades);

      // Asian session
      expect(stats.ASIAN.totalTrades).toBe(2);
      expect(stats.ASIAN.winningTrades).toBe(1);
      expect(stats.ASIAN.losingTrades).toBe(1);
      expect(stats.ASIAN.winRate).toBe(50);
      expect(stats.ASIAN.totalPnl).toBe(5);
      expect(stats.ASIAN.shortCount).toBe(1);
      expect(stats.ASIAN.shortWins).toBe(0);
      expect(stats.ASIAN.shortWinRate).toBe(0);
      expect(stats.ASIAN.longCount).toBe(1);
      expect(stats.ASIAN.longWins).toBe(1);
      expect(stats.ASIAN.longWinRate).toBe(100);

      // Overlap session
      expect(stats.OVERLAP_LONDON_NY.totalTrades).toBe(2);
      expect(stats.OVERLAP_LONDON_NY.winningTrades).toBe(2);
      expect(stats.OVERLAP_LONDON_NY.winRate).toBe(100);
      expect(stats.OVERLAP_LONDON_NY.totalPnl).toBe(55);

      // Empty session (London)
      expect(stats.LONDON.totalTrades).toBe(0);
      expect(stats.LONDON.winRate).toBe(0);
    });

    it('calculates 24-hour UTC stats correctly', () => {
      const hourly = calculateHourlyStats(mockTrades);
      expect(hourly).toHaveLength(24);

      const h5 = hourly[5];
      expect(h5.totalTrades).toBe(1);
      expect(h5.winningTrades).toBe(0);
      expect(h5.losingTrades).toBe(1);
      expect(h5.totalPnl).toBe(-10);

      const h14 = hourly[14];
      expect(h14.totalTrades).toBe(1);
      expect(h14.winningTrades).toBe(1);
      expect(h14.winRate).toBe(100);
      expect(h14.totalPnl).toBe(25);

      const h0 = hourly[0];
      expect(h0.totalTrades).toBe(0);
    });
  });

  describe('Session Filter Evaluation (evaluateSessionFilter)', () => {
    it('returns allowed: true when filter is disabled (default safe behavior)', () => {
      const timestamp = new Date('2026-10-12T05:00:00Z').getTime();
      const verdict = evaluateSessionFilter(timestamp, { isSessionFilterEnabled: false });
      expect(verdict.allowed).toBe(true);
      expect(verdict.scoreAdjustment).toBe(0);
    });

    it('blocks trade if current UTC hour is in blockedHoursUtc', () => {
      const timestamp = new Date('2026-10-12T05:00:00Z').getTime(); // 05:00 UTC
      const verdict = evaluateSessionFilter(timestamp, {
        isSessionFilterEnabled: true,
        blockedHoursUtc: [4, 5, 6]
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('Blocked by UTC hour filter (5:00 UTC)');
    });

    it('blocks trade if current session is not in allowedSessions', () => {
      const timestamp = new Date('2026-10-12T05:00:00Z').getTime(); // ASIAN session
      const verdict = evaluateSessionFilter(timestamp, {
        isSessionFilterEnabled: true,
        allowedSessions: ['LONDON', 'OVERLAP_LONDON_NY']
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('not in allowed sessions list');
    });

    it('allows trade if session is in allowedSessions', () => {
      const timestamp = new Date('2026-10-12T14:00:00Z').getTime(); // OVERLAP_LONDON_NY
      const verdict = evaluateSessionFilter(timestamp, {
        isSessionFilterEnabled: true,
        allowedSessions: ['LONDON', 'OVERLAP_LONDON_NY']
      });
      expect(verdict.allowed).toBe(true);
    });

    it('applies adaptive score boosts and penalties when sessionAdaptiveScoreBoost is enabled', () => {
      // Overlap: +3 bonus
      const tOverlap = new Date('2026-10-12T14:00:00Z').getTime();
      const vOverlap = evaluateSessionFilter(tOverlap, {
        isSessionFilterEnabled: true,
        allowedSessions: ['OVERLAP_LONDON_NY'],
        sessionAdaptiveScoreBoost: true
      });
      expect(vOverlap.allowed).toBe(true);
      expect(vOverlap.scoreAdjustment).toBe(3);

      // Asian: -4 penalty
      const tAsia = new Date('2026-10-12T02:00:00Z').getTime();
      const vAsia = evaluateSessionFilter(tAsia, {
        isSessionFilterEnabled: true,
        allowedSessions: ['ASIAN'],
        sessionAdaptiveScoreBoost: true
      });
      expect(vAsia.allowed).toBe(true);
      expect(vAsia.scoreAdjustment).toBe(-4);

      // New York Short: -3 penalty
      const tNy = new Date('2026-10-12T19:00:00Z').getTime();
      const vNyShort = evaluateSessionFilter(tNy, {
        isSessionFilterEnabled: true,
        allowedSessions: ['NEW_YORK'],
        sessionAdaptiveScoreBoost: true
      }, 'SHORT');
      expect(vNyShort.allowed).toBe(true);
      expect(vNyShort.scoreAdjustment).toBe(-3);

      // New York Long: no short penalty (0)
      const vNyLong = evaluateSessionFilter(tNy, {
        isSessionFilterEnabled: true,
        allowedSessions: ['NEW_YORK'],
        sessionAdaptiveScoreBoost: true
      }, 'LONG');
      expect(vNyLong.allowed).toBe(true);
      expect(vNyLong.scoreAdjustment).toBe(0);
    });
  });

  describe('isSessionStatsTrade Data Filtering', () => {
    const baseValidTrade = {
      id: 'trade-clean-1',
      status: 'CLOSED',
      entryPrice: 100,
      closePrice: 101,
      pnl: 5,
      pnlPercent: 5
    };

    it('accepts clean operational closed trades', () => {
      expect(isSessionStatsTrade(baseValidTrade)).toBe(true);
    });

    it('rejects null or non-closed trades', () => {
      expect(isSessionStatsTrade(null)).toBe(false);
      expect(isSessionStatsTrade(undefined)).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, status: 'OPEN' })).toBe(false);
    });

    it('rejects forced resets, cleanups, gap-affected and auto-learning trades', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, isForcedReset: true })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, isSystemCleanup: true })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, gapAffected: true })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, isAutoLearning: true })).toBe(false);
    });

    it('rejects FORCED_RESET and MANUAL closeReasonCodes', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, closeReasonCode: 'FORCED_RESET' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, closeReasonCode: 'forced_reset' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, closeReasonCode: 'MANUAL' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, closeReasonCode: ' manual ' })).toBe(false);
    });

    it('rejects seed and legacy data origins', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, dataOrigin: 'SEED' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, dataOrigin: 'historical_seed' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, dataOrigin: 'FORCED_RESET' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, dataOrigin: 'legacy_unknown' })).toBe(false);
    });

    it('rejects IDs starting with hist_trade_ or seed_', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, id: 'hist_trade_123' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, id: 'seed_456' })).toBe(false);
    });

    it('rejects funding farm trades', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, mode: 'FUNDING_FARM' })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, isFundingFarm: true })).toBe(false);
    });

    it('rejects price and pnl percent outliers', () => {
      // price ratio difference > 0.25
      expect(isSessionStatsTrade({ ...baseValidTrade, entryPrice: 100, closePrice: 130 })).toBe(false);
      // pnlPercent > 100
      expect(isSessionStatsTrade({ ...baseValidTrade, pnlPercent: 120 })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, pnlPercent: -150 })).toBe(false);
    });

    it('rejects trades without finite pnl', () => {
      expect(isSessionStatsTrade({ ...baseValidTrade, pnl: NaN, realizedPnl: undefined, pnlPercent: undefined })).toBe(false);
      expect(isSessionStatsTrade({ ...baseValidTrade, pnl: undefined, realizedPnl: null, pnlPercent: Infinity })).toBe(false);
    });
  });

  describe('Sanitizers and Profit Factor', () => {
    it('sanitizeAllowedSessions returns valid sessions or defaults', () => {
      expect(sanitizeAllowedSessions(['ASIAN', 'LONDON'])).toEqual(['ASIAN', 'LONDON']);
      expect(sanitizeAllowedSessions([])).toEqual(expect.arrayContaining(['ASIAN', 'LONDON', 'OVERLAP_LONDON_NY', 'NEW_YORK', 'PACIFIC_OFF_HOURS']));
      expect(sanitizeAllowedSessions(['INVALID_SESSION'])).toEqual(expect.arrayContaining(['ASIAN']));
      expect(sanitizeAllowedSessions(null, ['LONDON'])).toEqual(['LONDON']);
    });

    it('sanitizeBlockedHours cleans, dedupes and sorts hours [0..23]', () => {
      expect(sanitizeBlockedHours([5, 3, 5, 23, 0, -1, 24, '12', 'invalid'])).toEqual([0, 3, 5, 12, 23]);
      expect(sanitizeBlockedHours(null)).toEqual([]);
    });

    it('calculates profitFactor and caps at PROFIT_FACTOR_CAP when no losses', () => {
      const winningOnly = [
        {
          id: 'clean-w1',
          status: 'CLOSED',
          openTime: new Date('2026-10-12T14:00:00Z').getTime(),
          entryPrice: 100,
          closePrice: 102,
          pnl: 20,
          pnlPercent: 2
        }
      ];
      const stats = calculateSessionStats(winningOnly);
      expect(stats.OVERLAP_LONDON_NY.profitFactor).toBe(PROFIT_FACTOR_CAP);
      expect(stats.OVERLAP_LONDON_NY.winningTrades).toBe(1);
    });
  });
});
