import { isOperationalTrade } from './tradeMetrics.ts';
import { inferDataOrigin, inferCloseReasonCode } from './tradeSchema.ts';
import type { MarketRegime, DecisionTrace, TradePosition } from '../types/trading.ts';
import { MIN_TRADES_FOR_PATTERN_STATISTICS, isPatternProtected } from './signalEngine.ts';
import { getConfigVersion } from './buildInfo.ts';
import { getCostModel } from './costModel.ts';
import { getFunnelData } from './funnelCounters.ts';

export interface GranularBreakdownMetric {
  category: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  avgPnlUsd: number;
  profitFactor: number;
  avgRMultiple: number;
  avgMaePct: number;
  avgMfePct: number;
  avgSlippagePct: number;
  totalFeesUsd: number;
  avgHoldDurationMs: number;
  expectancyUsd: number;
  statisticalStatus?: 'CONFIRMED' | 'STRONG_EVIDENCE' | 'MODERATE_EVIDENCE' | 'WEAK_EVIDENCE' | 'INCONCLUSIVE' | 'INSUFFICIENT_DATA';
}

export interface DirectionalGranularStats {
  side: 'LONG' | 'SHORT' | 'COMBINED';
  summary: GranularBreakdownMetric;
  byMarketRegime: Record<string, GranularBreakdownMetric>;
  byPattern: Record<string, GranularBreakdownMetric>;
  byConfidenceRange: Record<string, GranularBreakdownMetric>;
  byAgent: Record<string, {
    agentId: string;
    agentName: string;
    role: string;
    totalVotes: number;
    correctVotes: number;
    accuracy: number;
    avgConfidence: number;
    avgAssignedWeight: number;
    avgDynamicWeight: number;
    profitContributionUsd: number;
    status: string;
  }>;
  byFactorCombinations: Record<string, GranularBreakdownMetric>;
}

export interface AnalyticalQuestionsReport {
  question1_profitablePatterns: Array<{ pattern: string; winRate: number; totalPnl: number; avgR: number; tradesCount: number; status: string }>;
  question2_unprofitablePatterns: Array<{ pattern: string; winRate: number; totalPnl: number; avgR: number; tradesCount: number; status: string }>;
  question3_bestMarketRegimes: Array<{ regime: string; winRate: number; totalPnl: number; profitFactor: number; tradesCount: number; status: string }>;
  question4_worstMarketRegimes: Array<{ regime: string; winRate: number; totalPnl: number; maxDd: number; tradesCount: number; status: string }>;
  question5_longVsShortEffectiveness: {
    long: { winRate: number; totalPnl: number; profitFactor: number; avgR: number; tradesCount: number; expectancy: number };
    short: { winRate: number; totalPnl: number; profitFactor: number; avgR: number; tradesCount: number; expectancy: number };
    dominantSide: 'LONG' | 'SHORT' | 'BALANCED' | 'INSUFFICIENT_DATA';
    verdict: string;
  };
  question6_agentContribution: Array<{
    agentId: string;
    agentName: string;
    role: string;
    accuracy: number;
    pnlImpact: number;
    weight: number;
    verdict: string;
    status: string;
  }>;
  question7_confidenceExpectancy: Array<{
    tier: string;
    tradesCount: number;
    winRate: number;
    expectancyUsd: number;
    hasPositiveExpectancy: boolean;
  }>;
  question8_bestFactorCombinations: Array<{
    factorsCombo: string;
    tradesCount: number;
    winRate: number;
    totalPnl: number;
    avgR: number;
  }>;
  question9_filterAnalysis: {
    totalSignalsFilteredOut: number;
    riskSentinelBlocks: number;
    consensusRejections: number;
    falseRejectionsEstimatedRate: number;
    summary: string;
  };
  question10_lossPrecursors: Array<{
    precursor: string;
    frequencyInLossesPct: number;
    description: string;
  }>;
}

export interface StrictForwardTestAudit {
  mode: 'STRICT_OUT_OF_SAMPLE_FORWARD_TEST';
  totalTradesInDb: number;
  historicalSeedCount: number;
  outOfSampleTotal: number;
  outOfSampleClosed: number;
  outOfSampleOpen: number;
  targetSampleSize: number;
  isSampleSufficientForReview: boolean;
  progressPct: number;
  isolationStatus: string;
  ruleMutationPolicy: string;
  confirmationGateRule: string;
  firstReviewTriggered: boolean;
}

export interface SignalPerformanceReport {
  generatedAt: number;
  configVersion?: string;
  activeOriginFilter: 'OUT_OF_SAMPLE' | 'ALL' | 'HISTORICAL_SEED' | 'LIVE_WEEX' | 'PAPER_SIM';
  strictForwardTestAudit: StrictForwardTestAudit;
  totalAuditedTrades: number;
  openTradesCount: number;
  closedTradesCount: number;
  longFutures: DirectionalGranularStats;
  shortFutures: DirectionalGranularStats;
  combined: DirectionalGranularStats;
  analyticalReport: AnalyticalQuestionsReport;
  rawAuditedTrades: Array<{
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    status: 'OPEN' | 'CLOSED';
    dataOrigin: 'HISTORICAL_SEED' | 'PAPER_SIM' | 'LIVE_WEEX' | 'FORCED_RESET' | 'LEGACY_UNKNOWN';
    marketRegime: string;
    pattern: string;
    entryPrice: number;
    closePrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    amount: number;
    leverage: number;
    pnl: number;
    pnlPercent: number;
    rMultiple: number;
    maePct: number;
    mfePct: number;
    slippagePct: number;
    feeUsd: number;
    holdDurationMs: number;
    confidenceScore: number;
    consensusScore: number;
    dynamicWeight?: number;
    riskSentinelDecision: string;
    decisionTrace?: DecisionTrace;
    openTime: number;
    closeTime?: number;
    configVersion?: string;
    gapAffected?: boolean;
    gapSec?: number;
    closeReasonCode?: string;
    indicatorsSource?: string;
    entryDiagnostics?: any;
  }>;
}

export class SignalPerformanceAnalyticsService {
  /**
   * Helper to normalize pattern names into consistent categories
   */
  public static normalizePattern(rawPattern?: string): string {
    if (!rawPattern) return 'Общий сигнал / Слив';
    const p = rawPattern.toLowerCase();
    if (p.includes('sar') || p.includes('слив') || p.includes('отскок')) return 'Слив / Отскок (SAR Peak/Bottom Reversal)';
    if (p.includes('ложный') || p.includes('vwap') || p.includes('false')) return 'Ложный пробой (VWAP Reclaim)';
    if (p.includes('истощение') || p.includes('parabolic') || p.includes('blowout')) return 'Вертикальное истощение / Параболик';
    if (p.includes('шпиль') || p.includes('spire') || p.includes('climax')) return 'Шпиль на 1м (1m Spire Climax)';
    if (p.includes('фитил') || p.includes('retest') || p.includes('двойн')) return 'Ретест Фитиля / Двойная Вершина/Дно';
    if (p.includes('bos') || p.includes('choch') || p.includes('слом')) return 'Локальный Слом Структуры (BOS/ChoCh)';
    if (p.includes('потолок') || p.includes('пол') || p.includes('stagnation') || p.includes('плотност')) return 'Невидимый потолок/пол (Price Stagnation)';
    return rawPattern;
  }

  /**
   * Calculate R-Multiple for a trade
   */
  public static calculateRMultiple(
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    closePrice: number,
    stopLoss?: number
  ): number {
    if (!entryPrice || !closePrice) return 0;
    if (!stopLoss || stopLoss === entryPrice) {
      // Fallback: estimate 2% initial risk if SL wasn't explicitly logged
      const defaultRiskDistance = entryPrice * 0.02;
      const actualDelta = side === 'LONG' ? (closePrice - entryPrice) : (entryPrice - closePrice);
      return Number((actualDelta / defaultRiskDistance).toFixed(2));
    }

    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance === 0) return 0;

    const actualDelta = side === 'LONG' ? (closePrice - entryPrice) : (entryPrice - closePrice);
    return Number((actualDelta / riskDistance).toFixed(2));
  }

  /**
   * Calculate MAE (Max Adverse Excursion) & MFE (Max Favorable Excursion) estimates
   */
  public static estimateMaeMfe(
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    closePrice: number,
    pnlPct: number
  ): { maePct: number; mfePct: number } {
    // If trade was profitable, MAE is typical intra-trade retracement, MFE exceeds final exit
    if (pnlPct > 0) {
      const maePct = Number((Math.min(1.5, Math.abs(pnlPct) * 0.25)).toFixed(2));
      const mfePct = Number((Math.abs(pnlPct) * 1.15).toFixed(2));
      return { maePct, mfePct };
    } else {
      const maePct = Number((Math.abs(pnlPct) * 1.05).toFixed(2));
      const mfePct = Number((Math.max(0.2, Math.abs(pnlPct) * 0.15)).toFixed(2));
      return { maePct, mfePct };
    }
  }

  /**
   * Helper to aggregate a list of audited trades into GranularBreakdownMetric
   */
  public static aggregateMetric(category: string, items: any[]): GranularBreakdownMetric {
    const totalTrades = items.length;
    if (totalTrades === 0) {
      return {
        category,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnlUsd: 0,
        totalPnlPercent: 0,
        avgPnlUsd: 0,
        profitFactor: 0,
        avgRMultiple: 0,
        avgMaePct: 0,
        avgMfePct: 0,
        avgSlippagePct: 0,
        totalFeesUsd: 0,
        avgHoldDurationMs: 0,
        expectancyUsd: 0
      };
    }

    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalPnlUsd = 0;
    let totalPnlPct = 0;
    let totalR = 0;
    let totalMae = 0;
    let totalMfe = 0;
    let totalSlippage = 0;
    let totalFees = 0;
    let totalHold = 0;

    for (const t of items) {
      const pnl = Number(t.pnl || 0);
      const pnlPct = Number(t.pnlPercent || 0);
      totalPnlUsd += pnl;
      totalPnlPct += pnlPct;
      totalR += Number(t.rMultiple || 0);
      totalMae += Number(t.maePct || 0);
      totalMfe += Number(t.mfePct || 0);
      totalSlippage += Number(t.slippagePct ?? 0);
      totalFees += Number(t.feeUsd || 0);
      totalHold += Number(t.holdDurationMs || 0);

      if (pnl > 0) {
        wins++;
        grossProfit += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLoss += Math.abs(pnl);
      }
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
    const avgProfit = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const winProb = totalTrades > 0 ? wins / totalTrades : 0;
    const lossProb = totalTrades > 0 ? losses / totalTrades : 0;
    const expectancyUsd = (winProb * avgProfit) - (lossProb * avgLoss);

    return {
      category,
      totalTrades,
      winningTrades: wins,
      losingTrades: losses,
      winRate: Number(winRate.toFixed(1)),
      totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
      totalPnlPercent: Number(totalPnlPct.toFixed(1)),
      avgPnlUsd: Number((totalPnlUsd / totalTrades).toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      avgRMultiple: Number((totalR / totalTrades).toFixed(2)),
      avgMaePct: Number((totalMae / totalTrades).toFixed(2)),
      avgMfePct: Number((totalMfe / totalTrades).toFixed(2)),
      avgSlippagePct: Number((totalSlippage / totalTrades).toFixed(3)),
      totalFeesUsd: Number(totalFees.toFixed(2)),
      avgHoldDurationMs: Math.round(totalHold / totalTrades),
      expectancyUsd: Number(expectancyUsd.toFixed(2))
    };
  }

  /**
   * Generate Full Signal Performance and Data Collection Report
   */
  public static generatePerformanceReport(
    trades: any[], 
    activeSignals: any[] = [],
    originFilter: 'OUT_OF_SAMPLE' | 'ALL' | 'HISTORICAL_SEED' | 'LIVE_WEEX' | 'PAPER_SIM' = 'OUT_OF_SAMPLE',
    settings?: any
  ): SignalPerformanceReport {
    // 1. Audit and enrich every trade with strict dataOrigin classification
    const allAuditedTrades = trades.map(t => {
      const origin = inferDataOrigin(t);
      let canonicalOrigin: 'HISTORICAL_SEED' | 'PAPER_SIM' | 'LIVE_WEEX' | 'FORCED_RESET' | 'LEGACY_UNKNOWN' = 'LEGACY_UNKNOWN';
      
      const tradeId = String(t.id || '');
      if (origin === 'SEED' || origin === 'HISTORICAL_SEED' || tradeId.startsWith('hist_trade_') || tradeId.startsWith('seed_')) {
        canonicalOrigin = 'HISTORICAL_SEED';
      } else if (origin === 'FORCED_RESET' || t.isForcedReset) {
        canonicalOrigin = 'FORCED_RESET';
      } else if (origin === 'LIVE' || origin === 'LIVE_WEEX' || t.isReal === true) {
        canonicalOrigin = 'LIVE_WEEX';
      } else if (origin === 'PAPER' || origin === 'PAPER_SIM' || t.isPaper || t.isAutoLearning || t.mode === 'AUTO' || t.mode === 'SEMI_AUTO' || t.isReal === false || !t.isReal) {
        canonicalOrigin = 'PAPER_SIM';
      }

      const side: 'LONG' | 'SHORT' = t.side === 'LONG' ? 'LONG' : 'SHORT';
      const entryPrice = Number(t.entryPrice || 0);
      const closePrice = Number(t.closePrice || entryPrice);
      const pnl = Number(t.pnl !== undefined ? t.pnl : ((t.amount || 10) * ((t.pnlPercent || 0) / 100)));
      const pnlPercent = Number(t.pnlPercent !== undefined ? t.pnlPercent : (entryPrice > 0 ? ((closePrice - entryPrice) / entryPrice) * (side === 'LONG' ? 100 : -100) * (t.leverage || 1) : 0));
      const rMultiple = this.calculateRMultiple(side, entryPrice, closePrice, t.stopLoss);
      const costModel = getCostModel(settings);
      const leverage = Math.max(1, Number(t.leverage || 1));
      const highestPrice = Number(t.highestPrice || 0);
      const lowestPrice = Number(t.lowestPrice || 0);
      const hasRealExcursion = entryPrice > 0 && highestPrice > 0 && lowestPrice > 0 && (highestPrice !== entryPrice || lowestPrice !== entryPrice);

      let maePct: number;
      let mfePct: number;
      if (hasRealExcursion) {
        if (side === 'LONG') {
          mfePct = Number(Math.max(0, ((highestPrice - entryPrice) / entryPrice) * 100 * leverage).toFixed(2));
          maePct = Number(Math.max(0, ((entryPrice - lowestPrice) / entryPrice) * 100 * leverage).toFixed(2));
        } else {
          mfePct = Number(Math.max(0, ((entryPrice - lowestPrice) / entryPrice) * 100 * leverage).toFixed(2));
          maePct = Number(Math.max(0, ((highestPrice - entryPrice) / entryPrice) * 100 * leverage).toFixed(2));
        }
      } else {
        const est = this.estimateMaeMfe(side, entryPrice, closePrice, pnlPercent);
        maePct = est.maePct;
        mfePct = est.mfePct;
      }

      const notional = Number(t.amount || t.initialAmount || 10) * leverage;
      const feeUsd = t.feeUsd !== undefined && !isNaN(Number(t.feeUsd))
        ? Number(Number(t.feeUsd).toFixed(2))
        : Number((notional * costModel.feeRatePerSide * 2).toFixed(2));
      const slippagePct = t.slippagePct !== undefined && !isNaN(Number(t.slippagePct))
        ? Number(Number(t.slippagePct).toFixed(3))
        : Number((costModel.slippageRoundTrip * 100).toFixed(3));
      const holdDurationMs = (t.closeTime && t.openTime) ? Math.max(0, t.closeTime - t.openTime) : Math.max(0, Date.now() - (t.openTime || Date.now()));

      const pattern = this.normalizePattern(t.patternName || t.matchedPattern || t.pattern || (t.decisionTrace?.triggerPattern));
      const marketRegime: MarketRegime = t.marketRegime || t.decisionTrace?.marketRegime || 'NEUTRAL';
      const confidenceScore = Number(t.signalAiScore ?? t.decisionTrace?.consensusScore ?? 0);
      const consensusScore = Number(t.decisionTrace?.consensusScore ?? confidenceScore);
      const dynamicWeight = Number(t.dynamicWeight || t.assignedWeight || 1.0);
      const riskSentinelDecision = t.riskSentinelDecision || (t.decisionTrace?.passedConsensus ? 'APPROVED' : 'UNKNOWN');

      return {
        id: t.id || `trade-${Math.random()}`,
        symbol: t.symbol || 'BTC/USDT',
        side,
        status: (t.status || (t.closedAt || t.pnl !== undefined ? 'CLOSED' : 'OPEN')) as 'OPEN' | 'CLOSED',
        dataOrigin: canonicalOrigin,
        marketRegime,
        pattern,
        entryPrice,
        closePrice: t.status === 'CLOSED' || t.pnl !== undefined ? closePrice : undefined,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        amount: Number(t.amount || t.initialAmount || 10),
        leverage: Number(t.leverage || 1),
        pnl: Number(pnl.toFixed(2)),
        pnlPercent: Number(pnlPercent.toFixed(2)),
        rMultiple,
        maePct,
        mfePct,
        slippagePct,
        feeUsd,
        holdDurationMs,
        confidenceScore,
        consensusScore,
        dynamicWeight,
        riskSentinelDecision,
        decisionTrace: t.decisionTrace,
        openTime: t.openTime || Date.now(),
        closeTime: t.closeTime,
        configVersion: t.configVersion,
        gapAffected: t.gapAffected,
        gapSec: t.gapSec,
        closeReasonCode: t.closeReasonCode || ((t.status === 'CLOSED' || t.closedAt || t.pnl !== undefined) ? inferCloseReasonCode(t) : undefined),
        indicatorsSource: t.entryDiagnostics?.indicatorsSource ?? t.indicatorsSource,
        entryDiagnostics: t.entryDiagnostics
      };
    });

    // 2. Strict Out-of-Sample Audit counts
    const historicalSeedTrades = allAuditedTrades.filter(t => t.dataOrigin === 'HISTORICAL_SEED');
    const outOfSampleTrades = allAuditedTrades.filter(t => t.dataOrigin === 'LIVE_WEEX' || t.dataOrigin === 'PAPER_SIM');
    const outOfSampleClosed = outOfSampleTrades.filter(t => t.status === 'CLOSED');
    const outOfSampleOpen = outOfSampleTrades.filter(t => t.status === 'OPEN');

    const targetSampleSize = 30;
    const isSampleSufficientForReview = outOfSampleClosed.length >= targetSampleSize;
    const progressPct = Math.min(100, Math.round((outOfSampleClosed.length / targetSampleSize) * 100));

    const strictForwardTestAudit: StrictForwardTestAudit = {
      mode: 'STRICT_OUT_OF_SAMPLE_FORWARD_TEST',
      totalTradesInDb: allAuditedTrades.length,
      historicalSeedCount: historicalSeedTrades.length,
      outOfSampleTotal: outOfSampleTrades.length,
      outOfSampleClosed: outOfSampleClosed.length,
      outOfSampleOpen: outOfSampleOpen.length,
      targetSampleSize,
      isSampleSufficientForReview,
      progressPct,
      isolationStatus: 'HISTORICAL_SEED ISOLATED (100% Zero Contamination)',
      ruleMutationPolicy: 'FROZEN (Strict Forward Test: No Auto-Mutation of Rules or Weights)',
      confirmationGateRule: 'STATUS CONFIRMED FORBIDDEN FOR N < 30 INDEPENDENT OUTCOMES',
      firstReviewTriggered: isSampleSufficientForReview
    };

    // 3. Filter trades according to requested view
    let auditedList: typeof allAuditedTrades;
    if (originFilter === 'OUT_OF_SAMPLE') {
      auditedList = outOfSampleTrades;
    } else if (originFilter === 'HISTORICAL_SEED') {
      auditedList = historicalSeedTrades;
    } else if (originFilter === 'LIVE_WEEX') {
      auditedList = allAuditedTrades.filter(t => t.dataOrigin === 'LIVE_WEEX');
    } else if (originFilter === 'PAPER_SIM') {
      auditedList = allAuditedTrades.filter(t => t.dataOrigin === 'PAPER_SIM');
    } else {
      // ALL
      auditedList = allAuditedTrades.filter(t => t.dataOrigin !== 'FORCED_RESET');
    }

    const closedTrades = auditedList.filter(t => t.status === 'CLOSED');
    const openTrades = auditedList.filter(t => t.status === 'OPEN');

    // 4. Build directional slices (LONG vs SHORT vs COMBINED)
    const buildDirectionalGranularStats = (sideFilter?: 'LONG' | 'SHORT'): DirectionalGranularStats => {
      const side = sideFilter || 'COMBINED';
      const scopedTrades = sideFilter ? closedTrades.filter(t => t.side === sideFilter) : closedTrades;

      // Summary
      const summary = this.aggregateMetric(side, scopedTrades);
      if (summary.totalTrades < 30) {
        summary.statisticalStatus = 'INSUFFICIENT_DATA';
      } else if (summary.winRate >= 70 && summary.profitFactor >= 2.0) {
        summary.statisticalStatus = 'STRONG_EVIDENCE';
      } else if (summary.winRate >= 55) {
        summary.statisticalStatus = 'MODERATE_EVIDENCE';
      } else {
        summary.statisticalStatus = 'INCONCLUSIVE';
      }

      // By Market Regime
      const regimes: MarketRegime[] = ['TREND_UP', 'TREND_DOWN', 'RANGING_FLAT', 'HIGH_VOLATILITY', 'EXTREME_SQUEEZE', 'NEUTRAL'];
      const byMarketRegime: Record<string, GranularBreakdownMetric> = {};
      for (const r of regimes) {
        const matches = scopedTrades.filter(t => t.marketRegime === r);
        const metric = this.aggregateMetric(r, matches);
        metric.statisticalStatus = metric.totalTrades < 30 ? 'INSUFFICIENT_DATA' : (metric.winRate >= 65 ? 'MODERATE_EVIDENCE' : 'INCONCLUSIVE');
        byMarketRegime[r] = metric;
      }

      // By Pattern
      const patterns = [
        'Слив / Отскок (SAR Peak/Bottom Reversal)',
        'Ложный пробой (VWAP Reclaim)',
        'Вертикальное истощение / Параболик',
        'Шпиль на 1м (1m Spire Climax)',
        'Ретест Фитиля / Двойная Вершина/Дно',
        'Локальный Слом Структуры (BOS/ChoCh)',
        'Невидимый потолок/пол (Price Stagnation)',
        'Общий сигнал / Слив'
      ];
      const byPattern: Record<string, GranularBreakdownMetric> = {};
      for (const p of patterns) {
        const matches = scopedTrades.filter(t => t.pattern === p);
        const metric = this.aggregateMetric(p, matches);
        metric.statisticalStatus = metric.totalTrades < 30 ? 'INSUFFICIENT_DATA' : (metric.winRate >= 70 ? 'STRONG_EVIDENCE' : 'INCONCLUSIVE');
        byPattern[p] = metric;
      }

      // By Confidence Range
      const confRanges = [
        { label: '90-100% (High Conviction)', min: 90, max: 100 },
        { label: '80-89% (Optimal Setup)', min: 80, max: 89.9 },
        { label: '70-79% (Standard Threshold)', min: 70, max: 79.9 },
        { label: '<70% (Low / Warning)', min: 0, max: 69.9 }
      ];
      const byConfidenceRange: Record<string, GranularBreakdownMetric> = {};
      for (const cr of confRanges) {
        const matches = scopedTrades.filter(t => t.confidenceScore >= cr.min && t.confidenceScore <= cr.max);
        byConfidenceRange[cr.label] = this.aggregateMetric(cr.label, matches);
      }

      // By Agent
      const agentDefinitions = [
        { id: 'scout_agent', name: 'ИИ-Сканер (Scout)', role: 'SCOUT', baseWeight: 1.0 },
        { id: 'bull_analyst', name: 'Бычий Аналитик (Bull Analyst)', role: 'BULL_ANALYST', baseWeight: 1.0 },
        { id: 'bear_analyst', name: 'Медвежий Аналитик (Bear Analyst)', role: 'BEAR_ANALYST', baseWeight: 1.0 },
        { id: 'liquidity_hunter', name: 'Охотник за Ликвидностью (Liquidity Hunter)', role: 'LIQUIDITY_HUNTER', baseWeight: 1.1 },
        { id: 'risk_sentinel', name: 'Риск-Страж (Risk Sentinel)', role: 'RISK_SENTINEL', baseWeight: 1.3 }
      ];

      const byAgent: Record<string, any> = {};
      for (const agent of agentDefinitions) {
        let votesCount = 0;
        let correctCount = 0;
        let confSum = 0;
        let weightSum = 0;
        let pnlContribution = 0;

        for (const t of scopedTrades) {
          const isWin = t.pnl > 0;
          const trace = t.decisionTrace;
          const vote = trace?.agentVotes?.find(v => v.agentId === agent.id);

          if (vote) {
            votesCount++;
            confSum += (vote.confidence || 80);
            weightSum += (vote.assignedWeight || agent.baseWeight);
            const isApproved = (vote.vote === 'APPROVE_LONG' || vote.vote === 'APPROVE_SHORT');
            if ((isWin && isApproved) || (!isWin && vote.vote === 'REJECT')) {
              correctCount++;
            }
            if (isApproved) {
              pnlContribution += t.pnl;
            }
          }
        }

        const accuracy = votesCount > 0 ? (correctCount / votesCount) * 100 : 0;
        const avgConfidence = votesCount > 0 ? confSum / votesCount : 0;
        const avgAssignedWeight = votesCount > 0 ? weightSum / votesCount : agent.baseWeight;
        const dynamicWeight = votesCount > 0
          ? Number(Math.max(0.5, Math.min(2.0, avgAssignedWeight * (accuracy / 70.0))).toFixed(2))
          : Number(avgAssignedWeight.toFixed(2));
        const status = votesCount < 30 ? 'INSUFFICIENT_DATA (N < 30)' : (accuracy >= 75 ? 'STRONG_EVIDENCE' : 'INCONCLUSIVE');

        byAgent[agent.id] = {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          totalVotes: votesCount,
          correctVotes: correctCount,
          accuracy: Number(accuracy.toFixed(1)),
          avgConfidence: Number(avgConfidence.toFixed(1)),
          avgAssignedWeight: Number(avgAssignedWeight.toFixed(2)),
          avgDynamicWeight: dynamicWeight,
          profitContributionUsd: Number(pnlContribution.toFixed(2)),
          status
        };
      }

      // By Factor Combinations
      const factorCombos = [
        { label: 'Liquidity Sweep + Parabolic SAR Reversal', tag: 'sweep_sar' },
        { label: 'VWAP Reclaim + Long Wick (Pinbar > 50%)', tag: 'vwap_wick' },
        { label: 'Volume Climax + BOS/ChoCh Structure Shift', tag: 'volume_bos' },
        { label: 'OrderBook Wall Defense + SAR Confirmation', tag: 'ob_sar' },
        { label: 'Parabolic Blowout Curve + 1m Spire Exhaustion', tag: 'parabolic_spire' }
      ];

      const byFactorCombinations: Record<string, GranularBreakdownMetric> = {};
      factorCombos.forEach((fc) => {
        const subset = scopedTrades.filter((t) => {
          if (t.decisionTrace?.factors?.length) {
            return t.decisionTrace.factors.some(f => f.name.toLowerCase().includes(fc.tag));
          }
          return false;
        });
        byFactorCombinations[fc.label] = this.aggregateMetric(fc.label, subset);
      });

      return {
        side,
        summary,
        byMarketRegime,
        byPattern,
        byConfidenceRange,
        byAgent,
        byFactorCombinations
      };
    };

    const longFutures = buildDirectionalGranularStats('LONG');
    const shortFutures = buildDirectionalGranularStats('SHORT');
    const combined = buildDirectionalGranularStats();

    // 5. Compute Answers to Analytical Questions with strict N < 30 Guard
    const patternEntries = Object.entries(combined.byPattern).filter(([_, m]) => m.totalTrades > 0);
    const sortedByExpectancy = [...patternEntries].sort((a, b) => b[1].expectancyUsd - a[1].expectancyUsd);

    const question1_profitablePatterns = sortedByExpectancy
      .filter(([_, m]) => m.expectancyUsd >= 0 || m.totalPnlUsd > 0)
      .map(([pat, m]) => ({
        pattern: pat,
        winRate: m.winRate,
        totalPnl: m.totalPnlUsd,
        avgR: m.avgRMultiple,
        tradesCount: m.totalTrades,
        status: m.totalTrades < 30 ? `НАКОПЛЕНИЕ (${m.totalTrades}/30)` : (m.winRate >= 70 ? 'STRONG EVIDENCE' : 'MODERATE EVIDENCE')
      }));

    const question2_unprofitablePatterns = sortedByExpectancy
      .filter(([_, m]) => m.expectancyUsd < 0 && m.totalPnlUsd <= 0)
      .map(([pat, m]) => ({
        pattern: pat,
        winRate: m.winRate,
        totalPnl: m.totalPnlUsd,
        avgR: m.avgRMultiple,
        tradesCount: m.totalTrades,
        status: m.totalTrades < 30 ? `НАКОПЛЕНИЕ (${m.totalTrades}/30)` : 'INCONCLUSIVE'
      }));

    const regimeEntries = Object.entries(combined.byMarketRegime).filter(([_, m]) => m.totalTrades > 0);
    const sortedRegimes = [...regimeEntries].sort((a, b) => b[1].winRate - a[1].winRate);

    const question3_bestMarketRegimes = sortedRegimes
      .filter(([_, m]) => m.winRate >= 50 && m.totalPnlUsd >= 0)
      .map(([reg, m]) => ({
        regime: reg,
        winRate: m.winRate,
        totalPnl: m.totalPnlUsd,
        profitFactor: m.profitFactor,
        tradesCount: m.totalTrades,
        status: m.totalTrades < 30 ? `НАКОПЛЕНИЕ (${m.totalTrades}/30)` : 'CONFIRMED ON N>=30'
      }));

    const question4_worstMarketRegimes = sortedRegimes
      .filter(([_, m]) => m.winRate < 50 || m.totalPnlUsd < 0)
      .map(([reg, m]) => ({
        regime: reg,
        winRate: m.winRate,
        totalPnl: m.totalPnlUsd,
        maxDd: Math.abs(Math.min(0, m.totalPnlUsd)),
        tradesCount: m.totalTrades,
        status: m.totalTrades < 30 ? `НАКОПЛЕНИЕ (${m.totalTrades}/30)` : 'NEGATIVE EXPECTANCY'
      }));

    // Question 5: Long vs Short
    const longPnl = longFutures.summary.totalPnlUsd;
    const shortPnl = shortFutures.summary.totalPnlUsd;
    let dominantSide: 'LONG' | 'SHORT' | 'BALANCED' | 'INSUFFICIENT_DATA' = 'INSUFFICIENT_DATA';
    let directionalVerdict = 'Недостаточно независимых сделок out-of-sample (N < 30). Идет накопление чистой выборки.';

    if (closedTrades.length >= 30) {
      dominantSide = longPnl > shortPnl + 10 ? 'LONG' : (shortPnl > longPnl + 10 ? 'SHORT' : 'BALANCED');
      directionalVerdict = dominantSide === 'BALANCED'
        ? 'LONG и SHORT демонстрируют симметричную эффективность при строгой селекции по SAR и Liquidity Sweeps.'
        : `Направление ${dominantSide} на out-of-sample выборке показывает опережающую прибыльность и более высокий Win Rate.`;
    }

    const question5_longVsShortEffectiveness = {
      long: {
        winRate: longFutures.summary.winRate,
        totalPnl: longFutures.summary.totalPnlUsd,
        profitFactor: longFutures.summary.profitFactor,
        avgR: longFutures.summary.avgRMultiple,
        tradesCount: longFutures.summary.totalTrades,
        expectancy: longFutures.summary.expectancyUsd
      },
      short: {
        winRate: shortFutures.summary.winRate,
        totalPnl: shortFutures.summary.totalPnlUsd,
        profitFactor: shortFutures.summary.profitFactor,
        avgR: shortFutures.summary.avgRMultiple,
        tradesCount: shortFutures.summary.totalTrades,
        expectancy: shortFutures.summary.expectancyUsd
      },
      dominantSide,
      verdict: directionalVerdict
    };

    // Question 6: Agent Contribution
    const question6_agentContribution = Object.values(combined.byAgent).map(a => ({
      agentId: a.agentId,
      agentName: a.agentName,
      role: a.role,
      accuracy: a.accuracy,
      pnlImpact: a.profitContributionUsd,
      weight: a.avgDynamicWeight,
      status: a.status,
      verdict: a.totalVotes < 30
        ? `Накопление независимой статистики (${a.totalVotes}/30 голосов). Изменение базовых весов заморожено.`
        : (a.accuracy >= 70 ? `Высокая надёжность (${a.accuracy}% accuracy), обеспечивает положительный вклад в PnL.` : `Точность ${a.accuracy}%. Требуется дальнейший аудит.`)
    }));

    // Question 7: Confidence Expectancy
    const question7_confidenceExpectancy = Object.entries(combined.byConfidenceRange).map(([tier, m]) => ({
      tier,
      tradesCount: m.totalTrades,
      winRate: m.winRate,
      expectancyUsd: m.expectancyUsd,
      hasPositiveExpectancy: m.expectancyUsd > 0 || m.totalPnlUsd > 0
    }));

    // Question 8: Factor Combinations
    const question8_bestFactorCombinations = Object.entries(combined.byFactorCombinations)
      .map(([combo, m]) => ({
        factorsCombo: combo,
        tradesCount: m.totalTrades,
        winRate: m.winRate,
        totalPnl: m.totalPnlUsd,
        avgR: m.avgRMultiple
      }))
      .sort((a, b) => b.winRate - a.winRate);

    // Question 9: Filter Analysis (computed from real 24h funnel telemetry)
    const funnel = getFunnelData(24);
    let riskSentinelBlocks = 0;
    let consensusRejections = 0;
    let otherBlocks = 0;
    let seenTotal = 0;

    for (const [key, count] of Object.entries(funnel.aggregated || {})) {
      const stage = key.split('|')[0]?.toLowerCase() || '';
      if (stage === 'seen') {
        seenTotal += count;
      } else if (stage === 'executed' || stage === 'opened' || stage === 'entry') {
        // non-rejection telemetry stage
      } else if (stage.includes('risk')) {
        riskSentinelBlocks += count;
      } else if (stage.includes('committee') || stage.includes('consensus') || stage.includes('veto') || stage.includes('ai')) {
        consensusRejections += count;
      } else {
        otherBlocks += count;
      }
    }
    const totalSignalsFilteredOut = riskSentinelBlocks + consensusRejections + otherBlocks;
    const denominatorSeen = Math.max(totalSignalsFilteredOut + closedTrades.length, seenTotal);
    const filterPct = denominatorSeen > 0 ? Number(((totalSignalsFilteredOut / denominatorSeen) * 100).toFixed(1)) : 0;

    const question9_filterAnalysis = {
      totalSignalsFilteredOut,
      riskSentinelBlocks,
      consensusRejections,
      falseRejectionsEstimatedRate: 0,
      summary: totalSignalsFilteredOut > 0
        ? `За последние 24ч отфильтровано ${totalSignalsFilteredOut} сигналов (${filterPct}% от потока): Risk Sentinel — ${riskSentinelBlocks}, Consensus/AI — ${consensusRejections}, прочие воронки — ${otherBlocks}.`
        : 'За последние 24ч зафиксировано 0 отклонённых сигналов в телеметрии воронки (funnelCounters).'
    };

    // Question 10: Loss Precursors (computed dynamically from closed losing trades)
    const losses = closedTrades.filter(t => t.pnl < 0);
    const calcPct = (count: number) => losses.length > 0 ? Math.round((count / losses.length) * 100) : 0;

    const highMaeLosses = losses.filter(t => t.maePct > 1.2).length;
    const fullStopLosses = losses.filter(t => t.closeReasonCode === 'STOP_LOSS' || t.rMultiple <= -0.9).length;
    const counterTrendOrDegradedLosses = losses.filter(
      t => t.gapAffected || t.indicatorsSource === 'FALLBACK' ||
           (t.side === 'SHORT' && t.marketRegime === 'TREND_UP') ||
           (t.side === 'LONG' && t.marketRegime === 'TREND_DOWN')
    ).length;

    const highMaePct = calcPct(highMaeLosses);
    const fullStopPct = calcPct(fullStopLosses);
    const counterTrendPct = calcPct(counterTrendOrDegradedLosses);

    const question10_lossPrecursors = [
      {
        precursor: 'Повышенный MAE против входа (> 1.2% с плечом)',
        frequencyInLossesPct: highMaePct,
        description: losses.length > 0
          ? `Наблюдался в ${highMaeLosses} из ${losses.length} убыточных сделок (${highMaePct}%), указывает на ранний вход до завершения импульса.`
          : 'Убыточные сделки в текущей выборке отсутствуют.'
      },
      {
        precursor: 'Срабатывание полного Stop-Loss (R <= -0.9)',
        frequencyInLossesPct: fullStopPct,
        description: losses.length > 0
          ? `Зафиксировано в ${fullStopLosses} из ${losses.length} убыточных сделок (${fullStopPct}%).`
          : 'Убыточные сделки в текущей выборке отсутствуют.'
      },
      {
        precursor: 'Вход против режима рынка (HTF) или на деградированных свечах',
        frequencyInLossesPct: counterTrendPct,
        description: losses.length > 0
          ? `Обнаружено в ${counterTrendOrDegradedLosses} из ${losses.length} убыточных сделок (${counterTrendPct}%).`
          : 'Убыточные сделки в текущей выборке отсутствуют.'
      }
    ];

    const analyticalReport: AnalyticalQuestionsReport = {
      question1_profitablePatterns,
      question2_unprofitablePatterns,
      question3_bestMarketRegimes,
      question4_worstMarketRegimes,
      question5_longVsShortEffectiveness,
      question6_agentContribution,
      question7_confidenceExpectancy,
      question8_bestFactorCombinations,
      question9_filterAnalysis,
      question10_lossPrecursors
    };

    return {
      generatedAt: Date.now(),
      configVersion: getConfigVersion(settings),
      activeOriginFilter: originFilter,
      strictForwardTestAudit,
      totalAuditedTrades: auditedList.length,
      openTradesCount: openTrades.length,
      closedTradesCount: closedTrades.length,
      longFutures,
      shortFutures,
      combined,
      analyticalReport,
      rawAuditedTrades: auditedList
    };
  }

  /**
   * Calculates rolling win rate for a given pattern over the last N trades.
   * If the pattern has at least minTradesForRejection (default MIN_TRADES_FOR_PATTERN_STATISTICS = 20) within the last windowSize (default 20) trades
   * and the rolling win rate is below minWinRateThreshold (default 45%), entry is rejected.
   */
  public static evaluatePatternRollingPerformance(
    trades: any[],
    rawPatternName: string,
    windowSize: number = 20,
    minTradesForRejection: number = MIN_TRADES_FOR_PATTERN_STATISTICS,
    minWinRateThreshold: number = 45.0
  ): {
    allowed: boolean;
    pattern: string;
    normalizedPattern: string;
    totalTrades: number;
    winningTrades: number;
    winRate: number;
    reason?: string;
  } {
    const norm = SignalPerformanceAnalyticsService.normalizePattern(rawPatternName);
    if (!rawPatternName || !Array.isArray(trades) || trades.length === 0) {
      return {
        allowed: true,
        pattern: rawPatternName || 'UNKNOWN',
        normalizedPattern: norm,
        totalTrades: 0,
        winningTrades: 0,
        winRate: 100
      };
    }

    const normalizedTarget = norm.toLowerCase();
    const rawTarget = rawPatternName.toLowerCase().trim();

    // Filter valid closed trades sorted descending by close time
    const closed = trades
      .filter(t => t && (t.status === 'CLOSED' || t.status === 'closed' || t.closeTime || t.closedAt))
      .sort((a, b) => (b.closeTime || b.closedAt || 0) - (a.closeTime || a.closedAt || 0));

    // Collect trades matching this pattern up to windowSize
    const patternTrades: any[] = [];
    for (const t of closed) {
      const pRaw = t.triggerPattern || t.pattern || t.decisionTrace?.triggerPattern || t.patternName || t.matchedPattern || '';
      if (!pRaw) continue;
      const pNorm = SignalPerformanceAnalyticsService.normalizePattern(pRaw).toLowerCase();
      const pLower = pRaw.toLowerCase();

      if (pNorm === normalizedTarget || pLower.includes(rawTarget) || rawTarget.includes(pLower)) {
        patternTrades.push(t);
        if (patternTrades.length >= windowSize) break;
      }
    }

    if (patternTrades.length < minTradesForRejection) {
      return {
        allowed: true,
        pattern: rawPatternName,
        normalizedPattern: norm,
        totalTrades: patternTrades.length,
        winningTrades: patternTrades.filter(t => (t.pnl || t.pnlPercent || 0) > 0 || t.outcome === 1 || t.outcome === 'WIN').length,
        winRate: 100
      };
    }

    const winningTrades = patternTrades.filter(t => (t.pnl || t.pnlPercent || 0) > 0 || t.outcome === 1 || t.outcome === 'WIN').length;
    const winRate = Number(((winningTrades / patternTrades.length) * 100).toFixed(1));

    if (winRate < minWinRateThreshold && !isPatternProtected(rawPatternName)) {
      return {
        allowed: false,
        pattern: rawPatternName,
        normalizedPattern: norm,
        totalTrades: patternTrades.length,
        winningTrades,
        winRate,
        reason: `Скользящий винрейт паттерна "${rawPatternName}" за последние ${patternTrades.length} сделок равен ${winRate}% (< ${minWinRateThreshold}% порога)`
      };
    }

    return {
      allowed: true,
      pattern: rawPatternName,
      normalizedPattern: norm,
      totalTrades: patternTrades.length,
      winningTrades,
      winRate
    };
  }
}
