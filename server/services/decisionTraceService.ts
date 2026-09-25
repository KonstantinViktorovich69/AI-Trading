import type { DecisionTrace, DecisionFactor, AgentVoteTrace, MarketRegime } from '../types/trading.ts';

export interface DecisionTraceBuildParams {
  symbol: string;
  side: 'LONG' | 'SHORT';
  marketRegime: MarketRegime;
  regimeConfidence?: number;
  patternName?: string;
  executionMode?: 'REAL' | 'PAPER' | 'BACKTEST';
  indicators?: {
    rsi?: number;
    volumeSpike?: number;
    topWickPct?: number;
    bottomWickPct?: number;
    vwapDistancePct?: number;
    atr?: number;
    orderBookImbalance?: number;
    sarReversal?: boolean;
    bosChoch?: boolean;
    liquiditySweep?: boolean;
  };
  agentWeights?: Record<string, number>;
  rawAgentScores?: {
    scout?: { score: number; reason: string; vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD' };
    bull?: { score: number; reason: string; vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD' };
    bear?: { score: number; reason: string; vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD' };
    risk?: { score: number; reason: string; vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD' };
    liquidity?: { score: number; reason: string; vote: 'APPROVE_LONG' | 'APPROVE_SHORT' | 'REJECT' | 'HOLD' };
  };
  requiredScore?: number;
  blockLocks?: string[];
  blockDetails?: string[];
  metadata?: Record<string, any>;
}

/**
 * Множитель штрафа за явный голос против направления сделки (не HOLD).
 * Явное несогласие агента должно ощутимо перевешивать простое отсутствие поддержки,
 * а не просто занулять вклад при полном весе в знаменателе.
 */
export const DISSENT_PENALTY_MULTIPLIER = 1.5;

/**
 * Сервис генерации и аудита трейсов решений (Decision Tracing Engine)
 * Формирует подробный журнал всех факторов, голосов агентов и весов перед входом в сделку.
 */
export class DecisionTraceService {
  /**
   * Сборка детального DecisionTrace для сигнала или ордера
   */
  public static buildTrace(params: DecisionTraceBuildParams): DecisionTrace {
    const traceId = `dt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const factors: DecisionFactor[] = [];
    const ind = params.indicators || {};

    // 1. Технические факторы (RSI, SAR, VWAP)
    if (ind.rsi !== undefined) {
      const isRsiOverbought = ind.rsi > 70;
      const isRsiOversold = ind.rsi < 30;
      factors.push({
        name: 'RSI_15M',
        category: 'TECHNICAL',
        value: ind.rsi,
        weight: 15,
        direction: isRsiOverbought ? 'SHORT' : (isRsiOversold ? 'LONG' : 'NEUTRAL'),
        passed: params.side === 'SHORT' ? ind.rsi >= 60 : ind.rsi <= 40,
        notes: `RSI на уровне ${ind.rsi.toFixed(1)} (${isRsiOverbought ? 'Перекупленность' : isRsiOversold ? 'Перепроданность' : 'Нейтральный'})`
      });
    }

    if (ind.sarReversal !== undefined) {
      factors.push({
        name: 'SAR_REVERSAL_TRIGGER',
        category: 'TECHNICAL',
        value: ind.sarReversal ? 1 : 0,
        weight: 20,
        direction: params.side,
        passed: !!ind.sarReversal,
        notes: ind.sarReversal ? 'Parabolic SAR переключился в сторону входа' : 'SAR не подтверждает разворот'
      });
    }

    if (ind.vwapDistancePct !== undefined) {
      factors.push({
        name: 'VWAP_DEVIATION',
        category: 'TECHNICAL',
        value: `${ind.vwapDistancePct.toFixed(2)}%`,
        weight: 12,
        direction: ind.vwapDistancePct > 0 ? 'SHORT' : 'LONG',
        passed: Math.abs(ind.vwapDistancePct) >= 0.8,
        notes: `Отклонение от VWAP: ${ind.vwapDistancePct > 0 ? '+' : ''}${ind.vwapDistancePct.toFixed(2)}%`
      });
    }

    // 2. Объем и стакан
    if (ind.volumeSpike !== undefined) {
      factors.push({
        name: 'VOLUME_CLIMAX_SPIKE',
        category: 'VOLUME',
        value: `${ind.volumeSpike.toFixed(1)}x`,
        weight: 18,
        direction: params.side,
        passed: ind.volumeSpike >= 1.5,
        notes: `Аномальный всплеск объема торгов: ${ind.volumeSpike.toFixed(1)}x от среднего`
      });
    }

    if (ind.orderBookImbalance !== undefined) {
      const isShortFavored = ind.orderBookImbalance > 55;
      const isLongFavored = ind.orderBookImbalance < 45;
      factors.push({
        name: 'ORDERBOOK_IMBALANCE',
        category: 'ORDERBOOK',
        value: `${ind.orderBookImbalance.toFixed(1)}%`,
        weight: 10,
        direction: isShortFavored ? 'SHORT' : (isLongFavored ? 'LONG' : 'NEUTRAL'),
        passed: params.side === 'SHORT' ? isShortFavored : isLongFavored,
        notes: `Дисбаланс стакана: ${ind.orderBookImbalance.toFixed(1)}%`
      });
    }

    // 3. Структура рынка (Wick, Liquidity Sweep, BOS/ChoCh)
    if (ind.topWickPct !== undefined || ind.bottomWickPct !== undefined) {
      const wick = params.side === 'SHORT' ? (ind.topWickPct || 0) : (ind.bottomWickPct || 0);
      const isWickSignificant = wick >= 0.20;
      const isReversalConfirmed = !!(ind.sarReversal || ind.bosChoch || ind.liquiditySweep);
      const passed = isWickSignificant || (isReversalConfirmed && wick >= 0.03);
      factors.push({
        name: params.side === 'SHORT' ? 'TOP_WICK_REJECTION' : 'BOTTOM_WICK_REJECTION',
        category: 'STRUCTURE',
        value: `${(wick * 100).toFixed(1)}%`,
        weight: 15,
        direction: params.side,
        passed,
        notes: isWickSignificant
          ? `Размер разворотного фитиля: ${(wick * 100).toFixed(1)}% (отказ от продолжения движения)`
          : (isReversalConfirmed ? `Разворот подтвержден структурой/SAR при локальном фитиле ${(wick * 100).toFixed(1)}%` : `Недостаточный фитиль ${(wick * 100).toFixed(1)}%`)
      });
    }

    if (ind.liquiditySweep !== undefined) {
      factors.push({
        name: 'LIQUIDITY_SWEEP',
        category: 'STRUCTURE',
        value: ind.liquiditySweep ? 'CONFIRMED' : 'NONE',
        weight: 15,
        direction: params.side,
        passed: !!ind.liquiditySweep,
        notes: ind.liquiditySweep ? 'Зафиксировано снятие ликвидности за локальным экстремумом' : 'Снятие ликвидности не подтверждено'
      });
    }

    if (ind.bosChoch !== undefined) {
      factors.push({
        name: 'MARKET_STRUCTURE_SHIFT_BOS_CHOCH',
        category: 'STRUCTURE',
        value: ind.bosChoch ? 'CONFIRMED' : 'NONE',
        weight: 15,
        direction: params.side,
        passed: !!ind.bosChoch,
        notes: ind.bosChoch ? 'Локальный слом структуры (BOS/ChoCh) подтвержден' : 'Структура не сломана'
      });
    }

    // 4. Голоса агентов с весами
    const agentVotes: AgentVoteTrace[] = [];
    const rawScores = params.rawAgentScores || {};
    const weights = params.agentWeights || {
      scout: 1.0,
      bull: 1.0,
      bear: 1.0,
      risk: 1.2,
      liquidity: 1.0
    };

    // Scout
    if (rawScores.scout) {
      const w = weights.scout || 1.0;
      agentVotes.push({
        agentId: 'scout_agent',
        agentName: 'ИИ-Сканер (Scout Agent)',
        role: 'SCOUT',
        vote: rawScores.scout.vote,
        confidence: rawScores.scout.score,
        assignedWeight: w,
        weightedScore: Number((rawScores.scout.score * w).toFixed(1)),
        reason: rawScores.scout.reason,
        timestamp: Date.now()
      });
    }

    // Bull Analyst
    if (rawScores.bull) {
      const w = weights.bull || 1.0;
      agentVotes.push({
        agentId: 'bull_analyst',
        agentName: 'Бычий Аналитик (Bull Analyst)',
        role: 'BULL_ANALYST',
        vote: rawScores.bull.vote,
        confidence: rawScores.bull.score,
        assignedWeight: w,
        weightedScore: Number((rawScores.bull.score * w).toFixed(1)),
        reason: rawScores.bull.reason,
        timestamp: Date.now()
      });
    }

    // Bear Analyst
    if (rawScores.bear) {
      const w = weights.bear || 1.0;
      agentVotes.push({
        agentId: 'bear_analyst',
        agentName: 'Медвежий Аналитик (Bear Analyst)',
        role: 'BEAR_ANALYST',
        vote: rawScores.bear.vote,
        confidence: rawScores.bear.score,
        assignedWeight: w,
        weightedScore: Number((rawScores.bear.score * w).toFixed(1)),
        reason: rawScores.bear.reason,
        timestamp: Date.now()
      });
    }

    // Liquidity Hunter
    if (rawScores.liquidity) {
      const w = weights.liquidity || 1.0;
      agentVotes.push({
        agentId: 'liquidity_hunter',
        agentName: 'Охотник за Ликвидностью (Liquidity Hunter)',
        role: 'LIQUIDITY_HUNTER',
        vote: rawScores.liquidity.vote,
        confidence: rawScores.liquidity.score,
        assignedWeight: w,
        weightedScore: Number((rawScores.liquidity.score * w).toFixed(1)),
        reason: rawScores.liquidity.reason,
        timestamp: Date.now()
      });
    }

    // Risk Sentinel
    if (rawScores.risk) {
      const w = weights.risk || 1.2;
      agentVotes.push({
        agentId: 'risk_sentinel',
        agentName: 'Риск-Страж (Risk Sentinel)',
        role: 'RISK_SENTINEL',
        vote: rawScores.risk.vote,
        confidence: rawScores.risk.score,
        assignedWeight: w,
        weightedScore: Number((rawScores.risk.score * w).toFixed(1)),
        reason: rawScores.risk.reason,
        timestamp: Date.now()
      });
    }

    // Расчет итогового консенсус-скора
    let totalWeight = 0;
    let weightedSum = 0;
    let dissentPenalty = 0;
    for (const v of agentVotes) {
      if (v.vote === (params.side === 'SHORT' ? 'APPROVE_SHORT' : 'APPROVE_LONG')) {
        weightedSum += v.confidence * v.assignedWeight;
      } else if (v.vote === 'HOLD') {
        weightedSum += (v.confidence * 0.5) * v.assignedWeight;
      } else {
        weightedSum += 0;
        dissentPenalty += v.confidence * v.assignedWeight * DISSENT_PENALTY_MULTIPLIER;
      }
      totalWeight += v.assignedWeight;
    }

    const rawScore = totalWeight > 0 ? (weightedSum - dissentPenalty) / totalWeight : 50;
    const consensusScore = Math.max(0, Math.round(rawScore));
    const requiredScore = params.requiredScore || 75;
    const hasRejections = (params.blockLocks && params.blockLocks.length > 0);
    const passedConsensus = !hasRejections && (consensusScore >= requiredScore);

    return {
      id: traceId,
      timestamp: Date.now(),
      symbol: params.symbol,
      side: params.side,
      marketRegime: params.marketRegime,
      regimeConfidence: params.regimeConfidence || 0.85,
      factors,
      agentVotes,
      consensusScore,
      requiredScore,
      passedConsensus,
      rejectionReasons: params.blockLocks || [],
      executionMode: params.executionMode || 'PAPER',
      triggerPattern: params.patternName,
      metadata: params.metadata || {}
    };
  }
}
