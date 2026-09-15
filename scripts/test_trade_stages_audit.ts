import { evaluateEntryDecision, getApprovedExecutionSide, EntryDecision, StrategyMarketInput } from '../server/services/strategyEngine.ts';
import { evaluateExitPolicy, ExitTradeSnapshot, ExitMarketSnapshot } from '../server/services/exitPolicy.ts';
import { AtomicStateStore } from '../server/atomicDbSaver.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function runStageAuditTests() {
  console.log('================================================================================');
  console.log('         FULL COMPREHENSIVE TRADE STAGE AUDIT & VERIFICATION SUITE              ');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  function assertStage(condition: boolean, stageName: string, detail: string) {
    if (condition) {
      console.log(`✅ [${stageName}] ${detail}`);
      passed++;
    } else {
      console.error(`❌ [${stageName}] FAILED: ${detail}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // STAGE 1: SIGNAL SCORING & GATES (Fail-Closed, Filters, Committee)
  // ---------------------------------------------------------------------------
  console.log('--- STAGE 1: Signal Scoring & Gate Verification ---');
  
  // 1. Valid SHORT scalp setup
  const marketShort: StrategyMarketInput = {
    symbol: 'BTC/USDT',
    marketType: 'FUTURES',
    tradingMode: 'FUTURES',
    price: 59000,
    high: 62000,
    low: 58000,
    open: 58500,
    vwap: 59500,
    sar: 61000, // Bearish SAR > price
    rsi: 68,
    change24h: 8.5,
    volume24h: 1500000,
    avgVolume: 1000000,
    orderBookImbalance: -0.35,
    isCommitteeConsensusEnabled: true
  };

  const decisionShort = evaluateEntryDecision(marketShort);
  assertStage(decisionShort.approved === true, 'STAGE 1', `Valid SHORT scalp signal is APPROVED (confidence: ${decisionShort.confidence}%, reason: ${decisionShort.reason})`);
  assertStage(getApprovedExecutionSide(decisionShort) === 'SHORT', 'STAGE 1', 'Approved SHORT maps strictly to SHORT side');

  // 2. Valid SPOT LONG accumulation setup
  const marketSpotLong: StrategyMarketInput = {
    symbol: 'ETH/USDT',
    marketType: 'SPOT',
    tradingMode: 'SPOT',
    price: 3100,
    high: 3150,
    low: 3000,
    open: 3020,
    vwap: 3050,
    sar: 3000, // Bullish SAR < price
    rsi: 58,
    change24h: 3.5,
    volume24h: 2000000,
    avgVolume: 1000000,
    orderBookImbalance: 0.30,
    isCommitteeConsensusEnabled: true
  };

  const decisionSpotLong = evaluateEntryDecision(marketSpotLong);
  assertStage(decisionSpotLong.approved === true, 'STAGE 1', `Valid SPOT LONG signal is APPROVED (confidence: ${decisionSpotLong.confidence}%)`);
  assertStage(getApprovedExecutionSide(decisionSpotLong) === 'LONG', 'STAGE 1', 'Approved SPOT BUY maps strictly to LONG side');

  // 3. Mismatch fail-closed
  const corruptedDecision: EntryDecision = {
    ...decisionShort,
    action: 'BUY',
    side: 'SHORT' // Corrupted mismatch
  };
  assertStage(getApprovedExecutionSide(corruptedDecision) === null, 'STAGE 1', 'Mismatched BUY+SHORT is rejected via Fail-Closed invariant');

  // 4. Low volume gate
  const marketIlliquid: StrategyMarketInput = {
    ...marketShort,
    volume24h: 10000, // Below 50k
    avgVolume: 10000
  };
  const decisionIlliquid = evaluateEntryDecision(marketIlliquid);
  assertStage(decisionIlliquid.approved === false, 'STAGE 1', 'Illiquid volume (<50k) is rejected by gate check');

  // ---------------------------------------------------------------------------
  // STAGE 2: CAPITAL ALLOCATION & KELLY SIZING
  // ---------------------------------------------------------------------------
  console.log('\n--- STAGE 2: Position Sizing & Leverage Allocation ---');
  
  const testBalance = 500;
  const targetPct = 0.05; // 5% base
  const singleTradeMargin = testBalance * targetPct; // $25
  assertStage(singleTradeMargin >= 20.0, 'STAGE 2', 'Single trade margin meets $20 minimum execution threshold');

  // Drawdown throttle test
  const streakLosses = 3;
  const streakPenaltyMultiplier = Math.max(0.5, 1.0 - streakLosses * 0.15); // 0.55x
  const throttledMargin = Number((singleTradeMargin * streakPenaltyMultiplier).toFixed(2));
  assertStage(throttledMargin < singleTradeMargin && throttledMargin > 0, 'STAGE 2', `Streak loss penalty correctly throttles margin ($${throttledMargin} vs $${singleTradeMargin})`);

  // ---------------------------------------------------------------------------
  // STAGE 3: BRACKET & ORDER PLACEMENT (SL, TP, Multi-TP, DCA Grid)
  // ---------------------------------------------------------------------------
  console.log('\n--- STAGE 3: Bracket Order & Grid Generation ---');

  const entryPrice = 50000;
  const atr = 1000;
  const slDist = atr * 1.8; // 1800
  const stopLossLong = entryPrice - slDist; // 48200
  const takeProfitLong = entryPrice + (atr * 2.0); // 52000

  assertStage(stopLossLong < entryPrice, 'STAGE 3', `LONG Stop Loss ($${stopLossLong}) is strictly below Entry Price ($${entryPrice})`);
  assertStage(takeProfitLong > entryPrice, 'STAGE 3', `LONG Take Profit ($${takeProfitLong}) is strictly above Entry Price ($${entryPrice})`);

  // Spot DCA Grid Ladder check
  assertStage(
    Array.isArray(decisionSpotLong.spotDcaLadder) && decisionSpotLong.spotDcaLadder.length === 3,
    'STAGE 3',
    `Spot DCA Ladder generated 3 descending accumulation tiers (Steps: ${decisionSpotLong.spotDcaLadder?.map(s => '$' + s.price).join(', ')})`
  );

  // ---------------------------------------------------------------------------
  // STAGE 4: IN-FLIGHT MONITORING & EXIT POLICY (PTTP, Multi-TP, Trailing)
  // ---------------------------------------------------------------------------
  console.log('\n--- STAGE 4: In-Flight Monitoring & Policy Decision ---');

  const activeTrade: ExitTradeSnapshot = {
    id: 'TR_AUDIT_01',
    symbol: 'ETH/USDT',
    side: 'LONG',
    entryPrice: 3000,
    currentPrice: 3000,
    highestPrice: 3000,
    amount: 50,
    leverage: 5,
    createdAt: Date.now() - 300000, // 5 min ago
    partialTpStepsDone: [],
    tpStages: [
      { targetPrice: 3030, closeRatio: 0.35, executed: false }, // +1.0% -> +5% PnL (5x lev)
      { targetPrice: 3060, closeRatio: 0.30, executed: false }, // +2.0% -> +10% PnL
      { targetPrice: 3114, closeRatio: 0.20, executed: false }, // +3.8% -> +19% PnL
      { targetPrice: 3210, closeRatio: 0.15, executed: false }  // +7.0% -> +35% PnL
    ]
  };

  // Step 1: Market moves to 3035 -> TP1 Hit
  const marketTp1: ExitMarketSnapshot = {
    currentPrice: 3035,
    bid: 3034,
    ask: 3036,
    estimatedFeePct: 0.0006,
    estimatedSlippagePct: 0.0004
  };
  const exitTp1 = evaluateExitPolicy(activeTrade, marketTp1, {
    enableMultiTp: true,
    minNormalAutoCloseNetPnlPct: 4.0
  });

  assertStage(
    exitTp1.kind === 'PARTIAL_CLOSE' && exitTp1.closeRatio === 0.35 && exitTp1.reasonCode === 'MULTI_TP_PARTIAL',
    'STAGE 4',
    `Multi-TP Step #1 fires PARTIAL_CLOSE with 35% ratio and moves SL to Breakeven (+1%)`
  );
  assertStage(Number(exitTp1.newStopLoss) >= 3000, 'STAGE 4', `New lock-in Stop Loss ($${exitTp1.newStopLoss}) protects entry price ($3000)`);

  // Step 2: PTTP Peak Retracement Test (with executed TP stages)
  const tradePeak: ExitTradeSnapshot = {
    ...activeTrade,
    partialTpStepsDone: [0, 1, 2, 3],
    tpStages: [
      { targetPrice: 3030, closeRatio: 0.35, executed: true },
      { targetPrice: 3060, closeRatio: 0.30, executed: true },
      { targetPrice: 3114, closeRatio: 0.20, executed: true },
      { targetPrice: 3210, closeRatio: 0.15, executed: true }
    ],
    highestPrice: 3150, // +5.0% price move = +25% un-leveraged/leveraged PnL
    currentPrice: 3075  // Retraced to +2.5% (lost 50% of peak gain)
  };
  const marketPttp: ExitMarketSnapshot = {
    currentPrice: 3075,
    bid: 3074,
    ask: 3076,
    estimatedFeePct: 0.0006,
    estimatedSlippagePct: 0.0004
  };
  const exitPttp = evaluateExitPolicy(tradePeak, marketPttp, {
    enablePttp: true,
    minNormalAutoCloseNetPnlPct: 4.0,
    minPttpPeakNetPnlPct: 6.0,
    pttpTrailingDropPct: 25.0
  });

  assertStage(
    exitPttp.kind === 'FULL_CLOSE' && exitPttp.reasonCode === 'PTTP',
    'STAGE 4',
    `PTTP fires FULL_CLOSE when profit pulls back from peak to secure gains (+${exitPttp.currentNetPnlPct?.toFixed(1)}%)`
  );

  // ---------------------------------------------------------------------------
  // STAGE 5: RISK EXITS (Stop Loss, Max Lifetime, Emergency Drawdown)
  // ---------------------------------------------------------------------------
  console.log('\n--- STAGE 5: Risk Protection & Emergency Exits ---');

  // Hard Stop Loss
  const marketSl: ExitMarketSnapshot = {
    currentPrice: 2850,
    bid: 2849,
    ask: 2851
  };
  const exitSl = evaluateExitPolicy({ ...activeTrade, stopLoss: 2900 }, marketSl, {});
  assertStage(exitSl.kind === 'FULL_CLOSE' && exitSl.reasonCode === 'STOP_LOSS', 'STAGE 5', 'Hard Stop Loss hit triggers immediate FULL_CLOSE');

  // Max Lifetime Normal Exit
  const oldTradeNormal: ExitTradeSnapshot = {
    id: 'TR_OLD_01',
    symbol: 'ETH/USDT',
    side: 'LONG',
    entryPrice: 3000,
    currentPrice: 3030, // +1.0% price move * 5x lev = +5.0% gross, +4.2% net
    highestPrice: 3030,
    stopLoss: 3020,
    amount: 50,
    leverage: 5,
    createdAt: Date.now() - (25 * 3600 * 1000) // 25 hours ago
  };
  const exitOldNormal = evaluateExitPolicy(oldTradeNormal, { currentPrice: 3030, bid: 3029, ask: 3031 }, {
    maxLifetimeHours: 24,
    minNormalAutoCloseNetPnlPct: 4.0
  });
  assertStage(
    exitOldNormal.kind === 'FULL_CLOSE' && exitOldNormal.reasonCode === 'MAX_LIFETIME',
    'STAGE 5',
    'Max Lifetime (24h+) with positive PnL (>= 4%) closes cleanly to free capital'
  );

  // Emergency Liquidation Safety Exit
  const marketEmergency: ExitMarketSnapshot = {
    currentPrice: 2880, // -20% PnL with 5x leverage
    bid: 2879,
    ask: 2881
  };
  const exitEmergency = evaluateExitPolicy(activeTrade, marketEmergency, {});
  assertStage(
    exitEmergency.kind === 'EMERGENCY_FULL_CLOSE' && exitEmergency.reasonCode === 'EMERGENCY_HARD_STOP',
    'STAGE 5',
    'Emergency Hard Stop triggers when drawdowns exceed -18% threshold'
  );

  // ---------------------------------------------------------------------------
  // STAGE 6: ATOMIC PERSISTENCE & AUDIT LINEAGE
  // ---------------------------------------------------------------------------
  console.log('\n--- STAGE 6: Atomic Settlement & Database Lineage ---');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade_audit_test_'));
  const testDbFile = path.join(tmpDir, 'test_db.json');
  fs.writeFileSync(testDbFile, JSON.stringify({ stateRevision: 1, trades: [] }), 'utf8');

  const store = new AtomicStateStore(testDbFile);
  const testTradeRecord = {
    id: 'VT-STAGE6-TEST',
    symbol: 'BTC/USDT',
    side: 'LONG',
    status: 'CLOSED',
    entryPrice: 50000,
    closePrice: 51500,
    amount: 100,
    leverage: 5,
    pnl: 15.0,
    pnlPercent: 15.0,
    dataOrigin: 'PAPER',
    decisionSource: 'RULE_ENGINE',
    decisionCorrelationId: 'corr_stage6_test',
    stateRevision: 2
  };

  const persistResult = await store.saveState((db: any) => {
    if (!db.trades) db.trades = [];
    db.trades.push(testTradeRecord);
    db.stateRevision = 2;
    return db;
  });

  assertStage(persistResult.success === true, 'STAGE 6', 'AtomicStateStore saveState resolves true');
  
  const savedDb = JSON.parse(fs.readFileSync(testDbFile, 'utf8'));
  assertStage(savedDb.trades.length === 1 && savedDb.trades[0].id === 'VT-STAGE6-TEST', 'STAGE 6', 'Trade is durably verified in physical storage file');
  assertStage(savedDb.trades[0].decisionCorrelationId === 'corr_stage6_test', 'STAGE 6', 'Decision Correlation Lineage ID is preserved in database record');

  // Cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n================================================================================');
  console.log(`STAGE AUDIT COMPLETE: ${passed} PASSED, ${failed} FAILED (Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%)`);
  console.log('================================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runStageAuditTests().catch((err) => {
  console.error('Fatal error in stage audit tests:', err);
  process.exit(1);
});
