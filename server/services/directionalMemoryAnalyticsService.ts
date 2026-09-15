import { isOperationalTrade } from './tradeMetrics.ts';
import type { MarketRegime } from '../types/trading.ts';

export interface DirectionalPerformanceStats {
  side: 'LONG' | 'SHORT' | 'COMBINED';
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  averageProfitUsd: number;
  averageLossUsd: number;
  profitFactor: number;
  expectancyUsd: number;
  maxDrawdownPercent: number;
  sharpeRatioEstimate: number;
  averageHoldDurationMs: number;
  regimePerformance: Record<MarketRegime, {
    trades: number;
    winRate: number;
    pnlUsd: number;
  }>;
}

export interface AgentPerformanceStats {
  agentId: string;
  agentName: string;
  role: string;
  totalVotes: number;
  correctVotes: number;
  accuracy: number;
  winRateImpact: number;
  assignedWeight: number;
  dynamicWeight: number;
  profitContributionUsd: number;
  lastUpdated: number;
}

export interface SplitMemoryReport {
  longFutures: DirectionalPerformanceStats;
  shortFutures: DirectionalPerformanceStats;
  combined: DirectionalPerformanceStats;
  agentStats: Record<string, AgentPerformanceStats>;
  marketRegimeStats: Record<MarketRegime, {
    longWinRate: number;
    shortWinRate: number;
    totalTrades: number;
    netPnlUsd: number;
  }>;
  calculatedAt: number;
}

/**
 * Сервис раздельного аудита и анализа памяти для LONG и SHORT фьючерсов
 * Полностью изолирует статистику LONG от SHORT для предотвращения смешивания стратегий.
 */
export class DirectionalMemoryAnalyticsService {
  /**
   * Вычисление метрик для конкретного среза сделок (LONG, SHORT или ВСЕ)
   */
  public static calculateDirectionalStats(trades: any[], targetSide?: 'LONG' | 'SHORT'): DirectionalPerformanceStats {
    // Включаем как операционные сделки, так и валидные исторические сделки обучения
    const operational = trades.filter(t => {
      if (isOperationalTrade(t, { includePaper: true, includeLegacyUnknown: true })) return true;
      if (t && (t.isAutoLearning || t.pnl !== undefined || t.pnlPercent !== undefined) && !t.isForcedReset) return true;
      return false;
    });
    const filtered = targetSide ? operational.filter(t => t.side === targetSide) : operational;

    const closed = filtered.filter(t => t.status === 'CLOSED' || t.closedAt || t.pnl !== undefined);
    const openTrades = filtered.filter(t => t.status === 'OPEN').length;

    const regimes: MarketRegime[] = ['TREND_UP', 'TREND_DOWN', 'RANGING_FLAT', 'HIGH_VOLATILITY', 'EXTREME_SQUEEZE', 'NEUTRAL'];
    const regimePerformance: Record<MarketRegime, { trades: number; winRate: number; pnlUsd: number }> = {} as any;
    for (const r of regimes) {
      regimePerformance[r] = { trades: 0, winRate: 0, pnlUsd: 0 };
    }

    if (closed.length === 0) {
      return {
        side: targetSide || 'COMBINED',
        totalTrades: filtered.length,
        openTrades,
        closedTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnlUsd: 0,
        totalPnlPercent: 0,
        averageProfitUsd: 0,
        averageLossUsd: 0,
        profitFactor: 0,
        expectancyUsd: 0,
        maxDrawdownPercent: 0,
        sharpeRatioEstimate: 0,
        averageHoldDurationMs: 0,
        regimePerformance
      };
    }

    let wins = 0;
    let losses = 0;
    let totalPnlUsd = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalHoldTime = 0;
    let pnlPercentSum = 0;
    const pnlList: number[] = [];

    for (const t of closed) {
      const pnl = Number(t.pnl || t.realizedPnl || 0);
      const pnlPct = Number(t.pnlPercent || 0);
      totalPnlUsd += pnl;
      pnlPercentSum += pnlPct;
      pnlList.push(pnl);

      if (t.openTime && t.closeTime) {
        totalHoldTime += (t.closeTime - t.openTime);
      }

      if (pnl > 0) {
        wins++;
        grossProfit += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLoss += Math.abs(pnl);
      }

      // По режимам рынка
      const reg: MarketRegime = t.marketRegime || 'NEUTRAL';
      if (!regimePerformance[reg]) {
        regimePerformance[reg] = { trades: 0, winRate: 0, pnlUsd: 0 };
      }
      regimePerformance[reg].trades++;
      regimePerformance[reg].pnlUsd += pnl;
    }

    for (const r of regimes) {
      const regTrades = closed.filter(t => (t.marketRegime || 'NEUTRAL') === r);
      const regWins = regTrades.filter(t => Number(t.pnl || 0) > 0).length;
      regimePerformance[r].winRate = regTrades.length > 0 ? (regWins / regTrades.length) * 100 : 0;
    }

    const totalDecided = wins + losses;
    const winRate = totalDecided > 0 ? (wins / totalDecided) * 100 : 0;
    const averageProfitUsd = wins > 0 ? grossProfit / wins : 0;
    const averageLossUsd = losses > 0 ? grossLoss / losses : 0;
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99.9 : 0);
    const winProb = totalDecided > 0 ? wins / totalDecided : 0;
    const lossProb = totalDecided > 0 ? losses / totalDecided : 0;
    const expectancyUsd = Number(((winProb * averageProfitUsd) - (lossProb * averageLossUsd)).toFixed(2));

    // Расчет Max Drawdown
    let peak = 0;
    let maxDd = 0;
    let runningPnl = 0;
    for (const pnl of pnlList) {
      runningPnl += pnl;
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDd) maxDd = dd;
    }

    // Sharpe Ratio Estimate
    let variance = 0;
    const avgPnl = closed.length > 0 ? totalPnlUsd / closed.length : 0;
    for (const pnl of pnlList) {
      variance += Math.pow(pnl - avgPnl, 2);
    }
    const stdDev = closed.length > 1 ? Math.sqrt(variance / (closed.length - 1)) : 1;
    const sharpeRatioEstimate = stdDev > 0 ? Number(((avgPnl / stdDev) * Math.sqrt(365)).toFixed(2)) : 0;

    return {
      side: targetSide || 'COMBINED',
      totalTrades: filtered.length,
      openTrades,
      closedTrades: closed.length,
      winningTrades: wins,
      losingTrades: losses,
      winRate: Number(winRate.toFixed(2)),
      totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
      totalPnlPercent: Number(pnlPercentSum.toFixed(2)),
      averageProfitUsd: Number(averageProfitUsd.toFixed(2)),
      averageLossUsd: Number(averageLossUsd.toFixed(2)),
      profitFactor,
      expectancyUsd,
      maxDrawdownPercent: Number(maxDd.toFixed(2)),
      sharpeRatioEstimate,
      averageHoldDurationMs: closed.length > 0 ? Math.round(totalHoldTime / closed.length) : 0,
      regimePerformance
    };
  }

  /**
   * Сбор полной раздельной аналитики памяти (LONG vs SHORT) и скоринга агентов
   */
  public static generateSplitMemoryReport(trades: any[]): SplitMemoryReport {
    const longFutures = this.calculateDirectionalStats(trades, 'LONG');
    const shortFutures = this.calculateDirectionalStats(trades, 'SHORT');
    const combined = this.calculateDirectionalStats(trades);

    // Сбор статистики по агентам на основе decisionTrace в закрытых сделках
    const closedOperational = trades.filter(t => {
      const isOp = isOperationalTrade(t, { includePaper: true, includeLegacyUnknown: true }) || (t && (t.isAutoLearning || t.pnl !== undefined) && !t.isForcedReset);
      return isOp && (t.status === 'CLOSED' || t.pnl !== undefined);
    });
    
    const agentMap: Record<string, {
      name: string;
      role: string;
      total: number;
      correct: number;
      pnlSum: number;
      baseWeight: number;
    }> = {
      scout_agent: { name: 'ИИ-Сканер (Scout)', role: 'SCOUT', total: 0, correct: 0, pnlSum: 0, baseWeight: 1.0 },
      bull_analyst: { name: 'Бычий Аналитик (Bull Analyst)', role: 'BULL_ANALYST', total: 0, correct: 0, pnlSum: 0, baseWeight: 1.0 },
      bear_analyst: { name: 'Медвежий Аналитик (Bear Analyst)', role: 'BEAR_ANALYST', total: 0, correct: 0, pnlSum: 0, baseWeight: 1.0 },
      liquidity_hunter: { name: 'Охотник за Ликвидностью (Liquidity Hunter)', role: 'LIQUIDITY_HUNTER', total: 0, correct: 0, pnlSum: 0, baseWeight: 1.1 },
      risk_sentinel: { name: 'Риск-Страж (Risk Sentinel)', role: 'RISK_SENTINEL', total: 0, correct: 0, pnlSum: 0, baseWeight: 1.3 }
    };

    for (const t of closedOperational) {
      const pnl = Number(t.pnl || 0);
      const isWin = pnl > 0;
      const trace = t.decisionTrace;
      if (trace && Array.isArray(trace.agentVotes)) {
        for (const v of trace.agentVotes) {
          const key = v.agentId || 'scout_agent';
          if (agentMap[key]) {
            agentMap[key].total++;
            const approvedCorrectly = (isWin && (v.vote === 'APPROVE_LONG' || v.vote === 'APPROVE_SHORT'));
            const rejectedCorrectly = (!isWin && v.vote === 'REJECT');
            if (approvedCorrectly || rejectedCorrectly) {
              agentMap[key].correct++;
            }
            if (isWin) {
              agentMap[key].pnlSum += pnl;
            } else {
              agentMap[key].pnlSum += pnl;
            }
          }
        }
      }
    }

    const agentStats: Record<string, AgentPerformanceStats> = {};
    for (const [key, val] of Object.entries(agentMap)) {
      const accuracy = val.total >= 3 ? (val.correct / val.total) * 100 : 75.0;
      // Динамический пересчет веса на основе точности: от 0.5x до 2.0x
      const accuracyFactor = accuracy / 70.0;
      const dynamicWeight = Number(Math.max(0.5, Math.min(2.0, val.baseWeight * accuracyFactor)).toFixed(2));

      agentStats[key] = {
        agentId: key,
        agentName: val.name,
        role: val.role,
        totalVotes: val.total,
        correctVotes: val.correct,
        accuracy: Number(accuracy.toFixed(1)),
        winRateImpact: Number(((accuracy - 50) * 0.4).toFixed(1)),
        assignedWeight: val.baseWeight,
        dynamicWeight,
        profitContributionUsd: Number(val.pnlSum.toFixed(2)),
        lastUpdated: Date.now()
      };
    }

    // Режимная статистика
    const regimes: MarketRegime[] = ['TREND_UP', 'TREND_DOWN', 'RANGING_FLAT', 'HIGH_VOLATILITY', 'EXTREME_SQUEEZE', 'NEUTRAL'];
    const marketRegimeStats: Record<MarketRegime, { longWinRate: number; shortWinRate: number; totalTrades: number; netPnlUsd: number }> = {} as any;
    for (const r of regimes) {
      const regTrades = closedOperational.filter(t => (t.marketRegime || 'NEUTRAL') === r);
      const longTrades = regTrades.filter(t => t.side === 'LONG');
      const shortTrades = regTrades.filter(t => t.side === 'SHORT');
      const longWins = longTrades.filter(t => Number(t.pnl || 0) > 0).length;
      const shortWins = shortTrades.filter(t => Number(t.pnl || 0) > 0).length;
      const netPnl = regTrades.reduce((acc, t) => acc + Number(t.pnl || 0), 0);

      marketRegimeStats[r] = {
        longWinRate: longTrades.length > 0 ? Number(((longWins / longTrades.length) * 100).toFixed(1)) : 0,
        shortWinRate: shortTrades.length > 0 ? Number(((shortWins / shortTrades.length) * 100).toFixed(1)) : 0,
        totalTrades: regTrades.length,
        netPnlUsd: Number(netPnl.toFixed(2))
      };
    }

    return {
      longFutures,
      shortFutures,
      combined,
      agentStats,
      marketRegimeStats,
      calculatedAt: Date.now()
    };
  }
}
