import { describe, it, expect } from 'vitest';
import { validateIntegrationWiring } from './verify-integration-wiring.ts';

describe('Integration Wiring AST Verifier', () => {
  const validServerSnippet = `
    import { authMiddleware } from './server/authMiddleware.ts';
    import { evaluateEntryDecision, getApprovedExecutionSide } from './server/services/strategyEngine.ts';
    import { evaluateExitPolicy } from './server/services/exitPolicy.ts';
    import { evaluateCommitteeConsensus } from './server/services/agentEngine.ts';
    import { processIncomingStateMessage } from './server/services/stateSync.ts';
    import { validatePaperTradeInput, getOperationalWinRate } from './server/services/tradeMetrics.ts';
    import { dbAtomicStore } from './server/atomicDbSaver.ts';
    import { executePaperCapitalTransaction } from './server/services/paperCapitalStore.ts';
    import { executeMainVirtualAutoEntry, executeMainRealAutoEntry } from './server/services/productionAutoEntryHandlers.ts';

    app.use(authMiddleware);

    function isRealTradingAllowed(): boolean {
      return process.env.ENABLE_REAL_TRADING === 'true';
    }

    app.post('/api/real-trade/open', async (req, res) => {
      if (!isRealTradingAllowed()) {
        return res.status(403).json({ error: 'REAL_TRADING_DISABLED' });
      }
      const client = getCcxtClient();
      await executeRealOpenOnExchange('LONG', req.body.symbol, 100);
      res.json({ ok: true });
    });

    app.post('/api/real-trade/close', async (req, res) => {
      if (!isRealTradingAllowed()) {
        return res.status(403).json({ error: 'REAL_TRADING_DISABLED' });
      }
      res.json({ ok: true });
    });

    async function handleAutoEntry(signal: any) {
      await executeMainVirtualAutoEntry({
        symbol: signal.symbol,
        marketInput: signal.marketInput,
        calculatedAmount: 100,
        leverage: 10
      });
    }

    async function positionMonitor() {
      const exitDecision = evaluateExitPolicy(trade, market, {});
      if (exitDecision.kind === 'FULL_CLOSE') {
        await closePosition();
      }
    }

    async function sync() {
      processIncomingStateMessage({});
      evaluateCommitteeConsensus({});
      await dbAtomicStore.saveState({});
    }
  `;

  const validEnvSnippet = `
    ENABLE_REAL_TRADING=false
    OFFLINE_MODE=1
  `;

  const validPkgSnippet = `
    {
      "scripts": {
        "test:production-path:offline": "vitest run scripts/test-production-path-offline.ts"
      }
    }
  `;

  const validTestSnippet = `
    import { executeMainVirtualAutoEntry, executeMainRealAutoEntry } from '../server/services/productionAutoEntryHandlers.ts';
    import { runProductionAutoEntryCoordinator } from '../server/services/autoEntryCoordinator.ts';

    async function testPath() {
      await executeMainVirtualAutoEntry({});
      await executeMainRealAutoEntry({});
    }
  `;

  it('passes on canonical valid production fixture', () => {
    const res = validateIntegrationWiring(validServerSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('fails on duplicate real-trade open route', () => {
    const duplicateOpenSnippet = validServerSnippet + `
      app.post('/api/real-trade/open', async (req, res) => {
        res.json({ duplicate: true });
      });
    `;
    const res = validateIntegrationWiring(duplicateOpenSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Duplicate real-trade open route detected'))).toBe(true);
  });

  it('fails on duplicate real-trade close route', () => {
    const duplicateCloseSnippet = validServerSnippet + `
      app.post('/api/real-trade/close', async (req, res) => {
        res.json({ duplicate: true });
      });
    `;
    const res = validateIntegrationWiring(duplicateCloseSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Duplicate real-trade close route detected'))).toBe(true);
  });

  it('fails when real-trade guard is placed after exchange sink', () => {
    const invertedGuardSnippet = `
      import { authMiddleware } from './server/authMiddleware.ts';
      import { evaluateEntryDecision } from './server/services/strategyEngine.ts';
      import { evaluateExitPolicy } from './server/services/exitPolicy.ts';
      import { evaluateCommitteeConsensus } from './server/services/agentEngine.ts';
      import { processIncomingStateMessage } from './server/services/stateSync.ts';
      import { validatePaperTradeInput, getOperationalWinRate } from './server/services/tradeMetrics.ts';
      import { dbAtomicStore } from './server/atomicDbSaver.ts';
      import { executeMainVirtualAutoEntry } from './server/services/productionAutoEntryHandlers.ts';

      app.use(authMiddleware);

      app.post('/api/real-trade/open', async (req, res) => {
        const client = getCcxtClient();
        if (!isRealTradingAllowed()) {
          return res.status(403).json({ error: 'REAL_TRADING_DISABLED' });
        }
        res.json({ ok: true });
      });

      app.post('/api/real-trade/close', async (req, res) => {
        res.json({ ok: true });
      });

      function isRealTradingAllowed(): boolean {
        return false;
      }
    `;
    const res = validateIntegrationWiring(invertedGuardSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Exchange sink called without preceding real-trading permission guard'))).toBe(true);
  });

  it('fails on unawaited designated critical persistence call', () => {
    const unawaitedSnippet = validServerSnippet.replace(
      'await dbAtomicStore.saveState({});',
      'dbAtomicStore.saveState({});'
    );
    const res = validateIntegrationWiring(unawaitedSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Unawaited critical state persistence call detected'))).toBe(true);
  });

  it('fails when production-path test misses production handler import or call', () => {
    const badTestSnippet = `
      // Missing production handler imports and calls
      async function testMockOnly() {
        console.log('mock test');
      }
    `;
    const res = validateIntegrationWiring(validServerSnippet, validEnvSnippet, validPkgSnippet, badTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('test-production-path-offline.ts must import and execute production auto-entry handlers'))).toBe(true);
  });

  it('fails when separate post-execution persistDecisionBundle() anti-pattern is present in coordinator (Fixture 1)', () => {
    const badCoordSnippet = `
      async function runCoordinator() {
        const autoResult = await runCanonicalAutoEntry(autoEntryParams, executionPort);
        await persistDecisionBundle(store, decisionBundle);
      }
    `;
    const res = validateIntegrationWiring(validServerSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet, badCoordSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Separate post-execution persistDecisionBundle() detected'))).toBe(true);
  });

  it('fails when real executor is reachable before durable PENDING_OPEN intent commit (Fixture 3)', () => {
    const exchangeBeforeGuardSnippet = `
      import { authMiddleware } from './server/authMiddleware.ts';
      import { evaluateEntryDecision } from './server/services/strategyEngine.ts';
      import { evaluateExitPolicy } from './server/services/exitPolicy.ts';
      import { evaluateCommitteeConsensus } from './server/services/agentEngine.ts';
      import { processIncomingStateMessage } from './server/services/stateSync.ts';
      import { dbAtomicStore } from './server/atomicDbSaver.ts';
      import { executeMainVirtualAutoEntry } from './server/services/productionAutoEntryHandlers.ts';

      app.use(authMiddleware);

      const client = getCcxtClient(); // Unprotected exchange sink at top level

      function isRealTradingAllowed(): boolean {
        return false;
      }
      app.post('/api/real-trade/open', async (req, res) => { res.json({}); });
      app.post('/api/real-trade/close', async (req, res) => { res.json({}); });
    `;
    const res = validateIntegrationWiring(exchangeBeforeGuardSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Exchange sink called without preceding real-trading permission guard'))).toBe(true);
  });

  it('fails when production adapter misses Hunter or Bear context (Fixture 4)', () => {
    const badAdapterSnippet = `
      export async function executeMainVirtualAutoEntry(params, context) {
        // Missing hunterDecision / bearDecision propagation
        return runProductionAutoEntryCoordinator(params, { store: context.store });
      }
    `;
    const res = validateIntegrationWiring(validServerSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet, undefined, badAdapterSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Production adapter missing Hunter/Bear context propagation'))).toBe(true);
  });

  it('fails when close transaction port contains fallback ID generation (Fixture 5)', () => {
    const fallbackIdSnippet = validServerSnippet + `
      app.post('/api/test-close-fallback', async (req, res) => {
        const id = immutableTradeId || '';
      });
    `;
    const res = validateIntegrationWiring(fallbackIdSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Detected fallback ID generation in close transaction port'))).toBe(true);
  });

  it('fails when lifecycle-critical saveTradeDB or saveBalanceDB is unawaited (Fixture 6)', () => {
    const unawaitedSnippet = validServerSnippet + `
      async function unawaitedSave() {
        saveTradeDB({ id: 'test' });
      }
    `;
    const res = validateIntegrationWiring(unawaitedSnippet, validEnvSnippet, validPkgSnippet, validTestSnippet);
    expect(res.success).toBe(false);
    expect(res.errors.some(e => e.includes('Unawaited lifecycle-critical saveTradeDB/saveBalanceDB detected'))).toBe(true);
  });
});
