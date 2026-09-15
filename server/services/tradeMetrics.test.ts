import { describe, it, expect } from 'vitest';
import { inferDataOrigin, inferDecisionSource, inferCloseReasonCode } from './tradeSchema.ts';
import { isOperationalTrade, calculateOperationalWinRate } from './tradeMetrics.ts';

describe('tradeSchema & tradeMetrics', () => {
  it('correctly infers SEED, FORCED_RESET, PAPER, and LIVE data origins', () => {
    expect(inferDataOrigin({ id: 'hist_trade_101' })).toBe('SEED');
    expect(inferDataOrigin({ id: 'seed_55' })).toBe('SEED');
    expect(inferDataOrigin({ closeReason: 'принудительно закрыта при смене виртуального баланса' })).toBe('FORCED_RESET');
    expect(inferDataOrigin({ isReal: true })).toBe('LIVE');
    expect(inferDataOrigin({ isPaper: true })).toBe('PAPER');
    expect(inferDataOrigin({})).toBe('LEGACY_UNKNOWN');
  });

  it('correctly filters operational trades and excludes SEED and FORCED_RESET', () => {
    const seedTrade = { id: 'hist_trade_1', pnl: 50, status: 'CLOSED' };
    const resetTrade = { id: 'trade_2', closeReason: 'FORCED_RESET', pnl: -10, status: 'CLOSED' };
    const paperTrade = { id: 'trade_3', isPaper: true, pnl: 100, status: 'CLOSED' };
    const liveTrade = { id: 'trade_4', isReal: true, pnl: -20, status: 'CLOSED' };

    expect(isOperationalTrade(seedTrade)).toBe(false);
    expect(isOperationalTrade(resetTrade)).toBe(false);
    expect(isOperationalTrade(paperTrade)).toBe(true);
    expect(isOperationalTrade(liveTrade)).toBe(true);

    const trades = [seedTrade, resetTrade, paperTrade, liveTrade];
    const stats = calculateOperationalWinRate(trades);

    expect(stats.total).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(50);
  });

  it('correctly infers close reason codes', () => {
    expect(inferCloseReasonCode({ closeReason: 'Take profit reached' })).toBe('TAKE_PROFIT');
    expect(inferCloseReasonCode({ closeReason: 'Stop loss triggered' })).toBe('STOP_LOSS');
    expect(inferCloseReasonCode({ closeReason: 'PTTP trail exit' })).toBe('PTTP');
    expect(inferCloseReasonCode({ closeReason: 'Emergency hard stop' })).toBe('EMERGENCY_HARD_STOP');
  });
});
