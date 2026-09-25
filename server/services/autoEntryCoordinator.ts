import { evaluateEntryDecision, getApprovedExecutionSide, type EntryDecision, type StrategyMarketInput } from './strategyEngine.ts';
import { type DecisionCorrelationContext, type AgentDecisionEnvelope, evaluateCommitteeConsensus, createAiFallbackDecision } from './agentEngine.ts';
import { runCanonicalAutoEntry, type AutoEntryExecutionPort, type AutoEntryParams, type AutoEntryResult } from './autoEntryService.ts';
import { AtomicStateStore, dbAtomicStore, type DurableCommitResult } from '../atomicDbSaver.ts';
import { executePaperTradeOpenTransaction, executePaperTradeCloseTransaction } from './paperTradeTransaction.ts';
import { type TradeIntent } from '../types/tradeIntent.ts';

export interface DecisionBundle {
  correlationId: string;
  signalId?: string;
  proposedTradeId?: string;
  finalTradeId?: string;
  strategyId?: string;
  strategyVersion?: string;
  stateRevision?: number;
  timestamp: number;
  symbol?: string;
  marketSnapshot?: any;
  strategyDecision?: any;
  agentEnvelopes?: AgentDecisionEnvelope[];
  consensusResult?: any;
  executionResult?: any;
  verdict?: 'APPROVE' | 'REJECT' | 'VETO' | 'NO_TRADE';
  reason?: string;
  hunterEnvelope?: AgentDecisionEnvelope;
  bearEnvelope?: AgentDecisionEnvelope;
  committeeEnvelope?: AgentDecisionEnvelope;
  events?: Array<{ time: number; event: string; details?: any }>;
  tradeIntent?: any;
  tradeResult?: any;
  requestedMode?: string;
  resolvedMarketType?: string;
  scannerSide?: string;
  strategySide?: string;
  committeeSide?: string;
  executionSide?: string;
  gateDiagnostics?: Record<string, boolean>;
  lifecycleStatus?: string;
  reconciliationMetadata?: any;
  entryIntentId?: string;
}

export interface CoordinatorOptions {
  store?: AtomicStateStore;
  executionPort?: AutoEntryExecutionPort;
  hunterDecision?: AgentDecisionEnvelope;
  bearDecision?: AgentDecisionEnvelope;
  isCommitteeConsensusEnabled?: boolean;
}

export interface CoordinatorRunParams {
  symbol: string;
  isReal: boolean;
  marketInput: StrategyMarketInput;
  tradeIntent?: TradeIntent;
  calculatedAmount: number;
  leverage: number;
  currentSig?: any;
  finalAiScore?: number;
  stopLoss?: number;
  takeProfit?: number;
  tpStages?: any[];
  gridOrders?: any[];
  virtualBalance?: number;
  targetIsAutoLearning?: boolean;
  customCorrelationContext?: Partial<DecisionCorrelationContext>;
  sourcePath?: 'MAIN_VIRTUAL' | 'WORKER_VIRTUAL' | 'MAIN_REAL_STUB' | 'WORKER_REAL_STUB';
}

export interface CoordinatorRunResult {
  executed: boolean;
  status: 'OPEN' | 'REJECTED' | 'CANCELLED' | 'PENDING_OPEN' | 'OPEN_UNKNOWN';
  side?: 'LONG' | 'SHORT';
  reason?: string;
  trade?: any;
  decisionBundle: DecisionBundle;
  correlationContext: DecisionCorrelationContext;
}

/**
 * Persists a complete decision correlation bundle atomically to store.
 */
export async function persistDecisionBundle(
  store: AtomicStateStore,
  bundle: DecisionBundle
): Promise<DurableCommitResult> {
  return await store.saveState((state: any) => {
    if (!state) state = {};
    if (!Array.isArray(state.decisionBundles)) state.decisionBundles = [];
    
    // Compact events and strip unbounded bloat
    const compactBundle: DecisionBundle = {
      ...bundle,
      events: Array.isArray(bundle.events) ? bundle.events.slice(-10) : bundle.events
    };

    const existingIdx = state.decisionBundles.findIndex((b: any) => b.correlationId === bundle.correlationId);
    if (existingIdx !== -1) {
      state.decisionBundles[existingIdx] = compactBundle;
    } else {
      state.decisionBundles.push(compactBundle);
      // Retain most recent 100 decision bundles to prevent database.json bloat
      if (state.decisionBundles.length > 100) {
        state.decisionBundles = state.decisionBundles.slice(-100);
      }
    }
    return state;
  });
}

/**
 * Production Automatic Entry Coordinator.
 * Shared by main thread, background worker, and authentic production-path tests.
 */
export async function runProductionAutoEntryCoordinator(
  params: CoordinatorRunParams,
  options: CoordinatorOptions = {}
): Promise<CoordinatorRunResult> {
  const store = options.store || dbAtomicStore;
  const currentRevision = store.getRevision();
  const timestamp = Date.now();

  const proposedTradeId = params.customCorrelationContext?.proposedTradeId ||
    (params.isReal
      ? `RT-AUTO-${timestamp}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`
      : `TR-${timestamp}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`);

  const signalId = params.customCorrelationContext?.signalId ||
    params.tradeIntent?.signalId ||
    params.currentSig?.id ||
    `sig_${timestamp}_${Math.random().toString(36).substring(2, 7)}`;

  const correlationId = params.customCorrelationContext?.correlationId ||
    params.tradeIntent?.correlationId ||
    `corr_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

  const entryIntentId = params.customCorrelationContext?.entryIntentId ||
    params.tradeIntent?.intentId ||
    `intent_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

  // 1. Establish Immutable DecisionCorrelationContext before any decisions
  const correlationContext: DecisionCorrelationContext = {
    correlationId,
    signalId,
    proposedTradeId,
    entryIntentId,
    strategyId: params.customCorrelationContext?.strategyId || params.tradeIntent?.strategyId || 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: params.customCorrelationContext?.strategyVersion || params.tradeIntent?.strategyVersion || '2.1.0',
    stateRevision: currentRevision,
    emittedAt: timestamp,
    timestamp
  };

  // 2. Evaluate Strategy Decision
  const strategyContext: StrategyMarketInput = {
    ...params.marketInput,
    tradeIntent: params.tradeIntent || params.marketInput.tradeIntent
  };

  const strategyDecision = evaluateEntryDecision(strategyContext, {
    hunter: options.hunterDecision,
    bear: options.bearDecision
  });

  // 3. Obtain Hunter & Bear Decision Envelopes
  const hunterEnvelope: AgentDecisionEnvelope = options.hunterDecision || {
    decisionId: `hunter_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'HUNTER',
    signalId,
    proposedTradeId,
    correlationId,
    stateRevision: currentRevision,
    strategyId: correlationContext.strategyId,
    strategyVersion: correlationContext.strategyVersion,
    action: strategyDecision.approved ? 'APPROVE' : 'NO_TRADE',
    confidence: params.finalAiScore || (strategyDecision.approved ? 85 : 40),
    approved: strategyDecision.approved,
    decisionSource: 'FALLBACK_RULE',
    rationale: strategyDecision.reason || 'FALLBACK_UNAVAILABLE_AGENT: Quantitative rule matching',
    createdAt: timestamp
  };

  const bearEnvelope: AgentDecisionEnvelope = options.bearDecision || {
    decisionId: `bear_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'BEAR',
    signalId,
    proposedTradeId,
    correlationId,
    stateRevision: currentRevision,
    strategyId: correlationContext.strategyId,
    strategyVersion: correlationContext.strategyVersion,
    action: 'APPROVE',
    confidence: 80,
    approved: true,
    decisionSource: 'FALLBACK_RULE',
    rationale: 'FALLBACK_UNAVAILABLE_AGENT: Risk parameters within normal operational thresholds',
    createdAt: timestamp
  };

  // 4. Evaluate Committee Consensus
  const isCommitteeEnabled = options.isCommitteeConsensusEnabled !== false;
  const committeeEnvelope = evaluateCommitteeConsensus(hunterEnvelope, bearEnvelope, isCommitteeEnabled);

  // 5. Build Base Decision Bundle
  let verdict: 'APPROVE' | 'REJECT' | 'VETO' | 'NO_TRADE' = 'APPROVE';
  let rejectReason: string | undefined = undefined;

  if (!strategyDecision.approved) {
    verdict = 'REJECT';
    rejectReason = strategyDecision.reason || 'REJECTED_BY_STRATEGY';
  } else if (!committeeEnvelope.approved) {
    verdict = bearEnvelope.action === 'REJECT' ? 'VETO' : 'REJECT';
    rejectReason = committeeEnvelope.rationale || 'VETOED_BY_COMMITTEE';
  } else if (params.currentSig?.decisionTrace) {
    const dt = params.currentSig.decisionTrace;
    const requiredScore = typeof dt.requiredScore === 'number' ? dt.requiredScore : 75;
    if (isCommitteeEnabled && (dt.passedConsensus === false || (typeof dt.consensusScore === 'number' && dt.consensusScore < requiredScore))) {
      verdict = 'REJECT';
      rejectReason = `CONSENSUS_REJECTED: Consensus score ${dt.consensusScore ?? 'N/A'} < ${requiredScore} or passedConsensus is false`;
    } else {
      const liquidityFactor = dt.factors?.find((f: any) => f.name === 'LIQUIDITY_SWEEP');
      if (liquidityFactor && liquidityFactor.passed === false) {
        verdict = 'REJECT';
        rejectReason = 'LIQUIDITY_SWEEP_UNCONFIRMED: Liquidity sweep check failed';
      } else {
        const sigType = (params.currentSig?.type || (params.currentSig as any)?.sctoPattern || (params.currentSig as any)?.pattern || '').toUpperCase();
        const isStrictWickPattern = sigType.includes('SPIRE') || sigType.includes('WICK') || sigType.includes('PINBAR') || sigType.includes('ШПИЛЬ') || sigType.includes('ФИТИЛ');
        const wickFactor = dt.factors?.find((f: any) => f.name && f.name.includes('WICK_REJECTION'));
        if (isStrictWickPattern && wickFactor && wickFactor.passed === false) {
          verdict = 'REJECT';
          rejectReason = 'WICK_REJECTION_UNCONFIRMED: Candlestick wick rejection check failed';
        }
      }
    }
  }

  const decisionBundle: DecisionBundle = {
    correlationId,
    signalId,
    proposedTradeId,
    strategyId: correlationContext.strategyId,
    strategyVersion: correlationContext.strategyVersion,
    stateRevision: currentRevision,
    timestamp,
    verdict,
    reason: rejectReason,
    hunterEnvelope,
    bearEnvelope,
    committeeEnvelope,
    requestedMode: params.tradeIntent?.requestedMode,
    resolvedMarketType: params.tradeIntent?.marketType,
    scannerSide: params.tradeIntent?.side,
    strategySide: strategyDecision.side,
    committeeSide: committeeEnvelope.approved ? strategyDecision.side : 'NEUTRAL',
    gateDiagnostics: strategyDecision.gateDiagnostics,
    tradeIntent: params.tradeIntent,
    events: [{ time: timestamp, event: `DECISION_EVALUATED: ${verdict}`, details: { reason: rejectReason } }]
  };

  // 6. If Vetoed or Rejected: persist bundle with zero executor/trade/balance side-effects
  if (verdict !== 'APPROVE') {
    await persistDecisionBundle(store, decisionBundle);
    return {
      executed: false,
      status: 'REJECTED',
      reason: rejectReason,
      decisionBundle,
      correlationContext
    };
  }

  // 7. Execution Port Setup
  const customPort = options.executionPort;
  const executionPort = {
    ...customPort,
    saveTradeDB: async (trade: any, immediate?: boolean) => {
      if (customPort?.saveTradeDB) {
        await customPort.saveTradeDB(trade, immediate);
      }
      if (store && trade) {
        await store.saveState((state: any) => {
          if (!state) state = {};
          if (!Array.isArray(state.trades)) state.trades = [];
          const idx = state.trades.findIndex((t: any) => t.id === trade.id);
          if (idx !== -1) {
            state.trades[idx] = { ...trade };
          } else {
            state.trades.push({ ...trade });
          }

          if (!Array.isArray(state.decisionBundles)) state.decisionBundles = [];
          const targetBundle = trade.decisionBundle || decisionBundle;
          if (targetBundle) {
            const corrId = trade.correlationId || targetBundle.correlationId;
            const bIdx = state.decisionBundles.findIndex(
              (b: any) => b.correlationId === corrId || b.proposedTradeId === trade.id || b.finalTradeId === trade.id
            );
            const now = Date.now();
            const rev = store.getRevision();

            const existingEvents = bIdx !== -1 && state.decisionBundles[bIdx].events ? state.decisionBundles[bIdx].events : (targetBundle.events || []);
            const newEvents = [...existingEvents];
            const eventDesc = `LIFECYCLE_${trade.status || 'UPDATE'}: ${trade.id}`;
            if (!newEvents.some((e: any) => e.event === eventDesc)) {
              newEvents.push({
                time: now,
                event: eventDesc,
                details: {
                  status: trade.status,
                  entryPrice: trade.entryPrice,
                  exchangeOrderId: trade.exchangeOrderId,
                  closeReason: trade.closeReason,
                  needsReconciliation: trade.needsReconciliation
                }
              });
            }

            const updatedBundle: DecisionBundle = {
              ...targetBundle,
              ...(bIdx !== -1 ? state.decisionBundles[bIdx] : {}),
              correlationId: corrId,
              signalId: trade.signalId || targetBundle.signalId,
              proposedTradeId: targetBundle.proposedTradeId || trade.id,
              finalTradeId: trade.id,
              entryIntentId: trade.entryIntentId || targetBundle.entryIntentId || correlationContext.entryIntentId,
              strategyId: trade.strategyId || targetBundle.strategyId,
              strategyVersion: trade.strategyVersion || targetBundle.strategyVersion,
              stateRevision: rev,
              lifecycleStatus: trade.status,
              hunterEnvelope: targetBundle.hunterEnvelope,
              bearEnvelope: targetBundle.bearEnvelope,
              committeeEnvelope: targetBundle.committeeEnvelope,
              reconciliationMetadata: {
                attemptCount: trade.reconciliationAttemptCount || 1,
                intentTimestamp: trade.intentTimestamp || now,
                source: trade.decisionSource || 'COMMITTEE',
                needsReconciliation: !!trade.needsReconciliation
              },
              tradeIntent: {
                symbol: trade.symbol,
                isReal: trade.isReal,
                amount: trade.amount,
                status: trade.status
              },
              events: newEvents
            };

            if (trade.status === 'OPEN') {
              updatedBundle.tradeResult = {
                tradeId: trade.id,
                status: 'OPEN',
                entryPrice: trade.entryPrice,
                side: trade.side,
                orderId: trade.exchangeOrderId
              };
            } else if (trade.status === 'CANCELLED') {
              updatedBundle.tradeResult = {
                tradeId: trade.id,
                status: 'CANCELLED',
                reason: trade.closeReason
              };
            } else if (trade.status === 'OPEN_UNKNOWN') {
              updatedBundle.tradeResult = {
                tradeId: trade.id,
                status: 'OPEN_UNKNOWN',
                needsReconciliation: true,
                reason: trade.closeReason
              };
            }

            if (bIdx !== -1) {
              state.decisionBundles[bIdx] = updatedBundle;
            } else {
              state.decisionBundles.push(updatedBundle);
            }
          }
          return state;
        });
      }
    },
    saveBalanceDB: async () => {
      if (customPort?.saveBalanceDB) {
        await customPort.saveBalanceDB();
      }
    },
    reservePaperMargin: customPort?.reservePaperMargin
      ? (async (amount: number, immutableTradeId: string, entryIntentId: string, correlationId: string, trade: any) => {
          const res = await customPort.reservePaperMargin!(amount, immutableTradeId, entryIntentId, correlationId, trade);
          if (res.success && typeof res.newBalance === 'number' && 'virtualBalance' in customPort) {
            (customPort as any).virtualBalance = res.newBalance;
          }
          return res;
        })
      : (async (amount: number, immutableTradeId: string, entryIntentId: string, correlationId: string, trade: any) => {
          if (!immutableTradeId || !entryIntentId || !correlationId) {
            return { success: false, error: 'IMMUTABLE_TRADE_ID_ENTRY_INTENT_ID_AND_CORRELATION_ID_REQUIRED' };
          }
          const tradeLeverage = Math.max(1, Number(trade?.leverage || params.leverage || 1));
          const tradeNotional = Number(trade?.amount || params.calculatedAmount || amount);
          const tradeMargin = trade?.margin
            ? Number(trade.margin)
            : (amount === tradeNotional && tradeLeverage > 1
                ? Number((tradeNotional / tradeLeverage).toFixed(2))
                : Number(amount.toFixed(2)));
          const tx = await executePaperTradeOpenTransaction(store, {
            tradeId: immutableTradeId,
            entryIntentId,
            correlationId,
            signalId: correlationContext.signalId,
            margin: tradeMargin,
            trade: trade || { id: immutableTradeId, symbol: params.symbol, amount: tradeNotional, margin: tradeMargin, leverage: tradeLeverage },
            decisionBundle,
            initialBalanceFallback: params.virtualBalance
          });
          return tx.success
            ? { success: true, newBalance: tx.newBalance }
            : { success: false, error: tx.error };
        }),
    releasePaperMargin: customPort?.releasePaperMargin
      ? (async (amount: number, pnl: number, immutableTradeId: string, closeEventId: string) => {
          const res = await customPort.releasePaperMargin!(amount, pnl, immutableTradeId, closeEventId);
          if (res.success && typeof res.newBalance === 'number' && 'virtualBalance' in customPort) {
            (customPort as any).virtualBalance = res.newBalance;
          }
          return res;
        })
      : (async (amount: number, pnl: number, immutableTradeId: string, closeEventId: string) => {
          if (!immutableTradeId || !closeEventId) {
            return { success: false, error: 'IMMUTABLE_TRADE_ID_AND_CLOSE_EVENT_ID_REQUIRED' };
          }
          const tx = await executePaperTradeCloseTransaction(store, {
            tradeId: immutableTradeId,
            closeEventId,
            closeRatio: 1.0,
            pnl: pnl || 0,
            isFullClose: true
          });
          return { success: tx.success, newBalance: tx.newBalance, error: tx.error };
        }),
    getAvailableVirtualBalance: customPort?.getAvailableVirtualBalance
      ? () => customPort.getAvailableVirtualBalance!()
      : (() => {
          const state = store.loadState<any>({});
          return state?.settings?.main?.virtualBalance ?? 1000;
        }),
    getAtomicStoreRevision: customPort?.getAtomicStoreRevision
      ? () => customPort.getAtomicStoreRevision!()
      : (() => store.getRevision()),
    executeRealOpenOnExchange: customPort?.executeRealOpenOnExchange
      ? customPort.executeRealOpenOnExchange.bind(customPort)
      : undefined,
    setRealTradeSlTpOnExchange: customPort?.setRealTradeSlTpOnExchange
      ? customPort.setRealTradeSlTpOnExchange.bind(customPort)
      : undefined,
    logStructured: customPort?.logStructured
      ? customPort.logStructured.bind(customPort)
      : undefined
  };

  // 8. Execute via Canonical Auto-Entry Pipeline
  const autoEntryParams: AutoEntryParams = {
    symbol: params.symbol,
    isReal: params.isReal,
    marketInput: params.marketInput,
    tradeIntent: params.tradeIntent,
    currentSig: params.currentSig,
    finalAiScore: params.finalAiScore,
    calculatedAmount: params.calculatedAmount,
    leverage: params.leverage,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    tpStages: params.tpStages,
    gridOrders: params.gridOrders,
    virtualBalance: params.virtualBalance,
    targetIsAutoLearning: params.targetIsAutoLearning,
    decisionCorrelationContext: correlationContext,
    decisionBundle,
    stateRevision: currentRevision,
    sourcePath: params.sourcePath
  };

  const autoResult = await runCanonicalAutoEntry(autoEntryParams, executionPort);

  // 9. Update in-memory Decision Bundle structure for caller inspection
  decisionBundle.tradeIntent = {
    symbol: params.symbol,
    isReal: params.isReal,
    amount: params.calculatedAmount,
    leverage: params.leverage,
    status: autoResult.status
  };

  if (autoResult.trade) {
    decisionBundle.finalTradeId = autoResult.trade.id;
    decisionBundle.tradeResult = {
      tradeId: autoResult.trade.id,
      status: autoResult.trade.status,
      entryPrice: autoResult.trade.entryPrice,
      side: autoResult.trade.side
    };
  }

  decisionBundle.events?.push({
    time: Date.now(),
    event: `EXECUTION_RESULT: ${autoResult.status}`,
    details: { executed: autoResult.executed, reason: autoResult.reason }
  });

  return {
    executed: autoResult.executed,
    status: autoResult.status,
    side: autoResult.side,
    reason: autoResult.reason,
    trade: autoResult.trade,
    decisionBundle,
    correlationContext
  };
}

