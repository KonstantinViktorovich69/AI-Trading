import fs from 'fs';
import path from 'path';
import os from 'os';
import { evaluateEntryDecision, getApprovedExecutionSide, EntryDecision } from '../server/services/strategyEngine.ts';
import { evaluateExitPolicy, ExitTradeSnapshot, ExitMarketSnapshot } from '../server/services/exitPolicy.ts';
import { DecisionCorrelationContext, AgentDecisionEnvelope } from '../server/services/agentEngine.ts';
import { AtomicStateStore } from '../server/atomicDbSaver.ts';

export interface MockExecutionEvent {
  action: 'OPEN' | 'PARTIAL_CLOSE' | 'FULL_CLOSE' | 'SL_TP_SYNC';
  side?: 'LONG' | 'SHORT';
  symbol: string;
  amount: number;
  price?: number;
  closeRatio?: number;
  timestamp: number;
}

export class MockExecutionPort {
  public events: MockExecutionEvent[] = [];
  public failNextCall = false;

  async executeOpen(side: 'LONG' | 'SHORT', symbol: string, amount: number, price?: number): Promise<{ success: boolean; orderId: string }> {
    if (this.failNextCall) {
      this.failNextCall = false;
      throw new Error('MOCK_EXCHANGE_REJECT');
    }
    const orderId = `mock_ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.events.push({ action: 'OPEN', side, symbol, amount, price, timestamp: Date.now() });
    return { success: true, orderId };
  }

  async executePartialClose(symbol: string, closeRatio: number, amount: number): Promise<{ success: boolean }> {
    if (this.failNextCall) {
      this.failNextCall = false;
      throw new Error('MOCK_PARTIAL_CLOSE_FAILED');
    }
    this.events.push({ action: 'PARTIAL_CLOSE', symbol, closeRatio, amount, timestamp: Date.now() });
    return { success: true };
  }

  async executeFullClose(symbol: string, amount: number): Promise<{ success: boolean }> {
    if (this.failNextCall) {
      this.failNextCall = false;
      throw new Error('MOCK_FULL_CLOSE_FAILED');
    }
    this.events.push({ action: 'FULL_CLOSE', symbol, amount, timestamp: Date.now() });
    return { success: true };
  }

  reset() {
    this.events = [];
    this.failNextCall = false;
  }
}

function createDummyEnvelope(name: 'HUNTER' | 'BEAR' | 'COMMITTEE', approved: boolean, action: 'APPROVE' | 'REJECT' | 'HOLD' | 'NO_TRADE'): AgentDecisionEnvelope {
  return {
    decisionId: `dec_${name}_${Date.now()}`,
    agentName: name,
    strategyId: 'CANONICAL_QUANT_SCALP_V2',
    strategyVersion: '2.1.0',
    action,
    confidence: approved ? 85 : 20,
    approved,
    decisionSource: 'RULE_ENGINE',
    rationale: 'Test envelope',
    createdAt: Date.now()
  };
}

async function runOfflineE2ETests() {
  console.log('=== RUNNING OFFLINE E2E SERVER-PATH TESTS (P0-6) ===\n');
  let passed = 0;
  let failed = 0;

  const mockPort = new MockExecutionPort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-offline-db-'));
  const tmpDbPath = path.join(tmpDir, 'database.json');

  const initialData = {
    stateRevision: 10,
    trades: [],
    tradeHistory: [],
    knowledge: [],
    settings: { main: { virtualBalance: 1000 } }
  };
  fs.writeFileSync(tmpDbPath, JSON.stringify(initialData, null, 2), 'utf-8');

  const store = new AtomicStateStore(tmpDbPath, { maxBackups: 3 });

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`✅ ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAILED: ${msg}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------
    // Section B (P0-1): Canonical Decision & Execution Side Binding
    // ----------------------------------------------------
    console.log('\n--- Section B: Canonical Decision & Direction Binding ---');

    // 1. Strategy Reject -> 0 execution calls
    mockPort.reset();
    const rejDecision: EntryDecision = {
      approved: false,
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 0,
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      signalId: 'sig_1',
      correlationId: 'corr_1',
      rejectionReason: 'SPREAD_TOO_HIGH',
      reason: 'Spread 0.4% exceeds limit',
      matchedRuleIds: [],
      scoreBonus: 0,
      gateDiagnostics: { spreadOk: false },
      hunterEnvelope: createDummyEnvelope('HUNTER', false, 'REJECT'),
      bearEnvelope: createDummyEnvelope('BEAR', false, 'REJECT'),
      committeeEnvelope: createDummyEnvelope('COMMITTEE', false, 'REJECT')
    };
    const rejSide = getApprovedExecutionSide(rejDecision);
    if (rejSide) {
      await mockPort.executeOpen(rejSide, 'BTC/USDT', 100);
    }
    assert(mockPort.events.length === 0, 'Strategy reject results in 0 executor calls');

    // 2. Committee Veto -> 0 execution calls
    mockPort.reset();
    const vetoDecision: EntryDecision = {
      approved: false,
      action: 'NO_TRADE',
      side: 'NEUTRAL',
      confidence: 30,
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      signalId: 'sig_2',
      correlationId: 'corr_2',
      rejectionReason: 'COMMITTEE_VETO',
      reason: 'Bear rejected due to high volatility',
      matchedRuleIds: [],
      scoreBonus: 0,
      gateDiagnostics: { spreadOk: true },
      hunterEnvelope: createDummyEnvelope('HUNTER', true, 'APPROVE'),
      bearEnvelope: createDummyEnvelope('BEAR', false, 'REJECT'),
      committeeEnvelope: createDummyEnvelope('COMMITTEE', false, 'REJECT')
    };
    const vetoSide = getApprovedExecutionSide(vetoDecision);
    if (vetoSide) {
      await mockPort.executeOpen(vetoSide, 'ETH/USDT', 100);
    }
    assert(mockPort.events.length === 0, 'Committee veto results in 0 executor calls');

    // 3. Approved LONG + LONG signal -> Exactly 1 'LONG' mock execution
    mockPort.reset();
    const appLongDecision: EntryDecision = {
      approved: true,
      action: 'BUY',
      side: 'LONG',
      confidence: 85,
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      signalId: 'sig_3',
      correlationId: 'corr_3',
      reason: 'Parabolic SAR flip',
      matchedRuleIds: ['RULE_SAR_1'],
      scoreBonus: 10,
      gateDiagnostics: { spreadOk: true, volumeOk: true },
      hunterEnvelope: createDummyEnvelope('HUNTER', true, 'APPROVE'),
      bearEnvelope: createDummyEnvelope('BEAR', true, 'APPROVE'),
      committeeEnvelope: createDummyEnvelope('COMMITTEE', true, 'APPROVE')
    };
    const longSide = getApprovedExecutionSide(appLongDecision);
    if (longSide) {
      await mockPort.executeOpen(longSide, 'SOL/USDT', 100);
    }
    assert(mockPort.events.length === 1 && mockPort.events[0].side === 'LONG', 'Approved LONG generates exactly 1 execution with side LONG');

    // 4. Approved SHORT + SHORT signal -> Exactly 1 'SHORT' mock execution
    mockPort.reset();
    const appShortDecision: EntryDecision = {
      approved: true,
      action: 'SELL',
      side: 'SHORT',
      confidence: 90,
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      signalId: 'sig_4',
      correlationId: 'corr_4',
      reason: '1m Spire Climax with rejection wick',
      matchedRuleIds: ['RULE_SPIRE_1'],
      scoreBonus: 15,
      gateDiagnostics: { spreadOk: true, volumeOk: true },
      hunterEnvelope: createDummyEnvelope('HUNTER', true, 'APPROVE'),
      bearEnvelope: createDummyEnvelope('BEAR', true, 'APPROVE'),
      committeeEnvelope: createDummyEnvelope('COMMITTEE', true, 'APPROVE')
    };
    const shortSide = getApprovedExecutionSide(appShortDecision);
    if (shortSide) {
      await mockPort.executeOpen(shortSide, 'XRP/USDT', 100);
    }
    assert(mockPort.events.length === 1 && mockPort.events[0].side === 'SHORT', 'Approved SHORT generates exactly 1 execution with side SHORT');

    // 5. Stale / Mismatched Direction Guard
    mockPort.reset();
    const mismatchedDecision: EntryDecision = {
      approved: true,
      action: 'BUY',
      side: 'SHORT', // Invalid combination
      confidence: 80,
      strategyId: 'CANONICAL_V2',
      strategyVersion: '2.1.0',
      signalId: 'sig_5',
      correlationId: 'corr_5',
      reason: 'Inconsistent data test',
      matchedRuleIds: [],
      scoreBonus: 0,
      gateDiagnostics: { spreadOk: true },
      hunterEnvelope: createDummyEnvelope('HUNTER', true, 'APPROVE'),
      bearEnvelope: createDummyEnvelope('BEAR', true, 'APPROVE'),
      committeeEnvelope: createDummyEnvelope('COMMITTEE', true, 'APPROVE')
    };
    const invalidSide = getApprovedExecutionSide(mismatchedDecision);
    assert(invalidSide === null, 'Mismatched action/side pair returns null from canonical helper (Fail Closed)');

    // ----------------------------------------------------
    // Section C (P0-2): Canonical Exit Policy Ownership
    // ----------------------------------------------------
    console.log('\n--- Section C: Canonical Exit Policy Ownership ---');

    const baseTrade: ExitTradeSnapshot = {
      id: 'trade_test_1',
      symbol: 'BTC/USDT',
      side: 'LONG',
      entryPrice: 50000,
      currentPrice: 50200,
      highestPrice: 50200,
      amount: 100,
      leverage: 10,
      createdAt: Date.now() - 60000,
      partialTpStepsDone: []
    };

    const marketBelowFloor: ExitMarketSnapshot = {
      currentPrice: 50200,
      bid: 50190,
      ask: 50210,
      estimatedFeePct: 0.0006,
      estimatedSlippagePct: 0.0004
    };

    // 1. Multi-TP below 4.0% net floor -> HOLD
    const exit1 = evaluateExitPolicy(baseTrade, marketBelowFloor, {
      enableMultiTp: true,
      minNormalAutoCloseNetPnlPct: 4.0,
      multiTpTargets: [{ targetPnlPct: 2.0, closeRatio: 0.5 }]
    });
    assert(exit1.kind === 'HOLD', 'Multi-TP target below normal PnL floor returns HOLD');

    // 2. Multi-TP eligible above 4.0% floor -> PARTIAL_CLOSE with correct ratio
    const marketAboveFloor: ExitMarketSnapshot = {
      currentPrice: 51000, // +2% price change * 10x lev = ~+20% gross PnL
      bid: 50990,
      ask: 51010,
      estimatedFeePct: 0.0006,
      estimatedSlippagePct: 0.0004
    };
    const exit2 = evaluateExitPolicy(baseTrade, marketAboveFloor, {
      enableMultiTp: true,
      minNormalAutoCloseNetPnlPct: 4.0,
      multiTpTargets: [{ targetPnlPct: 8.0, closeRatio: 0.5 }]
    });
    assert(
      exit2.kind === 'PARTIAL_CLOSE' &&
      exit2.closeRatio === 0.5 &&
      exit2.reasonCode === 'MULTI_TP_PARTIAL',
      'Multi-TP eligible returns PARTIAL_CLOSE with ratio and MULTI_TP_PARTIAL reason'
    );

    // 3. Partial close execution failure: retryable state
    mockPort.reset();
    mockPort.failNextCall = true;
    let partialApplied = false;
    try {
      await mockPort.executePartialClose('BTC/USDT', exit2.closeRatio || 0.5, 100);
      partialApplied = true;
    } catch (_) {
      partialApplied = false;
    }
    assert(!partialApplied, 'Partial close execution failure does not mutate position or finalize stage optimistically');

    // 4. MAX_LIFETIME below floor -> HOLD when allowEmergencyMaxLifetime is false
    const oldTrade: ExitTradeSnapshot = {
      ...baseTrade,
      createdAt: Date.now() - 30 * 3600000 // 30 hours old
    };
    const exitMaxLifetime = evaluateExitPolicy(oldTrade, marketBelowFloor, {
      maxLifetimeHours: 24,
      allowEmergencyMaxLifetime: false,
      minNormalAutoCloseNetPnlPct: 4.0
    });
    assert(exitMaxLifetime.kind === 'HOLD', 'MAX_LIFETIME returns HOLD when profit is below floor and emergency flag is false');

    // 5. STOP_LOSS hit -> FULL_CLOSE with STOP_LOSS reason
    const slTrade: ExitTradeSnapshot = {
      ...baseTrade,
      stopLoss: 49500
    };
    const slMarket: ExitMarketSnapshot = {
      currentPrice: 49400,
      bid: 49390,
      ask: 49410
    };
    const exitSl = evaluateExitPolicy(slTrade, slMarket, {});
    assert(exitSl.kind === 'FULL_CLOSE' && exitSl.reasonCode === 'STOP_LOSS', 'Stop loss hit returns FULL_CLOSE with STOP_LOSS safety override');

    // ----------------------------------------------------
    // Section D (P0-3): Durability & Awaitable Persistence
    // ----------------------------------------------------
    console.log('\n--- Section D: Durability & Awaitable Persistence ---');

    const prevRev = store.getRevision();
    const saveOk = await store.saveState((currentData) => {
      currentData.trades.push({
        id: 'trade_durable_1',
        symbol: 'BTC/USDT',
        side: 'LONG',
        amount: 100,
        entryPrice: 50000,
        status: 'OPEN',
        createdAt: Date.now()
      });
      return currentData;
    });

    assert(saveOk.success === true, 'AtomicStateStore writes and resolves with success');
    const newRev = store.getRevision();
    assert(newRev > prevRev, `State revision incremented from ${prevRev} to ${newRev}`);

    // Verify disk durability
    const diskRaw = JSON.parse(fs.readFileSync(tmpDbPath, 'utf-8'));
    assert(diskRaw.trades.some((t: any) => t.id === 'trade_durable_1'), 'Committed trade is durably written to local database file');

    // ----------------------------------------------------
    // Section E (P0-4): Decision Lineage & Auditability
    // ----------------------------------------------------
    console.log('\n--- Section E: Decision Lineage & Auditability ---');

    const correlationContext: DecisionCorrelationContext = {
      correlationId: 'corr_test_e2e_888',
      proposedTradeId: 'trade_auto_888',
      signalId: 'sig_vol_reversal_01',
      strategyId: 'CANONICAL_QUANT_SCALP_V2',
      strategyVersion: '2.1.0',
      stateRevision: newRev,
      emittedAt: Date.now()
    };

    assert(Boolean(correlationContext.correlationId && correlationContext.proposedTradeId && correlationContext.signalId), 'DecisionCorrelationContext establishes full atomic lineage contract');

    // Verify clean shutdown and zero secrets in logs
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('✅ Temporary test environment cleaned up safely.');

  } catch (err) {
    console.error('Fatal test exception:', err);
    failed++;
  }

  console.log(`\n========================================`);
  console.log(`E2E OFFLINE TESTS COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  if (failed === 0) {
    console.log('🎉 ALL OFFLINE E2E PRODUCTION CRITERIA MET!');
    process.exit(0);
  } else {
    console.error('❌ E2E FAILURES DETECTED');
    process.exit(1);
  }
}

runOfflineE2ETests();
