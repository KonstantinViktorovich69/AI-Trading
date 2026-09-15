import { AtomicStateStore, type DurableCommitResult } from '../atomicDbSaver.ts';

export interface PaperTradeOpenParams {
  tradeId: string;
  entryIntentId: string;
  correlationId: string;
  signalId?: string;
  margin: number;
  trade: any;
  decisionBundle?: any;
  initialBalanceFallback?: number;
}

export interface PaperTradeCloseParams {
  tradeId: string;
  closeEventId: string;
  correlationId?: string;
  closeRatio: number;
  pnl: number;
  isFullClose: boolean;
  tradeUpdates?: any;
  historyEntry?: any;
}

export interface PaperTradeTxResult {
  success: boolean;
  type: 'OPEN' | 'PARTIAL_CLOSE' | 'FULL_CLOSE';
  tradeId: string;
  previousBalance: number;
  newBalance: number;
  stateRevision: number;
  trade?: any;
  error?: string;
  isIdempotentReplay?: boolean;
  durableCommitResult?: DurableCommitResult;
}

export interface PaperLedgerRecord {
  tradeId: string;
  entryIntentId?: string;
  closeEventId?: string;
  correlationId: string;
  type: 'RESERVE_OPEN' | 'PARTIAL_CLOSE' | 'FULL_CLOSE';
  margin: number;
  pnl: number;
  balanceBefore: number;
  balanceAfter: number;
  stateRevision: number;
  timestamp: number;
}

/**
 * Atomically executes a paper trade open transaction in a single serialized state commit.
 * Uses store.runTransaction to guarantee zero writes on abort/replay/insufficient balance.
 * Writes trade, ledger, balance, idempotency intent, decision bundle, and correlation metadata in one commit.
 */
export async function executePaperTradeOpenTransaction(
  store: AtomicStateStore,
  params: PaperTradeOpenParams
): Promise<PaperTradeTxResult> {
  const { tradeId, entryIntentId, correlationId, signalId, margin, trade, decisionBundle, initialBalanceFallback = 1000 } = params;

  const { outcome, commitResult } = await store.runTransaction<PaperTradeTxResult>((state: any) => {
    if (!state) state = {};
    if (!state.settings) state.settings = {};
    if (!state.settings.main) state.settings.main = {};
    if (!Array.isArray(state.trades)) state.trades = [];
    if (!Array.isArray(state.paperLedger)) state.paperLedger = [];
    if (!Array.isArray(state.paperIntentLog)) state.paperIntentLog = [];
    if (!Array.isArray(state.decisionBundles)) state.decisionBundles = [];

    const currentBalance = typeof state.settings.main.virtualBalance === 'number'
      ? state.settings.main.virtualBalance
      : (typeof state.virtualBalance === 'number' ? state.virtualBalance : initialBalanceFallback);

    // 1. Idempotency Check via entryIntentId or tradeId
    const existingIntent = state.paperIntentLog.find((i: any) => i.entryIntentId === entryIntentId || i.tradeId === tradeId);
    if (existingIntent) {
      const existingTrade = state.trades.find((t: any) => t.id === tradeId);
      const replayResult: PaperTradeTxResult = {
        success: true,
        type: 'OPEN',
        tradeId,
        previousBalance: existingIntent.balanceBefore,
        newBalance: existingIntent.balanceAfter,
        stateRevision: state.stateRevision || store.getRevision(),
        trade: existingTrade || trade,
        isIdempotentReplay: true
      };
      // ABORT: Zero disk write, zero revision increment, zero backup file
      return { kind: 'ABORT', result: replayResult };
    }

    // 2. Balance / Solvency Check
    if (currentBalance < margin) {
      const rejectResult: PaperTradeTxResult = {
        success: false,
        type: 'OPEN',
        tradeId,
        previousBalance: currentBalance,
        newBalance: currentBalance,
        stateRevision: state.stateRevision || store.getRevision(),
        error: `INSUFFICIENT_VIRTUAL_BALANCE: Available ${currentBalance.toFixed(2)} < required ${margin.toFixed(2)}`
      };
      // ABORT: Zero disk write, zero revision increment, zero backup file
      return { kind: 'ABORT', result: rejectResult };
    }

    // 3. Perform Single Durable Commit Mutations
    const nextBalance = Number((currentBalance - margin).toFixed(2));
    const revision = (state.stateRevision || store.getRevision()) + 1;
    const now = Date.now();

    state.settings.main.virtualBalance = nextBalance;
    state.virtualBalance = nextBalance;

    const tradeAmount = Number(trade?.amount || margin);
    const tradeLeverage = Math.max(1, Number(trade?.leverage || 1));
    const effectiveMargin = Number((margin || (tradeAmount / tradeLeverage)).toFixed(2));

    const committedTrade = {
      ...trade,
      id: tradeId,
      amount: tradeAmount,
      initialAmount: tradeAmount,
      margin: effectiveMargin,
      initialMargin: effectiveMargin,
      leverage: tradeLeverage,
      correlationId,
      signalId,
      entryIntentId,
      status: trade?.status || 'OPEN',
      stateRevision: revision,
      createdAt: trade?.createdAt || now
    };

    const existingTradeIdx = state.trades.findIndex((t: any) => t.id === tradeId);
    if (existingTradeIdx !== -1) {
      state.trades[existingTradeIdx] = committedTrade;
    } else {
      state.trades.push(committedTrade);
    }

    const ledgerEntry: PaperLedgerRecord = {
      tradeId,
      entryIntentId,
      correlationId,
      type: 'RESERVE_OPEN',
      margin,
      pnl: 0,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      stateRevision: revision,
      timestamp: now
    };
    state.paperLedger.push(ledgerEntry);

    state.paperIntentLog.push({
      entryIntentId,
      tradeId,
      correlationId,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      timestamp: now,
      revision
    });

    if (decisionBundle) {
      const bIdx = state.decisionBundles.findIndex((b: any) => b.correlationId === decisionBundle.correlationId);
      const unifiedBundle = {
        ...decisionBundle,
        stateRevision: revision,
        finalTradeId: tradeId,
        lifecycleStatus: 'OPEN',
        tradeIntent: {
          symbol: trade?.symbol,
          isReal: false,
          amount: margin,
          status: 'OPEN'
        },
        tradeResult: {
          tradeId,
          status: 'OPEN',
          entryPrice: trade?.entryPrice,
          side: trade?.side
        },
        events: [
          ...(decisionBundle.events || []),
          { time: now, event: 'LIFECYCLE_COMMITTED: OPEN', details: { tradeId, margin, nextBalance } }
        ]
      };
      if (bIdx !== -1) {
        state.decisionBundles[bIdx] = unifiedBundle;
      } else {
        state.decisionBundles.push(unifiedBundle);
        if (state.decisionBundles.length > 500) {
          state.decisionBundles = state.decisionBundles.slice(-500);
        }
      }
    }

    const commitTxResult: PaperTradeTxResult = {
      success: true,
      type: 'OPEN',
      tradeId,
      previousBalance: currentBalance,
      newBalance: nextBalance,
      stateRevision: revision,
      trade: committedTrade
    };

    return { kind: 'COMMIT', state, result: commitTxResult };
  });

  const finalResult = outcome.result;
  if (outcome.kind === 'COMMIT') {
    finalResult.durableCommitResult = commitResult;
    if (!commitResult?.success) {
      finalResult.success = false;
      finalResult.error = commitResult?.error || 'DURABLE_COMMIT_FAILED';
    }
  }

  return finalResult;
}

/**
 * Atomically executes a paper trade close transaction (partial or full) in a single serialized commit.
 * Uses store.runTransaction to guarantee zero writes on abort/replay/trade not found.
 */
export async function executePaperTradeCloseTransaction(
  store: AtomicStateStore,
  params: PaperTradeCloseParams
): Promise<PaperTradeTxResult> {
  const { tradeId, closeEventId, correlationId = '', closeRatio, pnl, isFullClose, tradeUpdates, historyEntry } = params;

  if (!tradeId || typeof tradeId !== 'string' || tradeId.trim() === '') {
    return {
      success: false,
      type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
      tradeId: '',
      previousBalance: 0,
      newBalance: 0,
      stateRevision: store.getRevision(),
      error: 'INVALID_TRADE_ID_REQUIRED'
    };
  }

  if (!closeEventId || typeof closeEventId !== 'string' || closeEventId.trim() === '') {
    return {
      success: false,
      type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
      tradeId,
      previousBalance: 0,
      newBalance: 0,
      stateRevision: store.getRevision(),
      error: 'INVALID_CLOSE_EVENT_ID_REQUIRED'
    };
  }

  const { outcome, commitResult } = await store.runTransaction<PaperTradeTxResult>((state: any) => {
    if (!state) state = {};
    if (!state.settings) state.settings = {};
    if (!state.settings.main) state.settings.main = {};
    if (!Array.isArray(state.trades)) state.trades = [];
    if (!Array.isArray(state.history)) state.history = [];
    if (!Array.isArray(state.paperLedger)) state.paperLedger = [];
    if (!Array.isArray(state.paperCloseLog)) state.paperCloseLog = [];

    const currentBalance = typeof state.settings.main.virtualBalance === 'number'
      ? state.settings.main.virtualBalance
      : (typeof state.virtualBalance === 'number' ? state.virtualBalance : 1000);

    // 1. Idempotency Check for close event
    const existingClose = state.paperCloseLog.find((c: any) => c.closeEventId === closeEventId);
    if (existingClose) {
      const replayResult: PaperTradeTxResult = {
        success: true,
        type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
        tradeId,
        previousBalance: existingClose.balanceBefore,
        newBalance: existingClose.balanceAfter,
        stateRevision: state.stateRevision || store.getRevision(),
        isIdempotentReplay: true
      };
      // ABORT: Zero disk write, zero revision increment, zero backup file
      return { kind: 'ABORT', result: replayResult };
    }

    const tradeIdx = state.trades.findIndex((t: any) => t.id === tradeId);
    const existingTrade = tradeIdx !== -1 ? state.trades[tradeIdx] : null;

    if (!existingTrade && isFullClose && !historyEntry) {
      const notFoundResult: PaperTradeTxResult = {
        success: false,
        type: 'FULL_CLOSE',
        tradeId,
        previousBalance: currentBalance,
        newBalance: currentBalance,
        stateRevision: state.stateRevision || store.getRevision(),
        error: `TRADE_NOT_FOUND: ${tradeId}`
      };
      // ABORT: Zero disk write, zero revision increment, zero backup file
      return { kind: 'ABORT', result: notFoundResult };
    }

    const tradeMargin = existingTrade?.margin || existingTrade?.initialMargin || (existingTrade?.amount ? existingTrade.amount / (existingTrade.leverage || 1) : 0);
    const releasedMargin = Number((tradeMargin * Math.min(1.0, Math.max(0, closeRatio))).toFixed(2));
    const nextBalance = Number((currentBalance + releasedMargin + pnl).toFixed(2));
    const revision = (state.stateRevision || store.getRevision()) + 1;
    const now = Date.now();

    state.settings.main.virtualBalance = nextBalance;
    state.virtualBalance = nextBalance;

    if (isFullClose) {
      if (tradeIdx !== -1) {
        const closedTrade = {
          ...state.trades[tradeIdx],
          ...tradeUpdates,
          status: 'CLOSED',
          closedAt: now,
          pnl,
          closeReason: tradeUpdates?.closeReason || 'FULL_CLOSE',
          stateRevision: revision
        };
        state.trades.splice(tradeIdx, 1);
        state.history.push(historyEntry || closedTrade);
      } else if (historyEntry) {
        state.history.push({ ...historyEntry, stateRevision: revision });
      }
    } else {
      if (tradeIdx !== -1) {
        state.trades[tradeIdx] = {
          ...state.trades[tradeIdx],
          ...tradeUpdates,
          stateRevision: revision
        };
      }
    }

    const ledgerEntry: PaperLedgerRecord = {
      tradeId,
      closeEventId,
      correlationId: correlationId || existingTrade?.correlationId || '',
      type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
      margin: releasedMargin,
      pnl,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      stateRevision: revision,
      timestamp: now
    };
    state.paperLedger.push(ledgerEntry);

    state.paperCloseLog.push({
      closeEventId,
      tradeId,
      type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
      releasedMargin,
      pnl,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      timestamp: now,
      revision
    });

    const corrId = correlationId || existingTrade?.correlationId || '';
    if (corrId && Array.isArray(state.decisionBundles)) {
      const bIdx = state.decisionBundles.findIndex((b: any) => b.correlationId === corrId || b.finalTradeId === tradeId);
      if (bIdx !== -1) {
        state.decisionBundles[bIdx].events = state.decisionBundles[bIdx].events || [];
        state.decisionBundles[bIdx].events.push({
          time: now,
          event: isFullClose ? 'LIFECYCLE_COMMITTED: FULL_CLOSE' : 'LIFECYCLE_COMMITTED: PARTIAL_CLOSE',
          details: { tradeId, closeEventId, pnl, releasedMargin, nextBalance }
        });
        if (isFullClose) {
          state.decisionBundles[bIdx].lifecycleStatus = 'CLOSED';
        }
      }
    }

    const closeTxResult: PaperTradeTxResult = {
      success: true,
      type: isFullClose ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
      tradeId,
      previousBalance: currentBalance,
      newBalance: nextBalance,
      stateRevision: revision,
      trade: isFullClose ? undefined : state.trades[tradeIdx]
    };

    return { kind: 'COMMIT', state, result: closeTxResult };
  });

  const finalResult = outcome.result;
  if (outcome.kind === 'COMMIT') {
    finalResult.durableCommitResult = commitResult;
    if (!commitResult?.success) {
      finalResult.success = false;
      finalResult.error = commitResult?.error || 'DURABLE_COMMIT_FAILED';
    }
  }

  return finalResult;
}
