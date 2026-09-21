import { describe, it, expect } from 'vitest';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';

describe('SignalPerformanceAnalyticsService', () => {
  it('correctly normalizes pattern names', () => {
    expect(SignalPerformanceAnalyticsService.normalizePattern('СЛИВ МОНЕТЫ (SAR + Wick)'))
      .toBe('Слив / Отскок (SAR Peak/Bottom Reversal)');
    expect(SignalPerformanceAnalyticsService.normalizePattern('BOS/ChoCh 15m'))
      .toBe('Локальный Слом Структуры (BOS/ChoCh)');
    expect(SignalPerformanceAnalyticsService.normalizePattern('Ложный пробой VWAP'))
      .toBe('Ложный пробой (VWAP Reclaim)');
  });

  it('calculates R-Multiple correctly for LONG and SHORT trades', () => {
    // LONG: Entry 100, Exit 110, SL 95 -> Gain 10, Risk 5 -> 2.0 R
    const rLong = SignalPerformanceAnalyticsService.calculateRMultiple('LONG', 100, 110, 95);
    expect(rLong).toBe(2.0);

    // SHORT: Entry 100, Exit 90, SL 105 -> Gain 10, Risk 5 -> 2.0 R
    const rShort = SignalPerformanceAnalyticsService.calculateRMultiple('SHORT', 100, 90, 105);
    expect(rShort).toBe(2.0);

    // SHORT Loss: Entry 100, Exit 105, SL 105 -> Loss -5, Risk 5 -> -1.0 R
    const rShortLoss = SignalPerformanceAnalyticsService.calculateRMultiple('SHORT', 100, 105, 105);
    expect(rShortLoss).toBe(-1.0);
  });

  it('generates full directional and question-based analytical report', () => {
    const mockTrades = [
      {
        id: 't-1',
        symbol: 'BTC/USDT',
        side: 'LONG',
        status: 'CLOSED',
        entryPrice: 60000,
        closePrice: 61200,
        stopLoss: 59400,
        amount: 100,
        leverage: 5,
        pnl: 10,
        pnlPercent: 10,
        marketRegime: 'TREND_UP',
        pattern: 'Слив / Отскок (SAR Peak/Bottom Reversal)',
        openTime: Date.now() - 3600000,
        closeTime: Date.now(),
        decisionTrace: {
          consensusScore: 92,
          agentVotes: [
            { agentId: 'bull_analyst', vote: 'APPROVE_LONG', confidence: 95, assignedWeight: 1.0 }
          ]
        }
      },
      {
        id: 't-2',
        symbol: 'ETH/USDT',
        side: 'SHORT',
        status: 'CLOSED',
        entryPrice: 3000,
        closePrice: 2940,
        stopLoss: 3030,
        amount: 100,
        leverage: 5,
        pnl: 10,
        pnlPercent: 10,
        marketRegime: 'TREND_DOWN',
        pattern: 'Шпиль на 1м (1m Spire Climax)',
        openTime: Date.now() - 1800000,
        closeTime: Date.now(),
        decisionTrace: {
          consensusScore: 88,
          agentVotes: [
            { agentId: 'bear_analyst', vote: 'APPROVE_SHORT', confidence: 90, assignedWeight: 1.0 }
          ]
        }
      }
    ];

    const report = SignalPerformanceAnalyticsService.generatePerformanceReport(mockTrades);
    expect(report.totalAuditedTrades).toBe(2);
    expect(report.closedTradesCount).toBe(2);
    expect(report.longFutures.summary.totalTrades).toBe(1);
    expect(report.shortFutures.summary.totalTrades).toBe(1);
    expect(report.analyticalReport.question5_longVsShortEffectiveness).toBeDefined();
    expect(report.analyticalReport.question6_agentContribution.length).toBeGreaterThan(0);
    expect(report.analyticalReport.question10_lossPrecursors.length).toBe(3);
  });

  it('only builds agent contribution stats from actual recorded votes without simulation fallback', () => {
    const mockTrades = [
      {
        id: 't-with-partial-votes',
        symbol: 'SOL/USDT',
        side: 'LONG',
        status: 'CLOSED',
        entryPrice: 150,
        closePrice: 165,
        stopLoss: 145,
        amount: 100,
        leverage: 5,
        pnl: 50,
        pnlPercent: 10,
        marketRegime: 'TREND_UP',
        pattern: 'Слив / Отскок (SAR Peak/Bottom Reversal)',
        openTime: Date.now() - 3600000,
        closeTime: Date.now(),
        decisionTrace: {
          consensusScore: 90,
          agentVotes: [
            { agentId: 'bull_analyst', vote: 'APPROVE_LONG', confidence: 95, assignedWeight: 1.0 }
          ]
        }
      },
      {
        id: 't-without-trace',
        symbol: 'ADA/USDT',
        side: 'LONG',
        status: 'CLOSED',
        entryPrice: 0.5,
        closePrice: 0.55,
        stopLoss: 0.48,
        amount: 100,
        leverage: 5,
        pnl: 25,
        pnlPercent: 10,
        marketRegime: 'TREND_UP',
        pattern: 'Слив / Отскок (SAR Peak/Bottom Reversal)',
        openTime: Date.now() - 1800000,
        closeTime: Date.now()
        // No decisionTrace at all
      }
    ];

    const report = SignalPerformanceAnalyticsService.generatePerformanceReport(mockTrades);
    const byAgent = report.combined.byAgent;

    // bull_analyst had a vote in t-with-partial-votes only
    expect(byAgent.bull_analyst.totalVotes).toBe(1);
    expect(byAgent.bull_analyst.correctVotes).toBe(1);
    expect(byAgent.bull_analyst.profitContributionUsd).toBe(50);
    expect(byAgent.bull_analyst.status).toBe('INSUFFICIENT_DATA (N < 30)');

    // scout_agent, bear_analyst, liquidity_hunter, risk_sentinel had NO votes in either trade
    // Under old behavior, they would have been simulated for both trades (totalVotes = 2, profitContributionUsd = 75)
    // Under new behavior, totalVotes must be 0 and profitContributionUsd must be 0
    expect(byAgent.scout_agent.totalVotes).toBe(0);
    expect(byAgent.scout_agent.profitContributionUsd).toBe(0);
    expect(byAgent.scout_agent.status).toBe('INSUFFICIENT_DATA (N < 30)');

    expect(byAgent.bear_analyst.totalVotes).toBe(0);
    expect(byAgent.bear_analyst.profitContributionUsd).toBe(0);

    expect(byAgent.liquidity_hunter.totalVotes).toBe(0);
    expect(byAgent.liquidity_hunter.profitContributionUsd).toBe(0);

    expect(byAgent.risk_sentinel.totalVotes).toBe(0);
    expect(byAgent.risk_sentinel.profitContributionUsd).toBe(0);
  });
});
