import { evaluateEntryDecision, getApprovedExecutionSide, type EntryDecision, type StrategyMarketInput } from './strategyEngine.ts';
import { type DecisionCorrelationContext } from './agentEngine.ts';
import { type TradeAuditFields } from './tradeSchema.ts';
import { type TradeIntent, type TradeSide, type TradeAction, type MarketType, type TradingMarketMode, type AllowedTradingDirections } from '../types/tradeIntent.ts';
import { type FuturesExecutionPort, type SpotExecutionPort, type ApprovedExecutionIntent } from '../types/executionPorts.ts';

export interface AutoEntryExecutionPort {
  futuresPort?: FuturesExecutionPort;
  spotPort?: SpotExecutionPort;
  executeRealOpenOnExchange?: (
    symbol: string,
    side: 'LONG' | 'SHORT',
    amount: number,
    leverage: number
  ) => Promise<{ success: boolean; entryPrice?: number; orderId?: string; error?: string }>;
  executeRealSpotOpenOnExchange?: (
    symbol: string,
    side: 'LONG',
    amount: number
  ) => Promise<{ success: boolean; entryPrice?: number; orderId?: string; error?: string }>;
  setRealTradeSlTpOnExchange?: (
    symbol: string,
    side: 'LONG' | 'SHORT',
    stopLoss?: number,
    takeProfit?: number
  ) => Promise<boolean>;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  saveBalanceDB: () => Promise<void>;
  logStructured?: (level: string, category: string, message: string, symbol?: string, meta?: any) => void;
  sendTelegramMessage?: (text: string) => Promise<any> | void;
  getAtomicStoreRevision?: () => number;
  reservePaperMargin?: (amount: number, immutableTradeId: string, entryIntentId: string, correlationId: string, trade?: any) => Promise<{ success: boolean; newBalance?: number; error?: string }> | { success: boolean; newBalance?: number; error?: string };
  releasePaperMargin?: (
    amount: number,
    pnl: number,
    immutableTradeId: string,
    closeEventId: string,
    closeRatio?: number,
    isFullClose?: boolean,
    tradeUpdates?: any,
    historyEntry?: any
  ) => Promise<{ success: boolean; newBalance?: number; error?: string }> | { success: boolean; newBalance?: number; error?: string };
  getAvailableVirtualBalance?: () => number;
}

export interface AutoEntryParams {
  symbol: string;
  isReal: boolean;
  marketInput: StrategyMarketInput;
  tradeIntent?: TradeIntent;
  currentSig?: any;
  finalAiScore?: number;
  calculatedAmount: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  tpStages?: any[];
  gridOrders?: any[];
  virtualBalance?: number;
  targetIsAutoLearning?: boolean;
  decisionCorrelationContext?: DecisionCorrelationContext;
  decisionBundle?: any;
  stateRevision?: number;
  activeRealCount?: number;
  maxRealPositions?: number;
  sameDirectionRealCount?: number;
  maxSameDirectionPositions?: number;
  sourcePath?: 'MAIN_VIRTUAL' | 'WORKER_VIRTUAL' | 'MAIN_REAL_STUB' | 'WORKER_REAL_STUB';
}

export interface AutoEntryResult {
  executed: boolean;
  status: 'OPEN' | 'REJECTED' | 'CANCELLED' | 'PENDING_OPEN' | 'OPEN_UNKNOWN';
  side?: 'LONG' | 'SHORT';
  reason?: string;
  verdict?: 'APPROVE' | 'REJECT' | 'HOLD';
  trade?: any;
  decision: EntryDecision;
  correlationContext?: DecisionCorrelationContext;
}

/**
 * Unified Canonical Auto-Entry Execution Pipeline (Shared across Main Thread and Worker)
 * The mandatory gate evaluateEntryDecision + getApprovedExecutionSide is the SOLE entrance to executor.
 */
export async function runCanonicalAutoEntry(
  params: AutoEntryParams,
  port: AutoEntryExecutionPort
): Promise<AutoEntryResult> {
  const { symbol, isReal, marketInput, currentSig, tradeIntent } = params;

  // Pass TradeIntent into strategy context if available
  const strategyCtx: StrategyMarketInput = {
    ...marketInput,
    tradeIntent: tradeIntent || marketInput.tradeIntent
  };

  // 1. Evaluate Canonical Entry Decision
  const decision = evaluateEntryDecision(strategyCtx);

  // 2. Derive Approved Execution Side strictly from the Decision and Invariant Check
  const canonicalSide = getApprovedExecutionSide(decision, tradeIntent);

  if (!decision.approved || decision.action === 'NO_TRADE' || !canonicalSide) {
    return {
      executed: false,
      status: 'REJECTED',
      reason: decision.rejectionReason || decision.reason || 'REJECTED_BY_GATE',
      decision
    };
  }

  // 3. Direction Invariant Guard: If signal provided, must strictly match canonical side
  if (currentSig && currentSig.isSellSignal !== undefined) {
    const sigSide: 'LONG' | 'SHORT' = currentSig.isSellSignal ? 'SHORT' : 'LONG';
    if (sigSide !== canonicalSide) {
      return {
        executed: false,
        status: 'REJECTED',
        reason: `DIRECTION_MISMATCH: signal.side=${sigSide} does not match decision.canonicalSide=${canonicalSide}`,
        decision
      };
    }
  }

  // If tradeIntent provided, verify side invariant
  if (tradeIntent && tradeIntent.side !== canonicalSide) {
    return {
      executed: false,
      status: 'REJECTED',
      reason: `EXECUTION_SIDE_INVARIANT_VIOLATION: tradeIntent.side=${tradeIntent.side} != canonicalSide=${canonicalSide}`,
      decision
    };
  }

  // Consensus and Strategy Checklist Guard
  if (currentSig?.decisionTrace) {
    const dt = currentSig.decisionTrace;
    const requiredScore = typeof dt.requiredScore === 'number' ? dt.requiredScore : 75;
    if (dt.passedConsensus === false || (typeof dt.consensusScore === 'number' && dt.consensusScore < requiredScore)) {
      return {
        executed: false,
        status: 'REJECTED',
        verdict: 'REJECT',
        reason: `CONSENSUS_REJECTED: Consensus score ${dt.consensusScore ?? 'N/A'} < ${requiredScore} or passedConsensus is false`,
        decision
      } as any;
    }

    const liquidityFactor = dt.factors?.find((f: any) => f.name === 'LIQUIDITY_SWEEP');
    if (liquidityFactor && liquidityFactor.passed === false) {
      return {
        executed: false,
        status: 'REJECTED',
        verdict: 'REJECT',
        reason: 'LIQUIDITY_SWEEP_UNCONFIRMED: Liquidity sweep check failed',
        decision
      } as any;
    }

    const wickFactor = dt.factors?.find((f: any) => f.name && f.name.includes('WICK_REJECTION'));
    if (wickFactor && wickFactor.passed === false) {
      return {
        executed: false,
        status: 'REJECTED',
        verdict: 'REJECT',
        reason: 'WICK_REJECTION_UNCONFIRMED: Candlestick wick rejection check failed',
        decision
      } as any;
    }
  }

  // 4. Materialize and establish full DecisionCorrelationContext at runtime
  const currentRevision = params.stateRevision ?? (port.getAtomicStoreRevision ? port.getAtomicStoreRevision() : 1);
  const correlationId = params.decisionCorrelationContext?.correlationId ||
    tradeIntent?.correlationId ||
    decision.correlationContext?.correlationId ||
    `corr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const proposedTradeId = params.decisionCorrelationContext?.proposedTradeId ||
    (isReal ? `RT-AUTO-${Date.now()}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}` : `TR-${Date.now()}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`);

  const entryIntentId = params.decisionCorrelationContext?.entryIntentId ||
    tradeIntent?.intentId ||
    `intent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const correlationContext: DecisionCorrelationContext = {
    correlationId,
    proposedTradeId,
    entryIntentId,
    signalId: decision.signalId || tradeIntent?.signalId || currentSig?.id || `sig_${Date.now()}`,
    strategyId: decision.strategyId || 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: decision.strategyVersion || '2.1.0',
    stateRevision: currentRevision,
    emittedAt: Date.now()
  };

  const agentDecisionIds = [
    decision.hunterEnvelope?.decisionId,
    decision.bearEnvelope?.decisionId,
    decision.committeeEnvelope?.decisionId
  ].filter(Boolean) as string[];

  const resolvedMarketType: MarketType = tradeIntent?.marketType || (marketInput.marketType === 'SPOT' ? 'SPOT' : 'FUTURES');
  const requestedMode: TradingMarketMode = tradeIntent?.requestedMode || (marketInput.tradingMode === 'SPOT' ? 'SPOT' : marketInput.tradingMode === 'FUTURES' ? 'FUTURES' : 'HYBRID');
  const allowedDirections: AllowedTradingDirections = tradeIntent?.allowedDirections || (marketInput.allowedTradingDirections || marketInput.allowedDirections || 'BOTH');
  const sourcePath = params.sourcePath || (isReal ? 'MAIN_REAL_STUB' : 'MAIN_VIRTUAL');

  // 5. Execution according to Mode (REAL vs PAPER)
  if (isReal) {
    // REAL TRADING LIFECYCLE: PENDING_OPEN -> OPEN | OPEN_UNKNOWN | CANCELLED
    const now = Date.now();

    if (params.decisionBundle) {
      params.decisionBundle.lifecycleStatus = 'PENDING_OPEN';
      params.decisionBundle.entryIntentId = entryIntentId;
      params.decisionBundle.reconciliationMetadata = {
        attemptCount: 1,
        intentTimestamp: now,
        source: 'COMMITTEE'
      };
      params.decisionBundle.events = params.decisionBundle.events || [];
      params.decisionBundle.events.push({
        time: now,
        event: 'LIFECYCLE_INTENT: PENDING_OPEN',
        details: { tradeId: proposedTradeId, symbol, amount: params.calculatedAmount, entryIntentId }
      });
    }

    const pendingTrade: any = {
      id: proposedTradeId,
      symbol,
      side: canonicalSide,
      action: canonicalSide === 'LONG' ? 'BUY' : 'SELL',
      amount: params.calculatedAmount,
      initialAmount: params.calculatedAmount,
      leverage: resolvedMarketType === 'SPOT' ? 1 : params.leverage,
      status: 'PENDING_OPEN',
      mode: 'AUTO',
      isReal: true,
      dataOrigin: 'LIVE',
      decisionSource: 'COMMITTEE',
      intentTimestamp: now,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      tpStages: params.tpStages,
      gridOrders: params.gridOrders,
      correlationId,
      correlationContext,
      entryIntentId,
      intentId: entryIntentId,
      tradeIntentId: entryIntentId,
      signalId: correlationContext.signalId,
      strategyId: correlationContext.strategyId,
      strategyVersion: correlationContext.strategyVersion,
      matchedRuleIds: decision.matchedRuleIds || currentSig?.matchedRuleIds || [],
      committeeDecisionId: decision.committeeEnvelope?.decisionId,
      agentDecisionIds,
      stateRevision: currentRevision,
      lineageStatus: 'COMPLIANT',
      decisionBundle: params.decisionBundle,
      reconciliationMetadata: { attemptCount: 1, intentTimestamp: now, source: 'COMMITTEE' },
      history: [{ time: now, type: 'PENDING_OPEN', price: marketInput.price, amount: params.calculatedAmount }],
      // Audit and lineage attributes
      marketType: resolvedMarketType,
      resolvedMarketType,
      requestedMode,
      allowedDirections,
      scannerSide: tradeIntent?.side || (currentSig?.isSellSignal ? 'SHORT' : 'LONG'),
      strategySide: decision.strategySide || decision.side,
      committeeSide: decision.committeeSide || (decision.approved ? decision.side : 'NEUTRAL'),
      executionSide: canonicalSide,
      gateDiagnostics: decision.gateDiagnostics,
      sourcePath
    };

    // Durable pre-order intent persistence: MUST await before exchange call
    await port.saveTradeDB(pendingTrade, true);

    // SPOT Real Trading Adapter Check
    if (resolvedMarketType === 'SPOT') {
      if (!port.spotPort && !port.executeRealSpotOpenOnExchange) {
        pendingTrade.status = 'CANCELLED';
        pendingTrade.closeReason = 'SPOT_REAL_EXECUTION_NOT_CONFIGURED';
        if (params.decisionBundle) {
          params.decisionBundle.lifecycleStatus = 'CANCELLED';
          params.decisionBundle.tradeResult = {
            tradeId: proposedTradeId,
            status: 'CANCELLED',
            reason: 'SPOT_REAL_EXECUTION_NOT_CONFIGURED'
          };
          params.decisionBundle.events = params.decisionBundle.events || [];
          params.decisionBundle.events.push({
            time: Date.now(),
            event: 'LIFECYCLE_COMMITTED: CANCELLED',
            details: { tradeId: proposedTradeId, reason: 'SPOT_REAL_EXECUTION_NOT_CONFIGURED' }
          });
        }
        await port.saveTradeDB(pendingTrade, true);
        return {
          executed: false,
          status: 'CANCELLED',
          reason: 'SPOT_REAL_EXECUTION_NOT_CONFIGURED',
          trade: pendingTrade,
          decision,
          correlationContext
        };
      }
    } else {
      // FUTURES Real Trading Check
      if (!port.futuresPort && !port.executeRealOpenOnExchange) {
        pendingTrade.status = 'CANCELLED';
        pendingTrade.closeReason = 'NO_EXECUTION_PORT';
        if (params.decisionBundle) {
          params.decisionBundle.lifecycleStatus = 'CANCELLED';
          params.decisionBundle.tradeResult = {
            tradeId: proposedTradeId,
            status: 'CANCELLED',
            reason: 'NO_EXECUTION_PORT'
          };
          params.decisionBundle.events = params.decisionBundle.events || [];
          params.decisionBundle.events.push({
            time: Date.now(),
            event: 'LIFECYCLE_COMMITTED: CANCELLED',
            details: { tradeId: proposedTradeId, reason: 'NO_EXECUTION_PORT' }
          });
        }
        await port.saveTradeDB(pendingTrade, true);
        return {
          executed: false,
          status: 'CANCELLED',
          reason: 'NO_EXECUTION_PORT',
          trade: pendingTrade,
          decision,
          correlationContext
        };
      }
    }

    try {
      let resOpen: { success: boolean; entryPrice?: number; orderId?: string; error?: string };

      if (resolvedMarketType === 'SPOT') {
        const approvedExecIntent: ApprovedExecutionIntent = {
          intent: tradeIntent || {
            intentId: entryIntentId,
            correlationId,
            signalId: correlationContext.signalId,
            symbol,
            side: 'LONG',
            action: 'BUY',
            marketType: 'SPOT',
            requestedMode,
            allowedDirections,
            strategyId: correlationContext.strategyId,
            strategyVersion: correlationContext.strategyVersion,
            source: 'SCANNER',
            createdAt: now,
            marketSnapshot: {
              price: marketInput.price,
              high: marketInput.high || marketInput.price,
              low: marketInput.low || marketInput.price,
              open: marketInput.open || marketInput.price,
              vwap: marketInput.vwap || marketInput.price,
              sar: marketInput.sar || marketInput.price,
              rsi: marketInput.rsi || 50,
              change24h: marketInput.change24h || 0,
              volume24h: marketInput.volume24h || 0,
              avgVolume: marketInput.avgVolume || 100000
            }
          },
          decision,
          calculatedAmount: params.calculatedAmount,
          leverage: 1,
          stopLoss: params.stopLoss,
          takeProfit: params.takeProfit,
          tpStages: params.tpStages,
          gridOrders: params.gridOrders,
          isReal: true
        };

        if (port.spotPort) {
          resOpen = await port.spotPort.openSpotBuy(approvedExecIntent);
        } else {
          resOpen = await port.executeRealSpotOpenOnExchange!(symbol, 'LONG', params.calculatedAmount);
        }
      } else {
        if (port.futuresPort) {
          const approvedExecIntent: ApprovedExecutionIntent = {
            intent: tradeIntent || {
              intentId: entryIntentId,
              correlationId,
              signalId: correlationContext.signalId,
              symbol,
              side: canonicalSide,
              action: canonicalSide === 'LONG' ? 'BUY' : 'SELL',
              marketType: 'FUTURES',
              requestedMode,
              allowedDirections,
              strategyId: correlationContext.strategyId,
              strategyVersion: correlationContext.strategyVersion,
              source: 'SCANNER',
              createdAt: now,
              marketSnapshot: {
                price: marketInput.price,
                high: marketInput.high || marketInput.price,
                low: marketInput.low || marketInput.price,
                open: marketInput.open || marketInput.price,
                vwap: marketInput.vwap || marketInput.price,
                sar: marketInput.sar || marketInput.price,
                rsi: marketInput.rsi || 50,
                change24h: marketInput.change24h || 0,
                volume24h: marketInput.volume24h || 0,
                avgVolume: marketInput.avgVolume || 100000
              }
            },
            decision,
            calculatedAmount: params.calculatedAmount,
            leverage: params.leverage,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            tpStages: params.tpStages,
            gridOrders: params.gridOrders,
            isReal: true
          };
          resOpen = await port.futuresPort.openFutures(approvedExecIntent);
        } else {
          resOpen = await port.executeRealOpenOnExchange!(symbol, canonicalSide, params.calculatedAmount, params.leverage);
        }
      }

      if (resOpen && resOpen.success && resOpen.entryPrice) {
        const fillPrice = resOpen.entryPrice;
        const fillTime = Date.now();
        pendingTrade.status = 'OPEN';
        pendingTrade.entryPrice = fillPrice;
        pendingTrade.openTime = fillTime;
        pendingTrade.exchangeOrderId = resOpen.orderId;
        pendingTrade.history.push({ time: fillTime, type: 'OPEN', price: fillPrice, amount: params.calculatedAmount });

        if (params.decisionBundle) {
          params.decisionBundle.lifecycleStatus = 'OPEN';
          params.decisionBundle.finalTradeId = proposedTradeId;
          params.decisionBundle.tradeResult = {
            tradeId: proposedTradeId,
            status: 'OPEN',
            entryPrice: fillPrice,
            side: canonicalSide,
            orderId: resOpen.orderId
          };
          params.decisionBundle.events = params.decisionBundle.events || [];
          params.decisionBundle.events.push({
            time: fillTime,
            event: 'LIFECYCLE_COMMITTED: OPEN',
            details: { tradeId: proposedTradeId, entryPrice: fillPrice, orderId: resOpen.orderId }
          });
        }

        // Await durable persistence after fill
        await port.saveTradeDB(pendingTrade, true);

        if (port.logStructured) {
          port.logStructured(
            'success',
            'AUTOPILOT',
            `Opened REAL Autopilot ${canonicalSide} Position for ${symbol}. Amount: $${params.calculatedAmount} USDT, Leverage: ${params.leverage}x, Entry: $${fillPrice}`,
            symbol,
            { tradeId: proposedTradeId, correlationId, side: canonicalSide, amount: params.calculatedAmount, entryPrice: fillPrice }
          );
        }

        if (port.setRealTradeSlTpOnExchange && (params.stopLoss || params.takeProfit) && resolvedMarketType === 'FUTURES') {
          try {
            const slTpOk = await port.setRealTradeSlTpOnExchange(symbol, canonicalSide, params.stopLoss, params.takeProfit);
            pendingTrade.slTpStatus = slTpOk ? 'SET' : 'FAILED_RETRY_NEEDED';
          } catch (err: any) {
            console.log(`[REAL AUTOPILOT SL/TP ERR] Failed to set exchange SL/TP for ${symbol}:`, err?.message || err);
            pendingTrade.slTpStatus = 'FAILED_RETRY_NEEDED';
            pendingTrade.slTpError = err?.message || String(err);
          }
          await port.saveTradeDB(pendingTrade, true);
        }

        return {
          executed: true,
          status: 'OPEN',
          side: canonicalSide,
          trade: pendingTrade,
          decision,
          correlationContext
        };
      } else {
        const errMsg = resOpen?.error || 'Exchange order rejected';
        const cancelTime = Date.now();
        pendingTrade.status = 'CANCELLED';
        pendingTrade.closeReason = errMsg;

        if (params.decisionBundle) {
          params.decisionBundle.lifecycleStatus = 'CANCELLED';
          params.decisionBundle.finalTradeId = proposedTradeId;
          params.decisionBundle.tradeResult = {
            tradeId: proposedTradeId,
            status: 'CANCELLED',
            reason: errMsg
          };
          params.decisionBundle.events = params.decisionBundle.events || [];
          params.decisionBundle.events.push({
            time: cancelTime,
            event: 'LIFECYCLE_COMMITTED: CANCELLED',
            details: { tradeId: proposedTradeId, reason: errMsg }
          });
        }

        await port.saveTradeDB(pendingTrade, true);

        return {
          executed: false,
          status: 'CANCELLED',
          reason: errMsg,
          trade: pendingTrade,
          decision,
          correlationContext
        };
      }
    } catch (err: any) {
      // Unknown outcome (e.g. network timeout / socket hang up during live order creation)
      const errTime = Date.now();
      const reasonMsg = `NETWORK_EXCEPTION: ${err?.message || err}`;
      pendingTrade.status = 'OPEN_UNKNOWN';
      pendingTrade.needsReconciliation = true;
      pendingTrade.closeReason = reasonMsg;

      if (params.decisionBundle) {
        params.decisionBundle.lifecycleStatus = 'OPEN_UNKNOWN';
        params.decisionBundle.finalTradeId = proposedTradeId;
        params.decisionBundle.reconciliationMetadata = {
          attemptCount: 1,
          intentTimestamp: now,
          source: 'COMMITTEE',
          needsReconciliation: true,
          error: reasonMsg
        };
        params.decisionBundle.tradeResult = {
          tradeId: proposedTradeId,
          status: 'OPEN_UNKNOWN',
          needsReconciliation: true,
          reason: reasonMsg
        };
        params.decisionBundle.events = params.decisionBundle.events || [];
        params.decisionBundle.events.push({
          time: errTime,
          event: 'LIFECYCLE_COMMITTED: OPEN_UNKNOWN',
          details: { tradeId: proposedTradeId, error: reasonMsg }
        });
      }

      await port.saveTradeDB(pendingTrade, true);

      return {
        executed: false,
        status: 'OPEN_UNKNOWN',
        reason: reasonMsg,
        trade: pendingTrade,
        decision,
        correlationContext
      };
    }
  } else {
    // VIRTUAL / PAPER TRADING LIFECYCLE
    const effectiveLeverage = resolvedMarketType === 'SPOT' ? 1 : Math.max(1, Number(params.leverage || 1));
    const requiredMargin = (params as any).margin !== undefined ? Number((params as any).margin) : Number(params.calculatedAmount.toFixed(2));

    if (!params.targetIsAutoLearning) {
      const currentVirtualBalance = port.getAvailableVirtualBalance ? port.getAvailableVirtualBalance() : params.virtualBalance;
      if (currentVirtualBalance !== undefined && currentVirtualBalance < requiredMargin) {
        return {
          executed: false,
          status: 'REJECTED',
          reason: `INSUFFICIENT_VIRTUAL_BALANCE: Available ${currentVirtualBalance.toFixed(2)} < required margin ${requiredMargin.toFixed(2)}`,
          decision,
          correlationContext
        };
      }
    }

    const newAutoTrade: any = {
      id: proposedTradeId,
      symbol,
      side: canonicalSide,
      action: canonicalSide === 'LONG' ? 'BUY' : 'SELL',
      entryPrice: marketInput.price,
      amount: params.calculatedAmount,
      initialAmount: params.calculatedAmount,
      margin: requiredMargin,
      initialMargin: requiredMargin,
      leverage: effectiveLeverage,
      status: 'OPEN',
      openTime: Date.now(),
      mode: 'AUTO',
      isReal: false,
      isPaper: true,
      dataOrigin: 'PAPER',
      decisionSource: 'COMMITTEE',
      marketRegime: currentSig?.marketRegime || 'NEUTRAL',
      decisionTrace: currentSig?.decisionTrace || undefined,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      tpStages: params.tpStages,
      gridOrders: params.gridOrders,
      correlationId,
      correlationContext,
      entryIntentId,
      intentId: entryIntentId,
      tradeIntentId: entryIntentId,
      signalId: correlationContext.signalId,
      strategyId: correlationContext.strategyId,
      strategyVersion: correlationContext.strategyVersion,
      matchedRuleIds: decision.matchedRuleIds || currentSig?.matchedRuleIds || [],
      committeeDecisionId: decision.committeeEnvelope?.decisionId,
      agentDecisionIds,
      stateRevision: currentRevision,
      lineageStatus: 'COMPLIANT',
      history: [{ time: Date.now(), type: 'OPEN', price: marketInput.price, amount: params.calculatedAmount }],
      // Audit and lineage attributes
      marketType: resolvedMarketType,
      resolvedMarketType,
      requestedMode,
      allowedDirections,
      scannerSide: tradeIntent?.side || (currentSig?.isSellSignal ? 'SHORT' : 'LONG'),
      strategySide: decision.strategySide || decision.side,
      committeeSide: decision.committeeSide || (decision.approved ? decision.side : 'NEUTRAL'),
      executionSide: canonicalSide,
      gateDiagnostics: decision.gateDiagnostics,
      sourcePath
    };

    if (params.targetIsAutoLearning) {
      newAutoTrade.isAutoLearning = true;
    }

    let marginReserved = false;
    if (!params.targetIsAutoLearning && port.reservePaperMargin) {
      const reserveRes = await port.reservePaperMargin(requiredMargin, proposedTradeId, entryIntentId, correlationId, newAutoTrade);
      if (!reserveRes.success) {
        return {
          executed: false,
          status: 'REJECTED',
          reason: reserveRes.error || 'FAILED_TO_RESERVE_VIRTUAL_MARGIN',
          decision,
          correlationContext
        };
      }
      marginReserved = true;
    }

    // Await durable persistence for paper trades with rollback safety
    try {
      await port.saveTradeDB(newAutoTrade, true);

      if (!params.targetIsAutoLearning) {
        await port.saveBalanceDB();
      }
    } catch (saveErr) {
      if (marginReserved && port.releasePaperMargin) {
        try {
          const rollbackCloseEventId = `rollback_${entryIntentId}`;
          await port.releasePaperMargin(requiredMargin, 0, proposedTradeId, rollbackCloseEventId);
        } catch {
          // ignore rollback errors on release
        }
      }
      throw saveErr;
    }

    if (port.logStructured) {
      port.logStructured(
        'info',
        'AUTOPILOT',
        `Opened VIRTUAL Autopilot ${canonicalSide} Position for ${symbol}. Amount: ${params.calculatedAmount} USDT, Leverage: ${params.leverage}x, Entry: ${marketInput.price}`,
        symbol,
        { tradeId: proposedTradeId, correlationId, side: canonicalSide, amount: params.calculatedAmount, entryPrice: marketInput.price }
      );
    }

    return {
      executed: true,
      status: 'OPEN',
      side: canonicalSide,
      trade: newAutoTrade,
      decision,
      correlationContext
    };
  }
}

