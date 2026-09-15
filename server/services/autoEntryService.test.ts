import { describe, it, expect, vi } from 'vitest';
import { runCanonicalAutoEntry, type AutoEntryParams, type AutoEntryExecutionPort } from './autoEntryService.ts';
import { type StrategyMarketInput } from './strategyEngine.ts';

describe('AutoEntryService - Canonical Unified Entry Pipeline', () => {
  const baseShortInput: StrategyMarketInput = {
    symbol: 'BTCUSDT',
    price: 65000,
    high: 65500,
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
    allowedDirections: 'BOTH'
  };

  const baseLongInput: StrategyMarketInput = {
    symbol: 'SOLUSDT',
    marketType: 'SPOT',
    price: 150,
    high: 152,
    low: 148,
    open: 149,
    vwap: 149.5,
    sar: 148,
    rsi: 35,
    change24h: -4.5,
    volume24h: 5000000,
    avgVolume: 1000000,
    bidSpreadPct: 0.0003,
    fundingRate: 0.0001,
    allowedDirections: 'BOTH'
  };

  const createMockPort = (): AutoEntryExecutionPort & { savedTrades: any[]; balancesSaved: number } => {
    const savedTrades: any[] = [];
    let balancesSaved = 0;

    return {
      savedTrades,
      balancesSaved,
      executeRealOpenOnExchange: vi.fn().mockResolvedValue({ success: true, entryPrice: 65000, orderId: 'ord_123' }),
      setRealTradeSlTpOnExchange: vi.fn().mockResolvedValue(true),
      saveTradeDB: vi.fn().mockImplementation(async (trade: any) => {
        const idx = savedTrades.findIndex(t => t.id === trade.id);
        if (idx !== -1) {
          savedTrades[idx] = { ...trade };
        } else {
          savedTrades.push({ ...trade });
        }
      }),
      saveBalanceDB: vi.fn().mockImplementation(async () => {
        balancesSaved++;
      }),
      logStructured: vi.fn(),
      sendTelegramMessage: vi.fn(),
      getAtomicStoreRevision: vi.fn().mockReturnValue(42)
    };
  };

  it('approves and executes virtual SHORT trade through canonical gate', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,
      calculatedAmount: 50,
      leverage: 10,
      stopLoss: 66000,
      takeProfit: 62000
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(true);
    expect(result.status).toBe('OPEN');
    expect(result.side).toBe('SHORT');
    expect(result.decision.approved).toBe(true);
    expect(result.trade).toBeDefined();
    expect(result.trade.status).toBe('OPEN');
    expect(result.trade.side).toBe('SHORT');
    expect(result.trade.dataOrigin).toBe('PAPER');
    expect(result.trade.decisionSource).toBe('COMMITTEE');
    expect(result.trade.lineageStatus).toBe('COMPLIANT');
    expect(result.trade.stateRevision).toBe(42);
    expect(port.saveTradeDB).toHaveBeenCalled();
    expect(port.saveBalanceDB).toHaveBeenCalled();
  });

  it('rejects entry when spread exceeds fail-closed threshold', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: { ...baseShortInput, bidSpreadPct: 0.15 }, // Exceeds 0.08% max limit
      calculatedAmount: 50,
      leverage: 10
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(false);
    expect(result.status).toBe('REJECTED');
    expect(result.decision.approved).toBe(false);
    expect(result.decision.rejectionReason).toBe('HIGH_SPREAD');
    expect(port.saveTradeDB).not.toHaveBeenCalled();
  });

  it('rejects entry when signal direction mismatches canonical decision', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,                       // Evaluates to SHORT
      currentSig: { id: 'sig_1', isSellSignal: false },  // Signal claims LONG
      calculatedAmount: 50,
      leverage: 10
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(false);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toContain('DIRECTION_MISMATCH');
    expect(port.saveTradeDB).not.toHaveBeenCalled();
  });

  it('executes real trade with strict PENDING_OPEN -> OPEN lifecycle', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: true,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5,
      stopLoss: 66000,
      takeProfit: 62000
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(true);
    expect(result.status).toBe('OPEN');
    expect(result.side).toBe('SHORT');
    expect(result.trade.status).toBe('OPEN');
    expect(result.trade.side).toBe('SHORT');
    expect(result.trade.isReal).toBe(true);
    expect(result.trade.dataOrigin).toBe('LIVE');
    expect(result.trade.lineageStatus).toBe('COMPLIANT');

    // Verify durable lifecycle transitions were persisted
    expect(port.savedTrades.length).toBeGreaterThanOrEqual(1);
    const historyTypes = result.trade.history.map((h: any) => h.type);
    expect(historyTypes).toContain('PENDING_OPEN');
    expect(historyTypes).toContain('OPEN');
  });

  it('handles exchange rejection safely by marking trade CANCELLED', async () => {
    const port = createMockPort();
    port.executeRealOpenOnExchange = vi.fn().mockResolvedValue({ success: false, error: 'INSUFFICIENT_MARGIN' });

    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: true,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(false);
    expect(result.status).toBe('CANCELLED');
    expect(result.trade.status).toBe('CANCELLED');
    expect(result.trade.closeReason).toBe('INSUFFICIENT_MARGIN');
  });

  it('handles network failure during real execution by marking OPEN_UNKNOWN with reconciliation flag', async () => {
    const port = createMockPort();
    port.executeRealOpenOnExchange = vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection reset by peer'));

    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: true,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5
    };

    const result = await runCanonicalAutoEntry(params, port);

    expect(result.executed).toBe(false);
    expect(result.status).toBe('OPEN_UNKNOWN');
    expect(result.trade.status).toBe('OPEN_UNKNOWN');
    expect(result.trade.needsReconciliation).toBe(true);
  });

  it('blocks entry when committee consensus fails or score is below 75', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5,
      currentSig: {
        symbol: 'BTCUSDT',
        decisionTrace: {
          passedConsensus: false,
          consensusScore: 68,
          verdict: 'REJECT'
        }
      } as any
    };

    const result = await runCanonicalAutoEntry(params, port);
    expect(result.executed).toBe(false);
    expect(result.verdict).toBe('REJECT');
    expect(result.reason).toContain('CONSENSUS_REJECTED');
  });

  it('blocks entry when liquidity sweep check fails in decisionTrace', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5,
      currentSig: {
        symbol: 'BTCUSDT',
        decisionTrace: {
          passedConsensus: true,
          consensusScore: 85,
          factors: [
            { name: 'LIQUIDITY_SWEEP', passed: false }
          ]
        }
      } as any
    };

    const result = await runCanonicalAutoEntry(params, port);
    expect(result.executed).toBe(false);
    expect(result.verdict).toBe('REJECT');
    expect(result.reason).toContain('LIQUIDITY_SWEEP_UNCONFIRMED');
  });

  it('approves entry when high-conviction trend setup satisfies dynamic requiredScore (e.g. 70 >= 68)', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5,
      currentSig: {
        symbol: 'BTCUSDT',
        decisionTrace: {
          passedConsensus: true,
          consensusScore: 70,
          requiredScore: 68,
          verdict: 'APPROVE_SHORT',
          factors: [
            { name: 'LIQUIDITY_SWEEP', passed: true },
            { name: 'WICK_REJECTION', passed: true }
          ]
        }
      } as any
    };

    const result = await runCanonicalAutoEntry(params, port);
    expect(result.executed).toBe(true);
    expect(result.status).toBe('OPEN');
  });

  it('rejects entry when score is below dynamic requiredScore (e.g. 65 < 68)', async () => {
    const port = createMockPort();
    const params: AutoEntryParams = {
      symbol: 'BTCUSDT',
      isReal: false,
      marketInput: baseShortInput,
      calculatedAmount: 100,
      leverage: 5,
      currentSig: {
        symbol: 'BTCUSDT',
        decisionTrace: {
          passedConsensus: true,
          consensusScore: 65,
          requiredScore: 68,
          verdict: 'APPROVE_SHORT'
        }
      } as any
    };

    const result = await runCanonicalAutoEntry(params, port);
    expect(result.executed).toBe(false);
    expect(result.verdict).toBe('REJECT');
    expect(result.reason).toContain('CONSENSUS_REJECTED');
    expect(result.reason).toContain('< 68');
  });
});
