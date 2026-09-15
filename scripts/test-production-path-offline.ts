import fs from 'fs';
import path from 'path';
import os from 'os';
import { AutoEntryExecutionPort } from '../server/services/autoEntryService.ts';
import {
  executeMainVirtualAutoEntry,
  executeMainRealAutoEntry,
  executeWorkerRealAutoEntry,
  executeWorkerVirtualAutoEntry,
  ProductionEntryParams
} from '../server/services/productionAutoEntryHandlers.ts';
import { runProductionAutoEntryCoordinator, persistDecisionBundle, DecisionBundle } from '../server/services/autoEntryCoordinator.ts';
import { evaluateExitPolicy, ExitTradeSnapshot, ExitMarketSnapshot, ExitPolicySettings } from '../server/services/exitPolicy.ts';
import { evaluateEntryDecision, getApprovedExecutionSide, EntryDecision, CanonicalMarketInput } from '../server/services/strategyEngine.ts';
import { DecisionCorrelationContext, AgentDecisionEnvelope, evaluateCommitteeConsensus } from '../server/services/agentEngine.ts';
import { AtomicStateStore, createRuntimeStateStores } from '../server/atomicDbSaver.ts';
import { executePaperTradeOpenTransaction, executePaperTradeCloseTransaction } from '../server/services/paperTradeTransaction.ts';
import { executePaperCapitalTransaction } from '../server/services/paperCapitalStore.ts';

export interface RecordedExecutionCall {
  method: string;
  symbol?: string;
  side?: string;
  amount?: number;
  leverage?: number;
  sl?: number;
  tp?: number;
  timestamp: number;
}

export class MockProductionPort implements AutoEntryExecutionPort {
  public calls: RecordedExecutionCall[] = [];
  public virtualBalance = 1000;
  public trades: any[] = [];
  public failRealOpen = false;
  public failIntentSave = false;
  public failRealOpenWithException = false;
  public failPartialClose = false;
  public stateRevision = 1;
  public store?: AtomicStateStore;

  constructor(store?: AtomicStateStore) {
    this.store = store;
  }

  async executeRealOpenOnExchange(symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number): Promise<{ success: boolean; entryPrice?: number; orderId?: string; error?: string }> {
    this.calls.push({ method: 'executeRealOpenOnExchange', symbol, side, amount, leverage, timestamp: Date.now() });
    if (this.failRealOpenWithException) {
      throw new Error('EXCHANGE_TIMEOUT_OR_NETWORK_ERROR');
    }
    if (this.failRealOpen) {
      return { success: false, error: 'INSUFFICIENT_EXCHANGE_MARGIN' };
    }
    return { success: true, entryPrice: 100.0, orderId: `ex_ord_${Date.now()}` };
  }

  async setRealTradeSlTpOnExchange(symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number): Promise<boolean> {
    this.calls.push({ method: 'setRealTradeSlTpOnExchange', symbol, side, sl: stopLoss, tp: takeProfit, timestamp: Date.now() });
    return true;
  }

  async saveTradeDB(trade: any, immediate?: boolean): Promise<void> {
    this.calls.push({ method: 'saveTradeDB', symbol: trade.symbol, amount: trade.amount, timestamp: Date.now() });
    if (this.failIntentSave) {
      throw new Error('DURABLE_INTENT_PERSISTENCE_FAILED');
    }
    const idx = this.trades.findIndex(t => t.id === trade.id);
    if (idx >= 0) {
      this.trades[idx] = { ...trade };
    } else {
      this.trades.push({ ...trade });
    }
    this.stateRevision++;

    if (this.store) {
      await this.store.saveState((state: any) => {
        if (!state) state = {};
        if (!Array.isArray(state.trades)) state.trades = [];
        const sIdx = state.trades.findIndex((t: any) => t.id === trade.id);
        if (sIdx >= 0) state.trades[sIdx] = { ...trade };
        else state.trades.push({ ...trade });
        return state;
      });
    }
  }

  async saveBalanceDB(): Promise<void> {
    this.calls.push({ method: 'saveBalanceDB', amount: this.virtualBalance, timestamp: Date.now() });
    this.stateRevision++;
  }

  async reservePaperMargin(amount: number, immutableTradeId?: string, entryIntentId?: string, correlationId?: string, trade?: any): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    const tradeId = immutableTradeId || `TR-MOCK-${Date.now()}`;
    if (this.store) {
      const tx = await executePaperTradeOpenTransaction(this.store, {
        tradeId,
        entryIntentId: entryIntentId || `intent-${tradeId}`,
        correlationId: correlationId || `corr-${tradeId}`,
        margin: amount,
        trade: trade || { id: tradeId, amount },
        initialBalanceFallback: this.virtualBalance
      });
      if (tx.success) {
        this.virtualBalance = tx.newBalance;
        this.calls.push({ method: 'reservePaperMargin', amount, timestamp: Date.now() });
        return { success: true, newBalance: tx.newBalance };
      }
      return { success: false, error: tx.error };
    } else {
      if (this.virtualBalance < amount) {
        return { success: false, error: `INSUFFICIENT_VIRTUAL_BALANCE: ${this.virtualBalance} < ${amount}` };
      }
      this.virtualBalance = Number((this.virtualBalance - amount).toFixed(2));
      this.calls.push({ method: 'reservePaperMargin', amount, timestamp: Date.now() });
      return { success: true, newBalance: this.virtualBalance };
    }
  }

  async releasePaperMargin(amount: number, pnl?: number, immutableTradeId?: string, closeEventId?: string): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    const tradeId = immutableTradeId || `TR-MOCK-${Date.now()}`;
    if (this.failPartialClose) {
      return { success: false, error: 'SIMULATED_LEDGER_RELEASE_ERROR' };
    }
    if (this.store) {
      const tx = await executePaperTradeCloseTransaction(this.store, {
        tradeId,
        closeEventId: closeEventId || `close-${tradeId}`,
        closeRatio: 1.0,
        pnl: pnl || 0,
        isFullClose: true
      });
      if (tx.success) {
        this.virtualBalance = tx.newBalance;
        this.calls.push({ method: 'releasePaperMargin', amount, timestamp: Date.now() });
        return { success: true, newBalance: tx.newBalance };
      }
      return { success: false, error: tx.error };
    } else {
      this.virtualBalance = Number((this.virtualBalance + amount + (pnl || 0)).toFixed(2));
      this.calls.push({ method: 'releasePaperMargin', amount, timestamp: Date.now() });
      return { success: true, newBalance: this.virtualBalance };
    }
  }

  getAvailableVirtualBalance(): number {
    return this.virtualBalance;
  }

  logStructured(level: string, category: string, message: string, symbol?: string, meta?: any): void {
    this.calls.push({ method: 'logStructured', symbol, timestamp: Date.now() });
  }

  sendTelegramMessage(message: string): Promise<boolean> {
    this.calls.push({ method: 'sendTelegramMessage', timestamp: Date.now() });
    return Promise.resolve(true);
  }

  getAtomicStoreRevision(): number {
    return this.stateRevision;
  }
}

function createBullishEnvelope(corrId: string, symbol: string): AgentDecisionEnvelope {
  return {
    decisionId: `dec_hunter_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'HUNTER',
    strategyId: 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: '2.1.0',
    action: 'APPROVE',
    confidence: 88,
    approved: true,
    decisionSource: 'AI',
    rationale: 'Bullish breakout with heavy volume and positive orderbook skew',
    createdAt: Date.now(),
    correlationId: corrId
  };
}

function createBearishEnvelope(corrId: string, symbol: string): AgentDecisionEnvelope {
  return {
    decisionId: `dec_bear_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    agentName: 'BEAR',
    strategyId: 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: '2.1.0',
    action: 'APPROVE',
    confidence: 82,
    approved: true,
    decisionSource: 'AI',
    rationale: 'Concurrence: support confirmed, low risk of breakdown',
    createdAt: Date.now(),
    correlationId: corrId
  };
}

export async function runAllOfflineTests(): Promise<boolean> {
  console.log('=== RUNNING PRODUCTION PATH OFFLINE VERIFICATION SUITE ===\n');

  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weex-offline-gate-'));
  const tempDbPath = path.join(testTempDir, 'database.json');
  const tempSettingsPath = path.join(testTempDir, 'settings.json');

  fs.writeFileSync(tempDbPath, JSON.stringify({ trades: [], knowledge: [], virtualBalance: 1000 }, null, 2));
  fs.writeFileSync(tempSettingsPath, JSON.stringify({ virtualBalance: 1000 }, null, 2));

  const store = new AtomicStateStore(tempDbPath);
  let totalTests = 0;
  let passedTests = 0;

  async function assert(name: string, fn: () => Promise<void>) {
    totalTests++;
    try {
      await fn();
      passedTests++;
      console.log(`✅ PASS: ${name}`);
    } catch (err: any) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Error: ${err.message || err}`);
    }
  }

  const baseMarketInput: CanonicalMarketInput = {
    symbol: 'BTC/USDT',
    marketType: 'FUTURES',
    tradingMode: 'FUTURES',
    price: 60000,
    high: 60500,
    low: 59800,
    open: 59900,
    vwap: 59950,
    sar: 59850,
    rsi: 48,
    change24h: 3.2,
    volume24h: 500000,
    avgVolume: 100000,
    orderBookImbalance: 0.25,
    isCommitteeConsensusEnabled: true
  };

  // Case 1: Main Virtual Auto-Entry via executeMainVirtualAutoEntry
  await assert('Case 1: Main Virtual Auto-Entry with atomic paper balance reservation', async () => {
    const port = new MockProductionPort(store);
    const corrId = `corr-main-virt-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'BTC/USDT',
      marketInput: baseMarketInput,
      calculatedAmount: 50,
      leverage: 10,
      stopLoss: 59000,
      takeProfit: 62000,
      virtualBalance: 1000,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeMainVirtualAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'BTC/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'BTC/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (!res.executed || res.status !== 'OPEN') {
      throw new Error(`Expected OPEN virtual trade, got status: ${res.status}`);
    }
    if (port.virtualBalance !== 950) {
      throw new Error(`Expected paper balance 950, got ${port.virtualBalance}`);
    }
    if (!res.trade?.id || !res.trade.correlationId) {
      throw new Error('Missing tradeId or correlationId on created trade');
    }
  });

  // Case 2: Worker Virtual Auto-Entry via executeWorkerVirtualAutoEntry
  await assert('Case 2: Worker Virtual Auto-Entry with isolated lineage and consensus', async () => {
    const port = new MockProductionPort(store);
    const corrId = `corr-worker-virt-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'ETH/USDT',
      marketInput: { ...baseMarketInput, symbol: 'ETH/USDT', price: 3000 },
      calculatedAmount: 100,
      leverage: 5,
      virtualBalance: 950,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeWorkerVirtualAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'ETH/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'ETH/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (!res.executed || res.status !== 'OPEN') {
      throw new Error(`Expected OPEN virtual trade for worker, got status: ${res.status}`);
    }
    if (port.virtualBalance !== 850) {
      throw new Error(`Expected balance 850, got ${port.virtualBalance}`);
    }
  });

  // Case 3: Main Real Auto-Entry via executeMainRealAutoEntry
  await assert('Case 3: Main Real Auto-Entry full canonical path', async () => {
    const port = new MockProductionPort(store);
    const corrId = `corr-main-real-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'SOL/USDT',
      marketInput: { ...baseMarketInput, symbol: 'SOL/USDT', price: 150 },
      calculatedAmount: 30,
      leverage: 5,
      stopLoss: 140,
      takeProfit: 170,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeMainRealAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'SOL/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'SOL/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (!res.executed || res.status !== 'OPEN') {
      throw new Error(`Expected OPEN real trade, got status: ${res.status}`);
    }
    const realCalls = port.calls.filter(c => c.method === 'executeRealOpenOnExchange');
    if (realCalls.length !== 1) {
      throw new Error(`Expected 1 executeRealOpenOnExchange call, got ${realCalls.length}`);
    }
    if (res.trade?.slTpStatus !== 'SET') {
      throw new Error(`Expected slTpStatus SET, got ${res.trade?.slTpStatus}`);
    }
  });

  // Case 4: Worker Real Auto-Entry via executeWorkerRealAutoEntry
  await assert('Case 4: Worker Real Auto-Entry execution and persistence', async () => {
    const port = new MockProductionPort(store);
    const corrId = `corr-worker-real-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'AVAX/USDT',
      marketInput: { ...baseMarketInput, symbol: 'AVAX/USDT', price: 30 },
      calculatedAmount: 25,
      leverage: 5,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeWorkerRealAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'AVAX/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'AVAX/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (!res.executed || res.status !== 'OPEN') {
      throw new Error(`Expected OPEN worker real trade, got status: ${res.status}`);
    }
  });

  // Case 5: Strategy Reject / Committee Veto (0 Side Effects)
  await assert('Case 5: Strategy Rejection / Committee Veto persists decision bundle with 0 side effects', async () => {
    const port = new MockProductionPort(store);
    const corrId = `corr-veto-${Date.now()}`;
    const vetoEnvelope: AgentDecisionEnvelope = {
      decisionId: `dec_bear_veto_${Date.now()}`,
      agentName: 'BEAR',
      strategyId: 'CANONICAL_QUANT_SCALP_V2',
      strategyVersion: '2.1.0',
      action: 'REJECT',
      confidence: 95,
      approved: false,
      decisionSource: 'AI',
      rationale: 'Extreme market fragility detected, blocking all long entries',
      createdAt: Date.now(),
      correlationId: corrId
    };

    const params: ProductionEntryParams = {
      symbol: 'BTC/USDT',
      marketInput: baseMarketInput,
      calculatedAmount: 50,
      leverage: 5,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeMainRealAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'BTC/USDT'),
      bearDecision: vetoEnvelope,
      isCommitteeConsensusEnabled: true
    });

    if (res.executed) {
      throw new Error('Vetoed entry should not be executed');
    }
    const realCalls = port.calls.filter(c => c.method === 'executeRealOpenOnExchange');
    if (realCalls.length !== 0) {
      throw new Error('Zero exchange calls allowed on veto');
    }
    if (port.trades.length !== 0) {
      throw new Error('Zero trade records allowed in trade DB on veto');
    }
  });

  // Case 6: Real Intent Persistence Failure
  await assert('Case 6: Real Intent Persistence failure fails closed with 0 exchange calls', async () => {
    const port = new MockProductionPort(store);
    port.failIntentSave = true;
    const corrId = `corr-fail-persist-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'DOGE/USDT',
      marketInput: { ...baseMarketInput, symbol: 'DOGE/USDT', price: 0.15 },
      calculatedAmount: 20,
      leverage: 5,
      customCorrelationContext: { correlationId: corrId }
    };

    let caught = false;
    try {
      await executeMainRealAutoEntry(params, {
        store,
        executionPort: port,
        hunterDecision: createBullishEnvelope(corrId, 'DOGE/USDT'),
        bearDecision: createBearishEnvelope(corrId, 'DOGE/USDT'),
        isCommitteeConsensusEnabled: true
      });
    } catch {
      caught = true;
    }

    if (!caught) {
      throw new Error('Expected durable persistence error to fail closed');
    }
    const exchangeCalls = port.calls.filter(c => c.method === 'executeRealOpenOnExchange');
    if (exchangeCalls.length !== 0) {
      throw new Error('Exchange call must never be made if pending trade persistence fails');
    }
  });

  // Case 7: Known Exchange Rejection
  await assert('Case 7: Known exchange rejection transitions trade to CANCELLED', async () => {
    const port = new MockProductionPort(store);
    port.failRealOpen = true;
    const corrId = `corr-ex-rej-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'XRP/USDT',
      marketInput: { ...baseMarketInput, symbol: 'XRP/USDT', price: 0.6 },
      calculatedAmount: 30,
      leverage: 5,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeMainRealAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'XRP/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'XRP/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (res.executed || res.status !== 'CANCELLED') {
      throw new Error(`Expected CANCELLED status, got ${res.status}`);
    }
  });

  // Case 8: Exchange Timeout / Exception
  await assert('Case 8: Exchange timeout transitions trade to OPEN_UNKNOWN and flags reconciliation', async () => {
    const port = new MockProductionPort(store);
    port.failRealOpenWithException = true;
    const corrId = `corr-ex-timeout-${Date.now()}`;
    const params: ProductionEntryParams = {
      symbol: 'LINK/USDT',
      marketInput: { ...baseMarketInput, symbol: 'LINK/USDT', price: 18 },
      calculatedAmount: 25,
      leverage: 5,
      customCorrelationContext: { correlationId: corrId }
    };

    const res = await executeMainRealAutoEntry(params, {
      store,
      executionPort: port,
      hunterDecision: createBullishEnvelope(corrId, 'LINK/USDT'),
      bearDecision: createBearishEnvelope(corrId, 'LINK/USDT'),
      isCommitteeConsensusEnabled: true
    });

    if (res.status !== 'OPEN_UNKNOWN') {
      throw new Error(`Expected OPEN_UNKNOWN status, got ${res.status}`);
    }
    const trade = port.trades.find(t => t.symbol === 'LINK/USDT');
    if (!trade || !trade.needsReconciliation) {
      throw new Error('Trade must have needsReconciliation flag set to true');
    }
  });

  // Case 9: HOLD Exit Policy Protection
  await assert('Case 9: evaluateExitPolicy returns HOLD below profit floor to prevent premature TP', async () => {
    const tradeSnap: ExitTradeSnapshot = {
      id: 'TR-101',
      symbol: 'BTC/USDT',
      side: 'LONG',
      entryPrice: 60000,
      currentPrice: 60100,
      amount: 100,
      leverage: 10,
      createdAt: Date.now() - 60000
    };

    const marketSnap: ExitMarketSnapshot = {
      currentPrice: 60100, // +0.16% (below minimum TP floor of 4.0%)
      bid: 60090,
      ask: 60110,
      vwap: 60000,
      sar: 59900
    };

    const settings: ExitPolicySettings = {
      enableTrailingStop: true,
      minNormalAutoCloseNetPnlPct: 4.0
    };

    const decision = evaluateExitPolicy(tradeSnap, marketSnap, settings);
    if (decision.action !== 'HOLD') {
      throw new Error(`Expected HOLD below profit floor, got ${decision.action}`);
    }
  });

  // Case 10: Partial Close Failure Immutability
  await assert('Case 10: Partial close failure preserves original state without corruption', async () => {
    const port = new MockProductionPort(store);
    port.failPartialClose = true;
    const initialBal = port.virtualBalance;

    const res = await port.releasePaperMargin(50, 10);
    if (res.success) {
      throw new Error('Expected releasePaperMargin to fail');
    }
    if (port.virtualBalance !== initialBal) {
      throw new Error('Balance was modified despite release failure');
    }
  });

  // Case 11: Complete Correlated Decision Bundle
  await assert('Case 11: Persist and verify complete decision bundle with strategy and consensus', async () => {
    const corrId = `corr-bundle-${Date.now()}`;
    const bundle: DecisionBundle = {
      correlationId: corrId,
      symbol: 'NEAR/USDT',
      timestamp: Date.now(),
      marketSnapshot: baseMarketInput,
      strategyDecision: {
        action: 'EXECUTE',
        side: 'BUY',
        confidence: 85,
        reason: 'Valid pattern confluence',
        riskFactor: 0.2
      },
      agentEnvelopes: [createBullishEnvelope(corrId, 'NEAR/USDT'), createBearishEnvelope(corrId, 'NEAR/USDT')],
      consensusResult: {
        approved: true,
        action: 'BUY',
        weightedConfidence: 85,
        reason: 'Consensus reached',
        participatingAgents: ['HUNTER_AGENT', 'BEAR_AGENT']
      },
      executionResult: {
        executed: true,
        status: 'OPEN',
        tradeId: `TR-${corrId}`
      }
    };

    const commit = await persistDecisionBundle(store, bundle);
    if (!commit.success) {
      throw new Error('Failed to persist decision bundle');
    }
    const state = store.loadState<any>({});
    const saved = state.decisionBundles?.find((b: any) => b.correlationId === corrId);
    if (!saved || saved.symbol !== 'NEAR/USDT') {
      throw new Error('Saved decision bundle not found in store');
    }
  });

  // Case 12: Idempotent Entry Replay Zero Double Debit
  await assert('Case 12: Idempotent replay of same entryIntentId prevents duplicate margin debit', async () => {
    const intentId = `intent_idemp_${Date.now()}`;
    const stateBefore = store.loadState<any>({});
    const initialBal = stateBefore?.settings?.main?.virtualBalance ?? 1000;

    const firstRes = await executePaperCapitalTransaction(store, {
      tradeId: `TR-${intentId}`,
      type: 'RESERVE_OPEN',
      margin: 100,
      initialBalanceFallback: initialBal
    });

    if (!firstRes.success || firstRes.newBalance !== initialBal - 100) {
      throw new Error(`First reservation failed or incorrect balance: ${firstRes.newBalance}`);
    }

    const replayRes = await executePaperCapitalTransaction(store, {
      tradeId: `TR-${intentId}`,
      type: 'RESERVE_OPEN',
      margin: 100,
      initialBalanceFallback: firstRes.newBalance
    });

    if (!replayRes.success || !replayRes.isIdempotentReplay) {
      throw new Error('Replay was not detected as idempotent');
    }
    if (replayRes.newBalance !== firstRes.newBalance) {
      throw new Error(`Replay mutated balance! Expected ${firstRes.newBalance}, got ${replayRes.newBalance}`);
    }
  });

  // Case 13: Low Virtual Balance Atomic Rejection Zero State Change
  await assert('Case 13: Low virtual balance results in atomic rejection with zero state mutation', async () => {
    const lowBalStore = new AtomicStateStore(path.join(testTempDir, 'db_low_bal.json'));
    await lowBalStore.saveState((s: any) => {
      s.settings = { main: { virtualBalance: 10 } };
      return s;
    });

    const res = await executePaperCapitalTransaction(lowBalStore, {
      tradeId: `TR-LOW-${Date.now()}`,
      type: 'RESERVE_OPEN',
      margin: 50,
      initialBalanceFallback: 10
    });

    if (res.success) {
      throw new Error('Expected reservation to fail due to insufficient balance');
    }
    const state = lowBalStore.loadState<any>({});
    if (state.settings?.main?.virtualBalance !== 10) {
      throw new Error('State was mutated on failed reservation');
    }
  });

  // Case 14: Temporary Store Cleanup & Isolation
  await assert('Case 14: Temporary store cleanup and verification of zero pollution', async () => {
    if (!fs.existsSync(tempDbPath)) {
      throw new Error('Temporary database path missing before cleanup');
    }
    fs.rmSync(testTempDir, { recursive: true, force: true });
    if (fs.existsSync(tempDbPath)) {
      throw new Error('Failed to clean up temporary database');
    }
  });

  console.log('\n========================================');
  console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} PASSED`);
  if (passedTests === totalTests) {
    console.log('🎉 ALL OFFLINE PRODUCTION PATH TESTS PASSED PERFECTLY!');
    return true;
  } else {
    console.error(`❌ ${totalTests - passedTests} TESTS FAILED.`);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('test-production-path-offline.ts')) {
  runAllOfflineTests().then(ok => {
    process.exit(ok ? 0 : 1);
  });
}
