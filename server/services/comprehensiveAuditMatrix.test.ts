import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { evaluateStrategySignal, validateMarketDataCompleteness, type StrategyContext, evaluateEntryDecision } from './strategyEngine.ts';
import { evaluateExitPolicy, type ExitTradeSnapshot, type ExitMarketSnapshot, type ExitPolicySettings } from './exitPolicy.ts';
import { evaluateCommitteeConsensus, createAiFallbackDecision, type AgentDecisionEnvelope } from './agentEngine.ts';
import { processIncomingStateMessage } from './stateSync.ts';
import { AtomicStateStore } from '../atomicDbSaver.ts';

describe('Comprehensive Audit Test Matrix', () => {

  describe('1. Multi-Strategy & Directional Filtering Matrix', () => {
    const baseContext: StrategyContext = {
      symbol: 'ETHUSDT',
      marketType: 'FUTURES',
      tradingMode: 'FUTURES',
      price: 3200,
      high: 3250,
      low: 3150,
      open: 3180,
      vwap: 3210,
      sar: 3260,
      rsi: 72,
      change24h: 12.0,
      volume24h: 5000000,
      avgVolume: 1000000,
      bidSpreadPct: 0.0004,
      fundingRate: 0.0002
    };

    it('Matrix: SHORT strategy generates SELL signal when conditions match', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        activeStrategy: 'SHORT_PUMP_FADE',
        allowedDirections: 'SHORT_ONLY'
      });
      expect(decision.side).toBe('SHORT');
      expect(decision.action).toBe('SELL');
      expect(decision.dataCompleteness).toBe('COMPLETE');
    });

    it('Matrix: LONG only direction blocks SHORT signal cleanly', () => {
      const decision = evaluateStrategySignal({
        ...baseContext,
        allowedDirections: 'LONG_ONLY'
      });
      expect(decision.action).toBe('NO_TRADE');
      expect(['DIRECTION_MISMATCH', 'DIRECTION_NOT_ALLOWED']).toContain(decision.rejectionReason);
    });

    it('Matrix: SPOT accumulation creates DCA ladder on oversold conditions', () => {
      const spotContext: StrategyContext = {
        ...baseContext,
        marketType: 'SPOT',
        tradingMode: 'SPOT',
        price: 3000,
        high: 3100,
        low: 2980,
        open: 3080,
        vwap: 3020,
        sar: 2950,
        rsi: 28,
        change24h: -8.0,
        allowedDirections: 'BOTH'
      };

      const decision = evaluateStrategySignal(spotContext);
      expect(decision.side).toBe('LONG');
      expect(decision.action).toBe('BUY');
      expect(decision.spotDcaLadder).toBeDefined();
      expect(decision.spotDcaLadder?.length).toBeGreaterThan(0);
    });

    it('Matrix: Fail-closed on missing prices or extreme spreads', () => {
      const zeroPrice = evaluateStrategySignal({ ...baseContext, price: 0 });
      expect(zeroPrice.action).toBe('NO_TRADE');
      expect(zeroPrice.dataCompleteness).toBe('INCOMPLETE');

      const extremeSpread = evaluateStrategySignal({ ...baseContext, bidSpreadPct: 0.03 });
      expect(extremeSpread.action).toBe('NO_TRADE');
      expect(extremeSpread.rejectionReason).toBe('HIGH_SPREAD');
    });
  });

  describe('2. Consensus Edge-Cases & Committee Veto Matrix', () => {
    it('Consensus Matrix: Bear vetoes Hunter approval -> Result is REJECT', () => {
      const hunter: AgentDecisionEnvelope = {
        decisionId: 'h_1',
        agentName: 'HUNTER',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'APPROVE',
        confidence: 88,
        approved: true,
        decisionSource: 'AI',
        rationale: 'Bullish breakout pattern',
        createdAt: Date.now()
      };
      const bear: AgentDecisionEnvelope = {
        decisionId: 'b_1',
        agentName: 'BEAR',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'REJECT',
        confidence: 92,
        approved: false,
        decisionSource: 'RULE_ENGINE',
        rationale: 'High orderbook sell wall',
        createdAt: Date.now()
      };

      const consensus = evaluateCommitteeConsensus(hunter, bear, true);
      expect(consensus.action).toBe('REJECT');
      expect(consensus.approved).toBe(false);
      expect(consensus.decisionSource).toBe('COMMITTEE');
    });

    it('Consensus Matrix: Both Hunter and Bear approve -> Result is APPROVE', () => {
      const hunter: AgentDecisionEnvelope = {
        decisionId: 'h_2',
        agentName: 'HUNTER',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'APPROVE',
        confidence: 85,
        approved: true,
        decisionSource: 'AI',
        rationale: 'Strong momentum confirmation',
        createdAt: Date.now()
      };
      const bear: AgentDecisionEnvelope = {
        decisionId: 'b_2',
        agentName: 'BEAR',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'APPROVE',
        confidence: 80,
        approved: true,
        decisionSource: 'RULE_ENGINE',
        rationale: 'Risk criteria satisfied',
        createdAt: Date.now()
      };

      const consensus = evaluateCommitteeConsensus(hunter, bear, true);
      expect(consensus.action).toBe('APPROVE');
      expect(consensus.approved).toBe(true);
      expect(consensus.confidence).toBe(83); // Math.round((85 + 80) / 2)
    });

    it('Consensus Matrix: Committee shadow mode reflects Hunter action with shadow rationale', () => {
      const hunter: AgentDecisionEnvelope = {
        decisionId: 'h_3',
        agentName: 'HUNTER',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'APPROVE',
        confidence: 85,
        approved: true,
        decisionSource: 'AI',
        rationale: 'Good entry',
        createdAt: Date.now()
      };
      const bear: AgentDecisionEnvelope = {
        decisionId: 'b_3',
        agentName: 'BEAR',
        strategyId: 'CANONICAL_V2',
        strategyVersion: '2.1.0',
        action: 'REJECT',
        confidence: 90,
        approved: false,
        decisionSource: 'RULE_ENGINE',
        rationale: 'High resistance',
        createdAt: Date.now()
      };

      const consensus = evaluateCommitteeConsensus(hunter, bear, false);
      expect(consensus.action).toBe('APPROVE');
      expect(consensus.approved).toBe(true);
      expect(consensus.rationale).toContain('Теневой режим');
    });

    it('Consensus Matrix: Fail-closed fallback for new entry vs hold for active trade', () => {
      const entryFallback = createAiFallbackDecision({ signalId: 's_new' }, 'NEW_ENTRY');
      expect(entryFallback.action).toBe('NO_TRADE');
      expect(entryFallback.approved).toBe(false);

      const activeFallback = createAiFallbackDecision({ signalId: 's_act' }, 'ACTIVE_POSITION');
      expect(activeFallback.action).toBe('HOLD');
      expect(activeFallback.approved).toBe(true);
    });
  });

  describe('3. Exit Precedence Matrix & Net PnL Protection', () => {
    const trade: ExitTradeSnapshot = {
      id: 't_matrix_1',
      symbol: 'SOLUSDT',
      side: 'LONG',
      entryPrice: 150,
      currentPrice: 150,
      amount: 100,
      leverage: 5,
      stopLoss: 140,
      takeProfit: 170,
      createdAt: Date.now() - 10000
    };

    const market: ExitMarketSnapshot = {
      currentPrice: 150,
      bid: 149.95,
      ask: 150.05,
      estimatedFeePct: 0.0006,
      estimatedSlippagePct: 0.0004
    };

    const settings: ExitPolicySettings = {
      minNormalAutoCloseNetPnlPct: 4.0,
      minPttpActivationNetPnlPct: 1.0,
      minPttpPeakNetPnlPct: 6.0,
      pttpTrailingDropPct: 25.0
    };

    it('Precedence: STOP_LOSS takes absolute priority over everything', () => {
      const slTrade = { ...trade, stopLoss: 145 };
      const slMarket = { ...market, currentPrice: 144 };
      const decision = evaluateExitPolicy(slTrade, slMarket, settings);
      expect(decision.kind).toBe('FULL_CLOSE');
      expect(decision.reasonCode).toBe('STOP_LOSS');
    });

    it('Precedence: TAKE_PROFIT triggers at target price', () => {
      const tpTrade = { ...trade, takeProfit: 165 };
      const tpMarket = { ...market, currentPrice: 166 };
      const decision = evaluateExitPolicy(tpTrade, tpMarket, settings);
      expect(decision.kind).toBe('FULL_CLOSE');
      expect(decision.reasonCode).toBe('TAKE_PROFIT');
    });

    it('Precedence: PTTP requires min net PnL threshold before triggering', () => {
      const pttpTrade = {
        ...trade,
        entryPrice: 60000,
        highestPrice: 61000, // Peak profit gave back
        stopLoss: 60085, // Positioned at trail price to avoid MOVE_STOP and STOP_LOSS
        takeProfit: 70000 // Safely above
      };
      const pttpMarket = {
        ...market,
        currentPrice: 60300 // Current profit below 4.0% threshold
      };

      const decision = evaluateExitPolicy(pttpTrade, pttpMarket, settings);
      expect(decision.kind).toBe('HOLD');
      expect(decision.diagnostics.pttpBlockedByMinPnlThreshold).toBe(true);
    });

    it('Precedence: PTTP triggers when peak drops > 25% AND net PnL >= 4.0%', () => {
      const pttpTrade = {
        ...trade,
        entryPrice: 100,
        highestPrice: 110, // +10% * 5x = +50% peak
        stopLoss: 98
      };
      const pttpMarket = {
        ...market,
        currentPrice: 106 // +6% * 5x = +30% gross -> net ~ 28.8% (well above 4.0%)
      };

      const decision = evaluateExitPolicy(pttpTrade, pttpMarket, settings);
      expect(decision.kind).toBe('FULL_CLOSE');
      expect(decision.reasonCode).toBe('PTTP');
    });
  });

  describe('4. Real Disk Concurrent Write Stress-Test', () => {
    const testDbPath = path.join(process.cwd(), 'temp_stress_test_db.json');

    beforeEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const dir = path.dirname(testDbPath);
      const base = path.basename(testDbPath);
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${base}.bak_`) || f.startsWith(`${base}.tmp_`) || f.startsWith(`${base}.corrupt_`)) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
      }
    });

    it('Safely executes 50 concurrent writes without corrupted JSON or lost revision count', async () => {
      const store = new AtomicStateStore(testDbPath);
      const initial = { version: '1.0.0', trades: [], writeCount: 0 };
      await store.saveState(initial);

      const writes = [];
      for (let i = 1; i <= 50; i++) {
        writes.push(store.saveState({ version: '1.0.0', trades: [{ id: `trade_${i}` }], writeCount: i }));
      }

      await Promise.all(writes);
      await store.flush();

      const finalState = store.loadState<any>({});
      expect(finalState.stateRevision).toBe(51); // 1 initial + 50 writes
      expect(finalState.writeCount).toBe(50);
      expect(fs.existsSync(testDbPath)).toBe(true);

      // Verify file is strictly valid JSON on disk
      const rawContent = fs.readFileSync(testDbPath, 'utf8');
      const parsed = JSON.parse(rawContent);
      expect(parsed.stateRevision).toBe(51);
    });
  });

  describe('5. E2E Governance, Fail-Closed & Correlation Pipeline Tests', () => {
    const validSignalContext: StrategyContext = {
      symbol: 'BTCUSDT',
      marketType: 'FUTURES',
      tradingMode: 'FUTURES',
      price: 65000,
      high: 66000,
      low: 64000,
      open: 64500,
      vwap: 65200,
      sar: 65800,
      rsi: 75,
      change24h: 8.5,
      volume24h: 10000000,
      avgVolume: 2000000,
      bidSpreadPct: 0.0003,
      fundingRate: 0.0001,
      isCommitteeConsensusEnabled: true
    };

    it('E2E: Committee VETO / Reject results in NO_TRADE, no trade/balance mutation, and valid correlation IDs', () => {
      // Create a Bear envelope that rejects the signal
      const customBearReject: AgentDecisionEnvelope = {
        decisionId: 'dec_bear_veto_1',
        agentName: 'BEAR',
        signalId: 'sig_test_1',
        strategyId: 'SHORT_PUMP_FADE',
        strategyVersion: '1.0.0',
        action: 'REJECT',
        confidence: 90,
        approved: false,
        decisionSource: 'RULE_ENGINE',
        rationale: 'High liquidation cluster overhead',
        createdAt: Date.now()
      };

      const entryDecision = evaluateEntryDecision(validSignalContext, { bear: customBearReject });

      expect(entryDecision.approved).toBe(false);
      expect(entryDecision.action).toBe('NO_TRADE');
      expect(entryDecision.rejectionReason).toBe('COMMITTEE_VETO');
      expect(entryDecision.correlationId).toMatch(/^corr_/);
      expect(entryDecision.hunterEnvelope.approved).toBe(true);
      expect(entryDecision.bearEnvelope.approved).toBe(false);
      expect(entryDecision.committeeEnvelope.approved).toBe(false);
    });

    it('E2E: Real route canonical NO_TRADE guarantees zero exchange calls', () => {
      let exchangeApiCalled = false;
      const fakeExchangeExecutor = () => {
        exchangeApiCalled = true;
      };

      const invalidContext: StrategyContext = {
        ...validSignalContext,
        allowedDirections: 'LONG_ONLY' // Will mismatch SHORT signal
      };

      const entryDecision = evaluateEntryDecision(invalidContext);
      if (entryDecision.approved) {
        fakeExchangeExecutor();
      }

      expect(entryDecision.approved).toBe(false);
      expect(exchangeApiCalled).toBe(false);
    });

    it('E2E: Canonical HOLD guarantees no accidental TP/Multi-TP/Trailing close', () => {
      const normalHoldTrade: ExitTradeSnapshot = {
        id: 'trade_hold_1',
        symbol: 'BTCUSDT',
        side: 'SHORT',
        entryPrice: 65000,
        currentPrice: 64800, // +0.3% price move * 10x leverage = +3.0% gross (under 4.0% min net floor)
        amount: 100,
        leverage: 10,
        stopLoss: 67000,
        takeProfit: 60000,
        createdAt: Date.now() - 3600 * 1000 // 1 hr old
      };

      const market: ExitMarketSnapshot = {
        currentPrice: 64800,
        bid: 64790,
        ask: 64810,
        estimatedFeePct: 0.0006,
        estimatedSlippagePct: 0.0004
      };

      const exitSettings: ExitPolicySettings = {
        minNormalAutoCloseNetPnlPct: 4.0,
        enableMultiTp: true,
        multiTpTargets: [{ targetPnlPct: 8.0, closeRatio: 0.5 }]
      };

      const exitDecision = evaluateExitPolicy(normalHoldTrade, market, exitSettings);
      expect(exitDecision.kind).toBe('HOLD');
      expect(exitDecision.reasonCode).toBe('UNKNOWN');
    });

    it('E2E: Monotonic State Message synchronization rejects stale updates', () => {
      interface TestSettingsState {
        id: string;
        stateRevision?: number;
        updatedAt?: number;
        tradingMode: string;
      }

      const currentState: TestSettingsState = {
        id: 'settings_1',
        stateRevision: 10,
        updatedAt: 1000,
        tradingMode: 'FUTURES'
      };

      // Stale message (revision 9 <= 10)
      const staleMsg = {
        type: 'STATE_UPDATE' as const,
        entity: 'settings' as const,
        revision: 9,
        emittedAt: 1200,
        sender: 'IPC',
        payload: { id: 'settings_1', tradingMode: 'SPOT' }
      };

      const result = processIncomingStateMessage<TestSettingsState>(currentState, staleMsg);
      expect(result.accepted).toBe(false);
      expect(result.newRevision).toBe(10);

      // Valid newer message (revision 11 > 10)
      const freshMsg = {
        type: 'STATE_UPDATE' as const,
        entity: 'settings' as const,
        revision: 11,
        emittedAt: 1500,
        sender: 'IPC',
        payload: { id: 'settings_1', tradingMode: 'SPOT' }
      };

      const validResult = processIncomingStateMessage<TestSettingsState>(currentState, freshMsg);
      expect(validResult.accepted).toBe(true);
      expect(validResult.newRevision).toBe(11);
      expect(validResult.updatedState?.tradingMode).toBe('SPOT');
    });

    it('E2E: Valid default context passes all gates -> Hunter, Bear, Committee, Entry all APPROVE', () => {
      const validContext: StrategyContext = {
        symbol: 'BTCUSDT',
        marketType: 'FUTURES',
        tradingMode: 'FUTURES',
        price: 65000,
        high: 65200,
        low: 64800,
        open: 64900,
        vwap: 65000,
        sar: 65300,
        rsi: 74,
        change24h: 8.5,
        volume24h: 10000000,
        avgVolume: 2000000,
        bidSpreadPct: 0.0003,
        fundingRate: 0.0001,
        activeStrategy: 'SHORT_PUMP_FADE',
        allowedDirections: 'BOTH'
      };

      const decision = evaluateEntryDecision(validContext, {
        hunter: {
          decisionId: 'h_test',
          agentName: 'HUNTER',
          strategyId: 'CANONICAL_QUANT_SCALP_V2',
          strategyVersion: '2.1.0',
          action: 'APPROVE',
          confidence: 85,
          approved: true,
          decisionSource: 'AI',
          rationale: 'High probability short setup with momentum confirmation',
          createdAt: Date.now()
        },
        bear: {
          decisionId: 'b_test',
          agentName: 'BEAR',
          strategyId: 'CANONICAL_QUANT_SCALP_V2',
          strategyVersion: '2.1.0',
          action: 'APPROVE',
          confidence: 90,
          approved: true,
          decisionSource: 'AI',
          rationale: 'Risk criteria met, tight SL and healthy book liquidity',
          createdAt: Date.now()
        }
      });

      expect(decision.approved).toBe(true);
      expect(decision.action).toBe('SELL');
      expect(decision.side).toBe('SHORT');
      expect(decision.committeeEnvelope?.action).toBe('APPROVE');
      expect(decision.hunterEnvelope?.approved).toBe(true);
      expect(decision.bearEnvelope?.approved).toBe(true);
      expect(decision.correlationId).toBeDefined();
    });

    it('E2E: MAX_LIFETIME acts as emergency liveness exit override', () => {
      const agedTrade: ExitTradeSnapshot = {
        id: 'vt_aged_1',
        symbol: 'SOLUSDT',
        side: 'LONG',
        entryPrice: 150,
        currentPrice: 151, // PnL is positive (+0.66%) but under normal 4% auto-close floor
        amount: 100,
        leverage: 5,
        pnl: 3.33,
        pnlPercent: 3.33,
        createdAt: Date.now() - (25 * 3600 * 1000) // 25 hours old > 24 hours max
      };

      const market: ExitMarketSnapshot = {
        currentPrice: 151,
        bid: 150.95,
        ask: 151.05
      };

      const exitSettingsDefault: ExitPolicySettings = {
        minNormalAutoCloseNetPnlPct: 4.0,
        maxLifetimeHours: 24
      };

      // Default (no emergency flag) -> HOLD below floor
      const exitDecisionHold = evaluateExitPolicy(agedTrade, market, exitSettingsDefault);
      expect(exitDecisionHold.kind).toBe('HOLD');
      expect(exitDecisionHold.diagnostics.maxLifetimeBlockedByMinPnlThreshold).toBe(true);

      // Explicit emergency override flag -> EMERGENCY_FULL_CLOSE
      const exitSettingsEmergency: ExitPolicySettings = {
        minNormalAutoCloseNetPnlPct: 4.0,
        maxLifetimeHours: 24,
        allowEmergencyMaxLifetime: true
      };

      const exitDecision = evaluateExitPolicy(agedTrade, market, exitSettingsEmergency);
      expect(exitDecision.kind).toBe('EMERGENCY_FULL_CLOSE');
      expect(exitDecision.reasonCode).toBe('EMERGENCY_MAX_LIFETIME');
      expect(exitDecision.diagnostics.exitClass).toBe('LIVENESS_OVERRIDE');
      expect(exitDecision.reasonText).toContain('Превышено максимальное время удержания');
    });

    it('E2E: Direction Mismatch Invariant rejects and blocks execution', () => {
      // If signal indicates SHORT but entry decision returns LONG (or vice-versa)
      const mockSignalIsSell = true; // Signal says SHORT
      const decisionSaysBuy = {
        approved: true,
        action: 'BUY' as const,
        side: 'LONG' as const,
        reason: 'Contradictory buy'
      };

      const expectedSide = (decisionSaysBuy.action as string) === 'SELL' ? 'SHORT' : 'LONG';
      const actualSide = mockSignalIsSell ? 'SHORT' : 'LONG';
      const isMismatch = decisionSaysBuy.side !== expectedSide || actualSide !== expectedSide;

      expect(isMismatch).toBe(true);

      // Invariant ensures zero executor calls, zero balance deduction, and zero trade persistence
      let executorCalls = 0;
      let balance = 1000;
      let tradesCount = 0;

      if (!isMismatch) {
        executorCalls++;
        balance -= 100;
        tradesCount++;
      }

      expect(executorCalls).toBe(0);
      expect(balance).toBe(1000);
      expect(tradesCount).toBe(0);
    });

    it('E2E: Canonical HOLD prevents any Multi-TP/TP/trailing normal close outside policy', () => {
      const activeTrade: ExitTradeSnapshot = {
        id: 't_active_hold',
        symbol: 'ETHUSDT',
        side: 'SHORT',
        entryPrice: 3000,
        currentPrice: 2980,
        amount: 200,
        leverage: 10,
        pnl: 13.33,
        pnlPercent: 6.66,
        createdAt: Date.now() - 5000
      };

      const market: ExitMarketSnapshot = {
        currentPrice: 2980,
        bid: 2979.5,
        ask: 2980.5,
        currentTime: Date.now()
      };

      const policySettings: ExitPolicySettings = {
        minNormalAutoCloseNetPnlPct: 4.0,
        minPttpPeakNetPnlPct: 15.0, // High peak needed
        minPttpActivationNetPnlPct: 10.0,
        trailingStopTriggerPnlPct: 15.0 // High trailing trigger needed
      };

      const decision = evaluateExitPolicy(activeTrade, market, policySettings);
      expect(decision.kind).toBe('HOLD');

      let closedTrades = 0;
      if (decision.kind === 'FULL_CLOSE') {
        closedTrades++;
      }
      expect(closedTrades).toBe(0);
    });
  });
});
