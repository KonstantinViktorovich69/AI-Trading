import { AtomicStateStore, type DurablePersistenceResult } from '../atomicDbSaver.ts';

export type PaperCapitalTxType = 'RESERVE_OPEN' | 'PARTIAL_CLOSE' | 'FULL_CLOSE' | 'ROLLBACK';

export interface PaperCapitalTxParams {
  tradeId: string;
  type: PaperCapitalTxType;
  margin: number;
  pnl?: number;
  trade?: any;
  closeRatio?: number;
  initialBalanceFallback?: number;
}

export interface PaperCapitalTxResult {
  success: boolean;
  type: PaperCapitalTxType;
  tradeId: string;
  previousBalance: number;
  newBalance: number;
  stateRevision: number;
  trade?: any;
  error?: string;
  isIdempotentReplay?: boolean;
}

export interface PaperLedgerEntry {
  tradeId: string;
  type: PaperCapitalTxType;
  margin: number;
  pnl: number;
  balanceBefore: number;
  balanceAfter: number;
  stateRevision: number;
  timestamp: number;
}

/**
 * Atomically executes and persists a paper capital transaction with strict idempotency and versioning.
 * Mutates state only inside the atomic transaction commit.
 */
export async function executePaperCapitalTransaction(
  store: AtomicStateStore,
  params: PaperCapitalTxParams
): Promise<PaperCapitalTxResult> {
  const { tradeId, type, margin, pnl = 0, trade, closeRatio = 1.0, initialBalanceFallback = 1000 } = params;

  let txResult: PaperCapitalTxResult = {
    success: false,
    type,
    tradeId,
    previousBalance: 0,
    newBalance: 0,
    stateRevision: store.getRevision(),
    trade
  };

  await store.saveState((state: any) => {
    if (!state) state = {};
    if (!state.settings) state.settings = {};
    if (!state.settings.main) state.settings.main = {};
    if (!Array.isArray(state.trades)) state.trades = [];
    if (!Array.isArray(state.paperLedger)) state.paperLedger = [];

    const currentBalance = typeof state.settings.main.virtualBalance === 'number'
      ? state.settings.main.virtualBalance
      : initialBalanceFallback;

    const ledger: PaperLedgerEntry[] = state.paperLedger;
    const existingTx = ledger.find(e => e.tradeId === tradeId && e.type === type);

    // Idempotency: prevent double reservation or double release
    if (existingTx) {
      txResult = {
        success: true,
        type,
        tradeId,
        previousBalance: existingTx.balanceBefore,
        newBalance: existingTx.balanceAfter,
        stateRevision: state.stateRevision || store.getRevision(),
        trade: state.trades.find((t: any) => t.id === tradeId) || trade,
        isIdempotentReplay: true
      };
      return state; // No state mutation
    }

    let nextBalance = currentBalance;

    if (type === 'RESERVE_OPEN') {
      if (currentBalance < margin) {
        txResult = {
          success: false,
          type,
          tradeId,
          previousBalance: currentBalance,
          newBalance: currentBalance,
          stateRevision: state.stateRevision || store.getRevision(),
          error: `INSUFFICIENT_VIRTUAL_BALANCE: Available ${currentBalance.toFixed(2)} < required ${margin.toFixed(2)}`
        };
        // Do not mutate state on insufficient funds
        return state;
      }

      nextBalance = Number((currentBalance - margin).toFixed(2));

      // Append/update trade in DB
      if (trade) {
        const idx = state.trades.findIndex((t: any) => t.id === tradeId);
        if (idx !== -1) {
          state.trades[idx] = { ...trade };
        } else {
          state.trades.push({ ...trade });
        }
      }
    } else if (type === 'PARTIAL_CLOSE') {
      const releasedMargin = margin * Math.min(1.0, Math.max(0, closeRatio));
      nextBalance = Number((currentBalance + releasedMargin + pnl).toFixed(2));

      if (trade) {
        const idx = state.trades.findIndex((t: any) => t.id === tradeId);
        if (idx !== -1) {
          state.trades[idx] = { ...trade };
        }
      }
    } else if (type === 'FULL_CLOSE') {
      nextBalance = Number((currentBalance + margin + pnl).toFixed(2));

      if (trade) {
        const idx = state.trades.findIndex((t: any) => t.id === tradeId);
        if (idx !== -1) {
          state.trades[idx] = { ...trade };
        }
      }
    } else if (type === 'ROLLBACK') {
      const reserveEntry = ledger.find(e => e.tradeId === tradeId && e.type === 'RESERVE_OPEN');
      if (reserveEntry) {
        nextBalance = Number((currentBalance + margin).toFixed(2));
        // Remove or mark cancelled
        const idx = state.trades.findIndex((t: any) => t.id === tradeId);
        if (idx !== -1) {
          state.trades[idx].status = 'CANCELLED';
          state.trades[idx].closeReason = 'ROLLBACK';
        }
      }
    }

    state.settings.main.virtualBalance = nextBalance;

    const nextRev = (state.stateRevision || 0) + 1;
    state.stateRevision = nextRev;

    ledger.push({
      tradeId,
      type,
      margin,
      pnl,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      stateRevision: nextRev,
      timestamp: Date.now()
    });

    txResult = {
      success: true,
      type,
      tradeId,
      previousBalance: currentBalance,
      newBalance: nextBalance,
      stateRevision: nextRev,
      trade: state.trades.find((t: any) => t.id === tradeId) || trade
    };

    return state;
  });

  return txResult;
}
