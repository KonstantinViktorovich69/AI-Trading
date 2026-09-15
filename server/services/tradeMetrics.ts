import { inferDataOrigin } from './tradeSchema.ts';

export interface IsOperationalTradeOptions {
  includePaper?: boolean;
  includeLegacyUnknown?: boolean;
}

/**
 * Common operational trade selector used across win rate, blacklisting, retrospective reports,
 * AI performance reports, adaptive threshold, position sizing, rule success rate and optimizer summaries.
 * By default excludes SEED, FORCED_RESET, and LEGACY_UNKNOWN.
 */
export function isOperationalTrade(trade: any, options: IsOperationalTradeOptions = {}): boolean {
  if (!trade) return false;

  const origin = trade.dataOrigin || inferDataOrigin(trade);

  if (origin === 'SEED' || origin === 'HISTORICAL_SEED' || origin === 'FORCED_RESET') {
    return false;
  }

  if (origin === 'LEGACY_UNKNOWN' && !options.includeLegacyUnknown) {
    return false;
  }

  if (origin === 'LIVE' || origin === 'LIVE_WEEX') {
    return true;
  }

  if (origin === 'PAPER' || origin === 'PAPER_SIM') {
    return options.includePaper !== false;
  }

  return false;
}

export function filterOperationalTrades(trades: any[], options: IsOperationalTradeOptions = { includePaper: true }): any[] {
  if (!Array.isArray(trades)) return [];
  return trades.filter(t => isOperationalTrade(t, options));
}

export function calculateOperationalWinRate(trades: any[], options: IsOperationalTradeOptions = { includePaper: true }): { winRate: number; total: number; wins: number; losses: number } {
  const operational = filterOperationalTrades(trades, options);
  const closed = operational.filter(t => t.status === 'CLOSED' || t.closedAt || t.pnl !== undefined);

  if (closed.length === 0) {
    return { winRate: 0, total: 0, wins: 0, losses: 0 };
  }

  let wins = 0;
  let losses = 0;

  for (const t of closed) {
    const pnl = Number(t.pnl || t.realizedPnl || 0);
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  return { winRate, total: closed.length, wins, losses };
}
