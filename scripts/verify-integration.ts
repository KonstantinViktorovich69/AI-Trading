import fs from 'fs';
import path from 'path';
import { AtomicStateStore } from '../server/atomicDbSaver.ts';
import { evaluateStrategySignal, validateMarketDataCompleteness } from '../server/services/strategyEngine.ts';
import { evaluateExitPolicy, calculateNetPnlPct } from '../server/services/exitPolicy.ts';
import { isOperationalTrade, calculateOperationalWinRate } from '../server/services/tradeMetrics.ts';

async function runIntegrationVerification() {
  console.log('=== RUNNING INTEGRATION VERIFICATION ===\n');
  let failures = 0;

  // 1. Verify AtomicStateStore
  console.log('1. Testing AtomicStateStore...');
  const testDbPath = path.join(process.cwd(), 'data', 'test_atomic_db.json');
  try {
    const store = new AtomicStateStore(testDbPath);
    const initialRev = store.getRevision();
    
    const saveResult = await store.saveState({
      test: true,
      trades: [],
      knowledge: []
    });

    if (!saveResult) {
      console.error('❌ AtomicStateStore saveState failed');
      failures++;
    } else {
      const loaded = store.loadState<{ test?: boolean; stateRevision?: number }>({});
      if (loaded.test && loaded.stateRevision && loaded.stateRevision > initialRev) {
        console.log(`✅ AtomicStateStore write/load verified (Revision: ${loaded.stateRevision})`);
      } else {
        console.error('❌ AtomicStateStore loaded data mismatch or missing revision');
        failures++;
      }
    }
  } catch (err: any) {
    console.error('❌ AtomicStateStore exception:', err.message);
    failures++;
  } finally {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (_) {}
    }
  }

  // 2. Verify StrategyEngine Fail-Closed & Signal Logic
  console.log('\n2. Testing Canonical Strategy Engine (Fail-Closed & Gate Checks)...');
  try {
    const incompleteCtx: any = {
      symbol: 'BTCUSDT',
      marketType: 'FUTURES',
      tradingMode: 'FUTURES',
      price: NaN, // Invalid price
      high: 100,
      low: 90,
      open: 95,
      vwap: 95,
      sar: 96,
      rsi: 50,
      change24h: 5,
      volume24h: 100000,
      avgVolume: 80000
    };

    const isDataValid = validateMarketDataCompleteness(incompleteCtx);
    const incompleteDecision = evaluateStrategySignal(incompleteCtx);

    if (!isDataValid && incompleteDecision.action === 'NO_TRADE' && incompleteDecision.rejectionReason === 'DATA_INCOMPLETE') {
      console.log('✅ StrategyEngine correctly rejected incomplete market data (Fail Closed)');
    } else {
      console.error('❌ StrategyEngine failed to reject incomplete market data');
      failures++;
    }

    // Test High Spread Gate
    const highSpreadCtx: any = {
      symbol: 'ETHUSDT',
      marketType: 'FUTURES',
      tradingMode: 'FUTURES',
      price: 3000,
      high: 3100,
      low: 2900,
      open: 2950,
      vwap: 3000,
      sar: 3050,
      rsi: 75,
      change24h: 8.5,
      volume24h: 200000,
      avgVolume: 150000,
      bidSpreadPct: 0.02 // 2.0% spread exceeds max 0.8%
    };

    const spreadDecision = evaluateStrategySignal(highSpreadCtx);
    if (spreadDecision.action === 'NO_TRADE' && spreadDecision.rejectionReason === 'HIGH_SPREAD') {
      console.log('✅ StrategyEngine correctly rejected high spread market state');
    } else {
      console.error('❌ StrategyEngine failed to reject high spread state');
      failures++;
    }
  } catch (err: any) {
    console.error('❌ StrategyEngine exception:', err.message);
    failures++;
  }

  // 3. Verify Exit Policy Net PnL Floor Threshold (4.00%)
  console.log('\n3. Testing Exit Policy Net PnL Protection Floor (4.00%)...');
  try {
    const tradeSnapshot: any = {
      id: 'trade_1',
      symbol: 'SOLUSDT',
      side: 'SHORT',
      entryPrice: 150,
      highestPrice: 150.2,
      lowestPrice: 149.2, // Peak unrealized profit ~2.6% (< 4.0%)
      amount: 100,
      leverage: 5,
      createdAt: Date.now() - 3600 * 1000 // 1 hour old
    };

    // Current price gives ~1.6% net PnL (below 4% threshold)
    const marketSnapshotLowProfit: any = {
      currentPrice: 149.5,
      bid: 149.5,
      ask: 149.55,
      estimatedFeePct: 0.0006,
      estimatedSlippagePct: 0.0004
    };

    const decisionLowPnl = evaluateExitPolicy(tradeSnapshot, marketSnapshotLowProfit);
    if (decisionLowPnl.kind === 'HOLD') {
      console.log(`✅ ExitPolicy correctly held position when Net PnL (+${decisionLowPnl.currentNetPnlPct}%) < 4.00% threshold`);
    } else {
      console.error(`❌ ExitPolicy auto-closed position below 4.00% threshold (Action: ${decisionLowPnl.kind})`);
      failures++;
    }
  } catch (err: any) {
    console.error('❌ Exit Policy exception:', err.message);
    failures++;
  }

  // 4. Verify Trade Metrics Operational Filters
  console.log('\n4. Testing Operational Trade Metrics Filtering...');
  try {
    const seedTrade: any = { id: 't1', pnl: 15, pnlPercent: 15, dataOrigin: 'SEED', status: 'CLOSED' };
    const operationalTradeWin: any = { id: 't2', pnl: 12, pnlPercent: 12, dataOrigin: 'PAPER', status: 'CLOSED' };
    const operationalTradeLoss: any = { id: 't3', pnl: -5, pnlPercent: -5, dataOrigin: 'PAPER', status: 'CLOSED' };

    if (!isOperationalTrade(seedTrade) && isOperationalTrade(operationalTradeWin)) {
      console.log('✅ TradeMetrics correctly excludes SEED data from operational win rate calculation');
    } else {
      console.error('❌ TradeMetrics failed to filter SEED data');
      failures++;
    }

    const winRateResult = calculateOperationalWinRate([seedTrade, operationalTradeWin, operationalTradeLoss]);
    if (winRateResult.total === 2 && winRateResult.winRate === 50) {
      console.log(`✅ WinRate correctly computed on operational trades: 50% (${winRateResult.total} trades)`);
    } else {
      console.error(`❌ WinRate calculation mismatch: total=${winRateResult.total}, rate=${winRateResult.winRate}%`);
      failures++;
    }
  } catch (err: any) {
    console.error('❌ TradeMetrics exception:', err.message);
    failures++;
  }

  console.log('\n========================================');
  if (failures === 0) {
    console.log('🎉 ALL INTEGRATION TESTS PASSED VERIFICATION!');
    process.exit(0);
  } else {
    console.error(`❌ ${failures} VERIFICATION TESTS FAILED.`);
    process.exit(1);
  }
}

runIntegrationVerification();
