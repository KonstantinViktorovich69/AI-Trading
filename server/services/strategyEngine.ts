import { isOperationalTrade } from './tradeMetrics.ts';
import { analyzeShortScalpPatterns, analyzeLongScalpPatterns, analyzeSpotAccumulationPatterns, isPatternBlacklisted } from './signalEngine.ts';
import { evaluateCommitteeConsensus } from './agentEngine.ts';
import type { AgentDecisionEnvelope, DecisionCorrelationContext } from './agentEngine.ts';
import type { TradeIntent, TradeSide, AllowedTradingDirections } from '../types/tradeIntent.ts';

export interface EntryDecision {
  approved: boolean;
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  strategyId: string;
  strategyVersion: string;
  signalId: string;
  correlationId: string;
  correlationContext?: DecisionCorrelationContext;
  rejectionReason?: string;
  reason: string;
  matchedRuleIds: string[];
  scoreBonus: number;
  spotDcaLadder?: any[];
  gateDiagnostics: Record<string, boolean>;
  hunterEnvelope: AgentDecisionEnvelope;
  bearEnvelope: AgentDecisionEnvelope;
  committeeEnvelope: AgentDecisionEnvelope;
  tradeIntent?: TradeIntent;
  scannerSide?: TradeSide;
  strategySide?: 'LONG' | 'SHORT' | 'NEUTRAL';
  committeeSide?: 'LONG' | 'SHORT' | 'NEUTRAL';
  executionSide?: 'LONG' | 'SHORT';
}

export interface StrategyContext {
  symbol: string;
  marketType?: 'SPOT' | 'FUTURES';
  tradingMode?: 'SPOT' | 'FUTURES' | 'COMBINED' | 'HYBRID';
  price: number;
  high?: number;
  low?: number;
  open?: number;
  vwap?: number;
  sar?: number;
  rsi?: number;
  change24h?: number;
  volume24h?: number;
  avgVolume?: number;
  bidSpreadPct?: number;
  orderBookImbalance?: number; // -1 to +1
  fundingRate?: number;
  htfTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  isAggressiveMode?: boolean;
  isCommitteeConsensusEnabled?: boolean;
  minConfidenceBySide?: { LONG: number; SHORT: number };
  isSymmetricConfidenceFilterEnabled?: boolean;
  allowedTradingDirections?: AllowedTradingDirections;
  allowedDirections?: AllowedTradingDirections;
  activeStrategy?: string;
  action?: 'BUY' | 'SELL' | 'NO_TRADE';
  side?: 'LONG' | 'SHORT' | 'NEUTRAL';
  hunterScore?: number;
  bearScore?: number;
  committeeScore?: number;
  isCommitteeApproved?: boolean;
  tradeIntent?: TradeIntent;
}

export type StrategyMarketInput = StrategyContext;

export interface SignalDecision {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  strategyId: string;
  strategyVersion: string;
  signalId: string;
  matchedRuleIds: string[];
  reason: string;
  dataCompleteness: 'COMPLETE' | 'INCOMPLETE';
  rejectionReason?: string;
  scoreBonus: number;
  spotDcaLadder?: any[];
  gateDiagnostics: Record<string, boolean>;
  tradeIntent?: TradeIntent;
}

export const CANONICAL_STRATEGY_ID = 'CANONICAL_QUANT_SCALP_V2';
export const CANONICAL_STRATEGY_VERSION = '2.1.0';

/**
 * Validates data completeness. Returns false if prices/volumes are zero, NaN, or invalid.
 */
export function validateMarketDataCompleteness(ctx: StrategyContext): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  if (!ctx.symbol || typeof ctx.symbol !== 'string') return false;

  if (isNaN(ctx.price) || ctx.price <= 0) return false;
  if (isNaN(ctx.high) || ctx.high <= 0) return false;
  if (isNaN(ctx.low) || ctx.low <= 0) return false;
  if (isNaN(ctx.open) || ctx.open <= 0) return false;
  if (isNaN(ctx.vwap) || ctx.vwap <= 0) return false;
  if (isNaN(ctx.sar) || ctx.sar <= 0) return false;
  if (ctx.rsi !== undefined && (isNaN(ctx.rsi) || ctx.rsi < 0 || ctx.rsi > 100)) return false;
  if (isNaN(ctx.volume24h) || ctx.volume24h < 0) return false;

  return true;
}

/**
 * Evaluates strategy entry signal with symmetric risk gates and fail-closed architecture.
 */
export function evaluateStrategySignal(ctx: StrategyContext): SignalDecision {
  const signalId = ctx.tradeIntent?.signalId || `sig_${ctx.symbol.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const gateDiagnostics: Record<string, boolean> = {};

  // Gate 1: Fail Closed on Data Incompleteness
  const isDataValid = validateMarketDataCompleteness(ctx);
  gateDiagnostics.dataCompleteness = isDataValid;

  if (!isDataValid) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: 'Данные рынка неполные или некорректны (Fail Closed)',
      dataCompleteness: 'INCOMPLETE',
      rejectionReason: 'DATA_INCOMPLETE',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Gate 2: Spread Safety (Hard Gate: max spread 0.8% in normal, 1.2% in aggressive)
  const maxSpreadAllowed = ctx.isAggressiveMode ? 0.012 : 0.008;
  const spreadPct = ctx.bidSpreadPct || 0.001;
  const isSpreadOk = spreadPct <= maxSpreadAllowed;
  gateDiagnostics.spreadSafety = isSpreadOk;
  gateDiagnostics.spreadGate = isSpreadOk;

  if (!isSpreadOk) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Спред стакана слишком высок (${(spreadPct * 100).toFixed(2)}% > ${(maxSpreadAllowed * 100).toFixed(2)}%)`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'HIGH_SPREAD',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Gate 3: Liquidity Safety (Hard Gate: min volume $50,000 unless extreme move >15%)
  const isLiquidityOk = ctx.volume24h >= 50000 || Math.abs(ctx.change24h) >= 15;
  gateDiagnostics.liquiditySafety = isLiquidityOk;
  gateDiagnostics.volumeGate = isLiquidityOk;

  if (!isLiquidityOk) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Объем 24ч меньше лимита ликвидности ($${ctx.volume24h.toLocaleString()} < $50,000)`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'LOW_LIQUIDITY',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Gate 4: Funding Safety (Hard Gate for Futures: funding rate <= 0.15% per period)
  const maxFundingAllowed = 0.0015;
  const isFundingOk = ctx.marketType !== 'SPOT' ? (!ctx.fundingRate || Math.abs(ctx.fundingRate) <= maxFundingAllowed) : true;
  gateDiagnostics.fundingSafety = isFundingOk;
  gateDiagnostics.fundingGate = isFundingOk;

  if (!isFundingOk) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Ставка фандинга слишком аномальна (${((ctx.fundingRate || 0) * 100).toFixed(3)}%)`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'EXTREME_FUNDING',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Intent side contract
  const intentSide: TradeSide | undefined = ctx.tradeIntent?.side ||
    ((ctx.action === 'BUY' || ctx.side === 'LONG')
      ? 'LONG'
      : (ctx.action === 'SELL' || ctx.side === 'SHORT')
        ? 'SHORT'
        : undefined);

  // Evaluate Core Technical Pattern Setup
  let patternResult: any;

  if (ctx.marketType === 'SPOT') {
    patternResult = analyzeSpotAccumulationPatterns(
      ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
      ctx.rsi || 50, ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000
    );
  } else {
    // If intent is explicitly SHORT, focus on SHORT patterns
    if (intentSide === 'SHORT') {
      patternResult = analyzeShortScalpPatterns(
        ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
        ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000
      );
      if (!patternResult || patternResult.signalType === 'NEUTRAL') {
        if (ctx.sar > ctx.price || ctx.price < ctx.vwap) {
          patternResult = {
            patternName: 'Futures Short Trend / Resistance Rejection',
            signalType: 'SHORT',
            scoreBonus: 25,
            reason: 'Медвежий тренд ниже VWAP с подтверждением SAR'
          };
        }
      }
    } else if (intentSide === 'LONG') {
      // If intent is explicitly LONG, evaluate strict futures LONG patterns
      const longFuturesPattern = analyzeLongScalpPatterns(
        ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
        ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000, ctx.rsi
      );
      if (longFuturesPattern && longFuturesPattern.signalType === 'LONG') {
        patternResult = {
          ...longFuturesPattern,
          patternName: `Futures Long (${longFuturesPattern.patternName})`
        };
      } else {
        const longSpotPattern = analyzeSpotAccumulationPatterns(
          ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
          ctx.rsi || 50, ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000
        );
        if (longSpotPattern && longSpotPattern.signalType === 'LONG') {
          patternResult = {
            ...longSpotPattern,
            patternName: `Futures Long (${longSpotPattern.patternName})`
          };
        } else if (ctx.sar < ctx.price && ctx.price >= ctx.vwap) {
          patternResult = {
            patternName: 'Futures Long Trend / Support Bounce',
            signalType: 'LONG',
            scoreBonus: 25,
            reason: 'Бычий тренд выше VWAP с подтверждением SAR'
          };
        }
      }
    } else {
      // Bi-directional evaluation when no explicit intent provided
      patternResult = analyzeShortScalpPatterns(
        ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
        ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000, ctx.rsi
      );

      if (!patternResult || patternResult.signalType === 'NEUTRAL') {
        const longFuturesPattern = analyzeLongScalpPatterns(
          ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
          ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000, ctx.rsi
        );
        if (longFuturesPattern && longFuturesPattern.signalType === 'LONG') {
          patternResult = {
            ...longFuturesPattern,
            patternName: `Futures Long (${longFuturesPattern.patternName})`
          };
        } else {
          const longSpotPattern = analyzeSpotAccumulationPatterns(
            ctx.price, ctx.high, ctx.low, ctx.open, ctx.vwap, ctx.sar,
            ctx.rsi || 50, ctx.change24h || 0, ctx.volume24h, ctx.avgVolume || 100000
          );
          if (longSpotPattern && longSpotPattern.signalType === 'LONG') {
            patternResult = {
              ...longSpotPattern,
              patternName: `Futures Long (${longSpotPattern.patternName})`
            };
          } else if (ctx.sar < ctx.price && ctx.price >= ctx.vwap) {
            patternResult = {
              patternName: 'Futures Long Trend / Support Bounce',
              signalType: 'LONG',
              scoreBonus: 25,
              reason: 'Бычий тренд выше VWAP с подтверждением SAR'
            };
          } else if (ctx.sar > ctx.price && ctx.price <= ctx.vwap) {
            patternResult = {
              patternName: 'Futures Short Trend / Resistance Rejection',
              signalType: 'SHORT',
              scoreBonus: 25,
              reason: 'Медвежий тренд ниже VWAP с подтверждением SAR'
            };
          }
        }
      }
    }
  }

  if (intentSide && (!patternResult || patternResult.signalType === 'NEUTRAL')) {
    patternResult = {
      patternName: `Explicit ${intentSide} Strategy Signal`,
      signalType: intentSide,
      scoreBonus: 25,
      reason: `Исполнение валидированного сигнала ${intentSide}`
    };
  }

  if (!patternResult || patternResult.signalType === 'NEUTRAL') {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: patternResult?.reason || 'Паттерн не обнаружен',
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'NO_PATTERN',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  const rawSide: 'LONG' | 'SHORT' = patternResult.signalType;

  // Invariant Gate: Strategy side MUST match TradeIntent side if intent exists
  if (intentSide && rawSide !== intentSide) {
    gateDiagnostics.sideInvariantMatch = false;
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Несоответствие стороны: intent.side=${intentSide} vs strategy.side=${rawSide}`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'SIDE_MISMATCH_BETWEEN_INTENT_AND_STRATEGY',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }
  gateDiagnostics.sideInvariantMatch = true;

  // Gate 4.5: Allowed Trading Directions Gate
  const allowedDir = ctx.tradeIntent?.allowedDirections || ctx.allowedDirections || ctx.allowedTradingDirections || 'BOTH';
  const isDirectionAllowed = allowedDir === 'BOTH' || (allowedDir === 'LONG_ONLY' && rawSide === 'LONG') || (allowedDir === 'SHORT_ONLY' && rawSide === 'SHORT');
  gateDiagnostics.directionAllowed = isDirectionAllowed;

  if (!isDirectionAllowed) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Направление ${rawSide} заблокировано фильтром разрешенных направлений (${allowedDir})`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'DIRECTION_NOT_ALLOWED',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Gate 5: Pattern Blacklist Gate
  const effectivePatternName = (ctx.tradeIntent as any)?.triggerPattern || (ctx as any)?.currentSig?.matchedPattern || patternResult.patternName;
  const blacklistCheck = isPatternBlacklisted(effectivePatternName).blacklisted
    ? isPatternBlacklisted(effectivePatternName)
    : isPatternBlacklisted(patternResult.patternName);
  gateDiagnostics.patternNotBlacklisted = !blacklistCheck.blacklisted;

  if (blacklistCheck.blacklisted) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Паттерн "${effectivePatternName}" заблокирован: ${blacklistCheck.reason}`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'PATTERN_BLACKLISTED',
      scoreBonus: 0,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  // Calculate Base Confidence Score (50 to 95)
  let confidence = 50 + patternResult.scoreBonus;

  // Additional technical confirmations
  if (rawSide === 'SHORT') {
    if (ctx.sar > ctx.price) confidence += 10;
    if (ctx.price < ctx.vwap) confidence += 10;
    if (ctx.orderBookImbalance !== undefined && ctx.orderBookImbalance < -0.2) confidence += 5;
    if (ctx.htfTrend === 'BEARISH') confidence += 10;
  } else if (rawSide === 'LONG') {
    if (ctx.sar < ctx.price) confidence += 10;
    if (ctx.price > ctx.vwap) confidence += 10;
    if (ctx.orderBookImbalance !== undefined && ctx.orderBookImbalance > 0.2) confidence += 5;
    if (ctx.htfTrend === 'BULLISH') confidence += 10;
  }

  // Cap confidence to [0, 99]
  confidence = Math.max(10, Math.min(99, confidence));

  // Gate 6: Symmetric Confidence Threshold Filter
  const isSymmetric = ctx.isSymmetricConfidenceFilterEnabled !== false;
  if (!isSymmetric) {
    console.log('[STRATEGY ENGINE] ASYMMETRIC_CONFIDENCE_POLICY_ACTIVE');
  }

  const minConfSettings = ctx.minConfidenceBySide || { LONG: 65, SHORT: 65 };
  let requiredMinConf = isSymmetric
    ? Math.max(minConfSettings.LONG, minConfSettings.SHORT)
    : (rawSide === 'LONG' ? minConfSettings.LONG : minConfSettings.SHORT);

  // In aggressive mode, allow soft confidence requirement relaxation by up to 5 points (min floor 55)
  if (ctx.isAggressiveMode) {
    requiredMinConf = Math.max(55, requiredMinConf - 5);
  }

  const isConfidenceOk = confidence >= requiredMinConf;
  gateDiagnostics.confidenceGate = isConfidenceOk;

  if (!isConfidenceOk) {
    return {
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence,
      strategyId: CANONICAL_STRATEGY_ID,
      strategyVersion: CANONICAL_STRATEGY_VERSION,
      signalId,
      matchedRuleIds: [],
      reason: `Уровень уверенности ${confidence}% ниже минимума (${requiredMinConf}%) для стороны ${rawSide}`,
      dataCompleteness: 'COMPLETE',
      rejectionReason: 'CONFIDENCE_TOO_LOW',
      scoreBonus: patternResult.scoreBonus,
      gateDiagnostics,
      tradeIntent: ctx.tradeIntent
    };
  }

  const matchedRules = ['RULE_SAR_M1_M15', 'RULE_VWAP_ALIGNMENT'];
  if (patternResult.patternName) matchedRules.push(`PAT_${patternResult.patternName.replace(/\s+/g, '_').toUpperCase()}`);

  return {
    action: rawSide === 'LONG' ? 'BUY' : 'SELL',
    side: rawSide,
    confidence,
    strategyId: CANONICAL_STRATEGY_ID,
    strategyVersion: CANONICAL_STRATEGY_VERSION,
    signalId,
    matchedRuleIds: matchedRules,
    reason: patternResult.reason,
    dataCompleteness: 'COMPLETE',
    scoreBonus: patternResult.scoreBonus,
    spotDcaLadder: patternResult.spotDcaLadder,
    gateDiagnostics,
    tradeIntent: ctx.tradeIntent
  };
}

/**
 * Unified Canonical Entry Governance Function
 * Evaluates strategy signal, generates Hunter & Bear decision envelopes,
 * and runs committee consensus to return a unified fail-closed EntryDecision.
 */
export function evaluateEntryDecision(
  ctx: StrategyContext,
  customEnvelopes?: { hunter?: AgentDecisionEnvelope; bear?: AgentDecisionEnvelope }
): EntryDecision {
  const correlationId = ctx.tradeIntent?.correlationId || `corr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const signalDecision = evaluateStrategySignal(ctx);

  const hunterEnvelope: AgentDecisionEnvelope = customEnvelopes?.hunter || {
    decisionId: `dec_hunter_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'HUNTER',
    signalId: signalDecision.signalId,
    strategyId: signalDecision.strategyId,
    strategyVersion: signalDecision.strategyVersion,
    action: signalDecision.action === 'NO_TRADE' ? 'NO_TRADE' : 'APPROVE',
    confidence: signalDecision.confidence,
    approved: signalDecision.action !== 'NO_TRADE',
    decisionSource: 'RULE_ENGINE',
    rationale: signalDecision.reason,
    createdAt: Date.now()
  };

  const isBearReject = signalDecision.action === 'NO_TRADE' ||
    signalDecision.gateDiagnostics.spreadSafety === false ||
    signalDecision.gateDiagnostics.liquiditySafety === false ||
    signalDecision.gateDiagnostics.fundingSafety === false ||
    signalDecision.gateDiagnostics.patternNotBlacklisted === false ||
    signalDecision.gateDiagnostics.sideInvariantMatch === false ||
    signalDecision.gateDiagnostics.directionAllowed === false;

  const bearEnvelope: AgentDecisionEnvelope = customEnvelopes?.bear || {
    decisionId: `dec_bear_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'BEAR',
    signalId: signalDecision.signalId,
    strategyId: signalDecision.strategyId,
    strategyVersion: signalDecision.strategyVersion,
    action: (signalDecision.action === 'NO_TRADE' || isBearReject) ? 'REJECT' : 'APPROVE',
    confidence: isBearReject ? 85 : 80,
    approved: signalDecision.action !== 'NO_TRADE' && !isBearReject,
    decisionSource: 'RULE_ENGINE',
    rationale: isBearReject ? `Риск-фильтр отклонил сигнал: ${signalDecision.reason}` : 'Параметры риска в норме',
    createdAt: Date.now()
  };

  const isCommitteeEnabled = ctx.isCommitteeConsensusEnabled !== false;
  const committeeEnvelope = evaluateCommitteeConsensus(hunterEnvelope, bearEnvelope, isCommitteeEnabled);

  const isApproved = signalDecision.action !== 'NO_TRADE' && committeeEnvelope.approved;

  const resolvedSide = isApproved ? signalDecision.side : 'NEUTRAL';
  const executionSide = (resolvedSide === 'LONG' || resolvedSide === 'SHORT') ? resolvedSide : undefined;

  return {
    approved: isApproved,
    action: isApproved ? signalDecision.action : 'NO_TRADE',
    side: resolvedSide,
    confidence: committeeEnvelope.confidence,
    strategyId: signalDecision.strategyId,
    strategyVersion: signalDecision.strategyVersion,
    signalId: signalDecision.signalId,
    correlationId,
    rejectionReason: !isApproved ? (signalDecision.rejectionReason || 'COMMITTEE_VETO') : undefined,
    reason: isApproved ? signalDecision.reason : (committeeEnvelope.rationale || signalDecision.reason),
    matchedRuleIds: signalDecision.matchedRuleIds,
    scoreBonus: signalDecision.scoreBonus,
    spotDcaLadder: signalDecision.spotDcaLadder,
    gateDiagnostics: signalDecision.gateDiagnostics,
    hunterEnvelope,
    bearEnvelope,
    committeeEnvelope,
    tradeIntent: ctx.tradeIntent,
    scannerSide: ctx.tradeIntent?.side || (ctx.side === 'LONG' || ctx.side === 'SHORT' ? ctx.side : undefined),
    strategySide: signalDecision.side,
    committeeSide: committeeEnvelope.approved ? (signalDecision.side) : 'NEUTRAL',
    executionSide
  };
}

export type CanonicalMarketInput = StrategyMarketInput;
export type ExecutionSide = 'LONG' | 'SHORT';

export function getApprovedExecutionSide(decision: EntryDecision, intent?: TradeIntent): ExecutionSide | null {
  if (!decision.approved || decision.action === 'NO_TRADE') return null;
  
  const approvedSide = decision.side;
  if (approvedSide !== 'LONG' && approvedSide !== 'SHORT') return null;

  // Invariant: Decision side MUST strictly match TradeIntent side if intent provided
  if (intent && intent.side !== approvedSide) {
    console.error(`[EXECUTION_INVARIANT_VIOLATION] Decision side (${approvedSide}) does not match Intent side (${intent.side})`);
    return null;
  }

  if (decision.action === 'BUY' && approvedSide === 'LONG') return 'LONG';
  if (decision.action === 'SELL' && approvedSide === 'SHORT') return 'SHORT';
  return null;
}


