import { describe, it, expect, vi } from 'vitest';
import { buildBalancedCandidateQueue, runAutopilotAndVirtualTradeEntry, type AutoPilotEngineDependencies } from './autoPilotEngine.ts';

describe('AutoPilotEngine: Queue Balancing & Non-Monopolization Regression Tests', () => {
  describe('1. buildBalancedCandidateQueue', () => {
    it('interleaves LONG and SHORT candidates, preventing high aiScore from monopolizing queue slots', () => {
      const mockSignals = [
        { rawSymbol: 'BTC/USDT', signal: 'LONG', aiScore: 98 },
        { rawSymbol: 'ETH/USDT', signal: 'LONG', aiScore: 95 },
        { rawSymbol: 'SOL/USDT', signal: 'LONG', aiScore: 92 },
        { rawSymbol: 'BNB/USDT', signal: 'LONG', aiScore: 89 },
        { rawSymbol: 'XRP/USDT', signal: 'SHORT', aiScore: 82 },
        { rawSymbol: 'DOGE/USDT', signal: 'SHORT', aiScore: 80 },
        { rawSymbol: 'ADA/USDT', signal: 'SHORT', aiScore: 78 }
      ];

      const queue = buildBalancedCandidateQueue(mockSignals, {
        allowedTradingDirections: 'BOTH',
        activeLongCount: 0,
        activeShortCount: 0
      });

      // Assert alternating pattern: index 0 is top LONG, index 1 is top SHORT
      expect(queue[0].signal).toBe('LONG');
      expect(queue[0].rawSymbol).toBe('BTC/USDT');
      expect(queue[0].aiScore).toBe(98);

      expect(queue[1].signal).toBe('SHORT');
      expect(queue[1].rawSymbol).toBe('XRP/USDT');
      expect(queue[1].aiScore).toBe(82);

      expect(queue[2].signal).toBe('LONG');
      expect(queue[2].rawSymbol).toBe('ETH/USDT');
      expect(queue[2].aiScore).toBe(95);

      expect(queue[3].signal).toBe('SHORT');
      expect(queue[3].rawSymbol).toBe('DOGE/USDT');
      expect(queue[3].aiScore).toBe(80);
    });

    it('prioritizes SHORT candidates at position 0 when open positions are skewed toward LONG', () => {
      const mockSignals = [
        { rawSymbol: 'BTC/USDT', signal: 'LONG', aiScore: 99 },
        { rawSymbol: 'ETH/USDT', signal: 'SHORT', aiScore: 85 }
      ];

      // Existing active trades: 3 LONG, 0 SHORT
      const queue = buildBalancedCandidateQueue(mockSignals, {
        allowedTradingDirections: 'BOTH',
        activeLongCount: 3,
        activeShortCount: 0
      });

      // Deficit side (SHORT) must be evaluated first
      expect(queue[0].signal).toBe('SHORT');
      expect(queue[0].rawSymbol).toBe('ETH/USDT');
      expect(queue[1].signal).toBe('LONG');
      expect(queue[1].rawSymbol).toBe('BTC/USDT');
    });

    it('respects directional policy: LONG_ONLY drops SHORTs, SHORT_ONLY drops LONGs', () => {
      const mockSignals = [
        { rawSymbol: 'BTC/USDT', signal: 'LONG', aiScore: 95 },
        { rawSymbol: 'ETH/USDT', signal: 'SHORT', aiScore: 85 }
      ];

      const longOnlyQueue = buildBalancedCandidateQueue(mockSignals, {
        allowedTradingDirections: 'LONG_ONLY'
      });
      expect(longOnlyQueue.every(s => s.signal === 'LONG')).toBe(true);
      expect(longOnlyQueue.length).toBe(1);

      const shortOnlyQueue = buildBalancedCandidateQueue(mockSignals, {
        allowedTradingDirections: 'SHORT_ONLY'
      });
      expect(shortOnlyQueue.every(s => s.signal === 'SHORT')).toBe(true);
      expect(shortOnlyQueue.length).toBe(1);
    });

    it('handles empty or single-direction candidate arrays gracefully', () => {
      expect(buildBalancedCandidateQueue([])).toEqual([]);
      expect(buildBalancedCandidateQueue(null as any)).toEqual([]);

      const allLongs = [
        { rawSymbol: 'BTC/USDT', signal: 'LONG', aiScore: 90 },
        { rawSymbol: 'ETH/USDT', signal: 'LONG', aiScore: 88 }
      ];
      const queue = buildBalancedCandidateQueue(allLongs);
      expect(queue.length).toBe(2);
      expect(queue[0].rawSymbol).toBe('BTC/USDT');
    });
  });

  describe('2. runAutopilotAndVirtualTradeEntry (Full Execution Pipeline)', () => {
    function createMockAutopilotDeps(overrides: Partial<AutoPilotEngineDependencies> = {}): {
      deps: AutoPilotEngineDependencies;
      pushedTrades: any[];
    } {
      const pushedTrades: any[] = [];
      const defaultSettings: any = {
        isAutopilotEnabled: true,
        tradingMode: 'virtual',
        tradingExecutionMode: 'auto',
        autopilotAggressiveness: 'aggressive',
        allowedTradingDirections: 'BOTH',
        maxActivePositionsVirtual: 6,
        maxSameDirectionPositions: 3,
        virtualBalance: 1000,
        isCommitteeConsensusCheckEnabled: false
      };

      const defaultDeps: AutoPilotEngineDependencies = {
        getGlobalSettings: () => defaultSettings,
        getCacheSignals: () => ({ data: [] }),
        getVirtualTrades: () => [...pushedTrades],
        pushVirtualTrade: vi.fn((t) => pushedTrades.push(t)),
        getVirtualBalance: () => 1000,
        setVirtualBalance: vi.fn(),
        getStartOfDayBalance: () => 1000,
        getGlobalCcxtTickers: () => ({}),
        getGlobalTrueOhlcv: () => ({}),
        getGlobalAdx: () => ({}),
        getGlobalAtr: () => ({}),
        getGlobalOrderBookHistory: () => ({}),
        getOrderBookImbalance: () => ({}),
        getGlobalMarketPulse: () => ({ sentiment: 'NEUTRAL', bias: 0 }),
        getProlivPeaks: () => [],
        getAutopilotFailedSymbols: () => new Set(),
        getSymbolsUndergoingRealOpen: () => new Set(),
        committeeVetoShadowStats: { totalRealEntriesChecked: 0, wouldHaveBlockedCount: 0 },
        isCircuitBreakerActive: () => false,
        acquireExecutionLock: () => true,
        isWeexApiSupported: () => true,
        getCcxtClient: vi.fn(),
        fetchCachedRealBalance: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        setRealTradeSlTpOnExchange: vi.fn(),
        saveTradeDB: vi.fn(),
        saveBalanceDB: vi.fn(),
        saveSettings: vi.fn(),
        sendTelegramMessage: vi.fn(),
        getAtomicStoreRevision: () => 1,
        executeMainVirtualAutoEntry: vi.fn(async (params) => {
          const trade = {
            id: `VT-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            symbol: params.symbol,
            side: params.tradeIntent?.side || (params.currentSig?.signal?.includes('SELL') ? 'SHORT' : 'LONG'),
            status: 'OPEN',
            price: params.marketInput?.price || 100,
            amount: params.calculatedAmount || 10,
            isAutoLearning: !!params.targetIsAutoLearning,
            isReal: false
          };
          return { executed: true, status: 'OPEN', trade };
        }),
        executeMainRealAutoEntry: vi.fn(),
        getLossStreakSizeDampening: () => 1.0,
        getWallAdjustedTp: (_sym, _isSell, _entry, target) => target,
        ...overrides
      };

      return { deps: defaultDeps, pushedTrades };
    }

    it('admits BOTH LONG and SHORT into available slots up to directional quota (3 LONG + 3 SHORT)', async () => {
      // Signals: 4 LONGs (higher scores 95, 93, 91, 89) and 4 SHORTs (scores 84, 82, 80, 78)
      const mockSignals = [
        {
          rawSymbol: 'BTC/USDT',
          signal: 'LONG',
          aiScore: 95,
          price: 60000,
          type: 'SAR REVERSAL',
          volumeSpike: 2.0,
          volume24h: 500000
        },
        {
          rawSymbol: 'ETH/USDT',
          signal: 'LONG',
          aiScore: 93,
          price: 3000,
          type: 'SPIRE',
          volumeSpike: 1.8,
          volume24h: 400000
        },
        {
          rawSymbol: 'SOL/USDT',
          signal: 'LONG',
          aiScore: 91,
          price: 150,
          type: 'WICK BOUNCE',
          volumeSpike: 1.5,
          volume24h: 300000
        },
        {
          rawSymbol: 'BNB/USDT',
          signal: 'LONG',
          aiScore: 89,
          price: 500,
          type: 'BOS BREAKOUT',
          volumeSpike: 1.5,
          volume24h: 300000
        },
        {
          rawSymbol: 'XRP/USDT',
          signal: 'SHORT',
          aiScore: 84,
          price: 0.6,
          type: 'SAR REVERSAL',
          volumeSpike: 1.9,
          volume24h: 500000
        },
        {
          rawSymbol: 'DOGE/USDT',
          signal: 'SHORT',
          aiScore: 82,
          price: 0.12,
          type: 'SPIRE CLIMAX',
          volumeSpike: 1.7,
          volume24h: 400000
        },
        {
          rawSymbol: 'ADA/USDT',
          signal: 'SHORT',
          aiScore: 80,
          price: 0.45,
          type: 'PARABOLIC BLOWOUT',
          volumeSpike: 1.5,
          volume24h: 300000
        },
        {
          rawSymbol: 'AVAX/USDT',
          signal: 'SHORT',
          aiScore: 78,
          price: 25,
          type: 'WICK RETEST',
          volumeSpike: 1.5,
          volume24h: 300000
        }
      ];

      const { deps, pushedTrades } = createMockAutopilotDeps({
        getCacheSignals: () => ({
          data: mockSignals,
          lastUpdated: Date.now(),
          marketRegime: 'RANGING',
          marketHealth: 80,
          btcTrend24h: 0.5
        })
      });

      await runAutopilotAndVirtualTradeEntry(deps);

      const longExecuted = pushedTrades.filter(t => t.side === 'LONG');
      const shortExecuted = pushedTrades.filter(t => t.side === 'SHORT');

      // Both sides must be admitted and executed up to max quota (3 each)
      expect(longExecuted.length).toBe(3);
      expect(shortExecuted.length).toBe(3);
      expect(pushedTrades.length).toBe(6);

      // Verify that higher aiScore of LONG did NOT starve SHORT
      expect(shortExecuted.map(t => t.symbol)).toEqual(['XRP/USDT', 'DOGE/USDT', 'ADA/USDT']);
      expect(longExecuted.map(t => t.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    });

    it('strictly prevents slot monopolization: 4th LONG is blocked by maxSameDir quota', async () => {
      // 5 LONG signals with score 99, 1 SHORT with score 80
      const mockSignals = [
        { rawSymbol: 'L1/USDT', signal: 'LONG', aiScore: 99, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'L2/USDT', signal: 'LONG', aiScore: 98, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'L3/USDT', signal: 'LONG', aiScore: 97, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'L4/USDT', signal: 'LONG', aiScore: 96, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'L5/USDT', signal: 'LONG', aiScore: 95, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'S1/USDT', signal: 'SHORT', aiScore: 80, price: 10, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 }
      ];

      const { deps, pushedTrades } = createMockAutopilotDeps({
        getCacheSignals: () => ({
          data: mockSignals,
          lastUpdated: Date.now(),
          marketRegime: 'RANGING',
          marketHealth: 80,
          btcTrend24h: 0.5
        })
      });

      await runAutopilotAndVirtualTradeEntry(deps);

      const longExecuted = pushedTrades.filter(t => t.side === 'LONG');
      const shortExecuted = pushedTrades.filter(t => t.side === 'SHORT');

      // LONGs cannot exceed 3 even with 99 score
      expect(longExecuted.length).toBe(3);
      // SHORT is executed despite lower score
      expect(shortExecuted.length).toBe(1);
      expect(shortExecuted[0].symbol).toBe('S1/USDT');
    });

    it('halts real trade execution when circuit breaker is active', async () => {
      const mockSignals = [
        { rawSymbol: 'BTC/USDT', signal: 'LONG', aiScore: 98, price: 60000, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 },
        { rawSymbol: 'ETH/USDT', signal: 'SHORT', aiScore: 98, price: 3000, type: 'SAR', volumeSpike: 2.0, volume24h: 500000 }
      ];

      const executeRealOpenOnExchange = vi.fn();
      const { deps } = createMockAutopilotDeps({
        getGlobalSettings: () => ({
          isAutopilotEnabled: true,
          tradingMode: 'real',
          tradingExecutionMode: 'auto',
          exchangeApiConfig: { isEnabled: true, apiKey: 'test_key', secret: 'test_sec' },
          allowedTradingDirections: 'BOTH',
          maxActivePositionsReal: 6,
          maxSameDirectionPositions: 3,
          isCommitteeConsensusCheckEnabled: false
        }),
        executeRealOpenOnExchange,
        isCircuitBreakerActive: () => true,
        getCacheSignals: () => ({
          data: mockSignals,
          lastUpdated: Date.now(),
          marketRegime: 'RANGING',
          marketHealth: 80,
          btcTrend24h: 0.5
        })
      });

      await runAutopilotAndVirtualTradeEntry(deps);
      expect(executeRealOpenOnExchange).not.toHaveBeenCalled();
    });
  });
});
