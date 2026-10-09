import { isOperationalTrade } from './tradeMetrics.ts';
import { inferDataOrigin, inferCloseReasonCode } from './tradeSchema.ts';
import { extractPatternFromTrade, isPatternProtected } from './signalEngine.ts';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';

/**
 * Returns netReturnPct for a trade:
 * netReturnPct = pnl / (initialAmount * leverage) * 100
 *
 * NOTE on fee (0.10% round-turn):
 * Unified pnl from getUnifiedTradeClosePnl ALREADY subtracts the 0.10% round-turn model fee:
 *   feeUsd = amount * leverage * 0.001
 *   pnlUsd = rawPnlUsd - feeUsd
 * Therefore, trade.pnl already accounts for the 0.10% round-turn fee.
 * If neither trade.pnl nor closePrice is available, fallback computes unleveraged - 0.10.
 */
export function netReturnPct(t: any): number {
  if (!t) return 0;
  const initialAmount = t.initialAmount || t.amount || 0;
  const leverage = t.leverage || 1;
  const denominator = initialAmount * leverage;

  if (typeof t.pnl === 'number' && denominator > 0) {
    return (t.pnl / denominator) * 100;
  }

  // Fallback if pnl is missing but entryPrice and closePrice are known
  if (typeof t.entryPrice === 'number' && typeof t.closePrice === 'number' && t.entryPrice > 0) {
    const isLong = t.side === 'LONG';
    const rawPct = isLong
      ? ((t.closePrice - t.entryPrice) / t.entryPrice) * 100
      : ((t.entryPrice - t.closePrice) / t.entryPrice) * 100;
    // Minus model 0.10% round-turn fee
    return rawPct - 0.10;
  }

  if (typeof t.pnlPercent === 'number' && leverage > 0) {
    return t.pnlPercent / leverage;
  }

  return 0;
}

/**
 * Validates if a trade is clean for aggregated learning.
 * Excludes:
 * - not CLOSED
 * - not isOperationalTrade({ includePaper: true })
 * - gapAffected === true
 * - mode === 'FUNDING_FARM' or isFundingFarm
 * - dataOrigin IN ('SEED', 'HISTORICAL_SEED', 'FORCED_RESET')
 * - closeReasonCode IN ('MANUAL', 'FORCED_RESET')
 * - Outliers / glitches: |closePrice/entryPrice - 1| > 25% or |netReturnPct| > 25
 */
export function isCleanLearningTrade(t: any): boolean {
  if (!t) return false;

  // 1. Must be CLOSED
  const isClosed = t.status === 'CLOSED' || t.status === 'closed' || !!t.closeTime || !!t.closedAt;
  if (!isClosed) return false;

  // 2. Operational trade check
  if (!isOperationalTrade(t, { includePaper: true })) return false;

  // 3. Downtime gap affected trades are excluded
  if (t.gapAffected === true) return false;

  // 4. Funding farm modes excluded
  if (t.mode === 'FUNDING_FARM' || t.isFundingFarm === true) return false;

  // 5. Data origin checks
  const origin = t.dataOrigin || inferDataOrigin(t);
  if (origin === 'SEED' || origin === 'HISTORICAL_SEED' || origin === 'FORCED_RESET') {
    return false;
  }

  // 6. Close reason checks: exclude manual closures and system resets
  const reasonCode = t.closeReasonCode || inferCloseReasonCode(t);
  if (reasonCode === 'MANUAL' || reasonCode === 'FORCED_RESET') {
    return false;
  }

  // 7. Check glitch / outlier
  if (typeof t.entryPrice === 'number' && typeof t.closePrice === 'number' && t.entryPrice > 0) {
    const priceRatioDiff = Math.abs(t.closePrice / t.entryPrice - 1);
    if (priceRatioDiff > 0.25) return false;
  }

  const retPct = netReturnPct(t);
  if (Math.abs(retPct) > 25) return false;

  return true;
}

export interface CellKeys {
  fine: string;   // pattern|side|regime
  mid: string;    // pattern|side
  coarse: string; // pattern
}

/**
 * Extracts 3 levels of keys for a trade: fine, mid, coarse
 */
export function cellKeys(t: any): CellKeys {
  const rawPattern = extractPatternFromTrade(t) || t?.matchedPattern || t?.patternName || t?.type || 'UNKNOWN';
  const pattern = SignalPerformanceAnalyticsService.normalizePattern(rawPattern);
  const side = (t?.side || 'LONG').toUpperCase();
  const regime = t?.marketRegime || t?.decisionTrace?.marketRegime || 'NEUTRAL';

  return {
    fine: `${pattern}|${side}|${regime}`,
    mid: `${pattern}|${side}`,
    coarse: `${pattern}`
  };
}

/**
 * Wilson score interval (95% confidence) for binomial win rate
 */
export function wilson95(wins: number, n: number): { lo: number; hi: number; center: number } {
  if (n <= 0) return { lo: 0, hi: 0, center: 0 };
  const z = 1.95996; // 95%
  const z2 = z * z;
  const p = wins / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
    center
  };
}

/**
 * Simple pseudo-random number generator seeded with string hash
 * Murmur/Mulberry32-like for deterministic bootstrap
 */
function createSeededRng(seedStr: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic bootstrap confidence interval for mean net return
 */
export function bootstrapExpectancyCI95(
  returns: number[],
  weights: number[],
  seedKey: string,
  iterations = 500
): { lo: number; hi: number } {
  const n = returns.length;
  if (n < 20) return { lo: 0, hi: 0 };

  const rng = createSeededRng(seedKey);

  // Cumulative distribution for weighted sampling
  const sumW = weights.reduce((acc, w) => acc + w, 0);
  if (sumW <= 0) return { lo: 0, hi: 0 };

  const cumW: number[] = new Array(n);
  let cur = 0;
  for (let i = 0; i < n; i++) {
    cur += weights[i] / sumW;
    cumW[i] = cur;
  }
  cumW[n - 1] = 1.0;

  const sampleMeans: number[] = new Array(iterations);

  for (let iter = 0; iter < iterations; iter++) {
    let mean = 0;
    for (let j = 0; j < n; j++) {
      const r = rng();
      // binary search for index
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumW[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      mean += returns[lo];
    }
    sampleMeans[iter] = mean / n;
  }

  sampleMeans.sort((a, b) => a - b);
  const loIdx = Math.floor(iterations * 0.025);
  const hiIdx = Math.floor(iterations * 0.975);

  return {
    lo: Number(sampleMeans[loIdx].toFixed(4)),
    hi: Number(sampleMeans[hiIdx].toFixed(4))
  };
}

export interface CellStats {
  cellKey: string;
  n: number;
  wins: number;
  winRate: number;
  wilson: { lo: number; hi: number; center: number };
  avgNetPct: number;
  profitFactor: number | null;
  expectancyCI95: { lo: number; hi: number } | null;
}

export interface ComputeCellStatsOptions {
  currentConfigVersion?: string;
  halfLifeTrades?: number;
}

/**
 * Computes statistics for a list of trades grouped into cells.
 */
export function computeCellStats(
  trades: any[],
  opts: ComputeCellStatsOptions = {}
): Record<string, CellStats> {
  const halfLifeTrades = opts.halfLifeTrades ?? 150;
  const currentConfigVersion = opts.currentConfigVersion;

  // Filter clean trades
  const clean = trades.filter(isCleanLearningTrade);
  if (clean.length === 0) return {};

  // Sort trades chronologically
  clean.sort((a, b) => (a.closeTime || a.openTime || 0) - (b.closeTime || b.openTime || 0));

  const totalTrades = clean.length;
  // Decay lambda based on trades distance: weight = (0.5) ^ (distance / halfLife)
  const decayBase = Math.pow(0.5, 1 / Math.max(1, halfLifeTrades));

  // Buckets by cellKey: we compute fine, mid, and coarse keys for each trade
  interface TradeSample {
    ret: number;
    weight: number;
    isWin: boolean;
  }

  const buckets: Record<string, TradeSample[]> = {};

  clean.forEach((t, idx) => {
    const keys = cellKeys(t);
    const ret = netReturnPct(t);
    const isWin = ret > 0 || (t.outcome === 1 || t.outcome === 'WIN');

    // Distance from the freshest trade (latest is distance 0)
    const distance = totalTrades - 1 - idx;
    let weight = Math.pow(decayBase, distance);

    // 0.5 discount for trades with another configVersion or no configVersion
    if (currentConfigVersion && (!t.configVersion || t.configVersion !== currentConfigVersion)) {
      weight *= 0.5;
    }

    const sample: TradeSample = { ret, weight, isWin };

    for (const key of [keys.fine, keys.mid, keys.coarse]) {
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(sample);
    }
  });

  const result: Record<string, CellStats> = {};

  for (const [key, samples] of Object.entries(buckets)) {
    const n = samples.length;
    let wins = 0;
    let sumWeight = 0;
    let weightedRetSum = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    const returns: number[] = new Array(n);
    const weights: number[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      returns[i] = s.ret;
      weights[i] = s.weight;
      sumWeight += s.weight;
      weightedRetSum += s.ret * s.weight;

      if (s.isWin) wins++;

      if (s.ret > 0) grossProfit += s.ret * s.weight;
      else if (s.ret < 0) grossLoss += Math.abs(s.ret) * s.weight;
    }

    const winRate = n > 0 ? Number((wins / n).toFixed(4)) : 0;
    const wilson = wilson95(wins, n);
    const avgNetPct = sumWeight > 0 ? Number((weightedRetSum / sumWeight).toFixed(4)) : 0;

    let profitFactor: number | null = null;
    if (grossLoss === 0) {
      profitFactor = grossProfit > 0 ? 10.0 : null;
    } else {
      profitFactor = Number(Math.min(10.0, grossProfit / grossLoss).toFixed(3));
    }

    const expectancyCI95 = n >= 20 ? bootstrapExpectancyCI95(returns, weights, key, 500) : null;

    result[key] = {
      cellKey: key,
      n,
      wins,
      winRate,
      wilson,
      avgNetPct,
      profitFactor,
      expectancyCI95
    };
  }

  return result;
}

export type CellVerdictKind = 'BOOST' | 'NEUTRAL' | 'PENALIZE' | 'BLOCK';

export interface CellVerdict {
  verdict: CellVerdictKind;
  adjustment: number;
  reason: string;
  wouldBlockIfFullPolicy?: boolean;
}

export interface VerdictPolicyOptions {
  protectedPattern?: boolean;
  policy?: 'PENALIZE_ONLY' | 'FULL' | 'IGNORE';
}

/**
 * Computes verdict for cell stats.
 * Rules:
 * - n < 20 -> NEUTRAL, 0
 * - BLOCK: n >= 30 and expectancyCI95.hi < 0 -> adjustment -10 (hard skip in ACTIVE)
 * - PENALIZE: n >= 20, avgNetPct < 0 and PF < 0.9 -> -4; PF < 0.7 -> -7; PF < 0.5 -> -10
 * - BOOST: n >= 30 and expectancyCI95.lo > 0 -> +4; n >= 60 -> +6
 * - Protected patterns:
 *     policy 'PENALIZE_ONLY' (default): BLOCK downgraded to PENALIZE -10 with wouldBlockIfFullPolicy: true
 *     policy 'FULL': treated like normal
 *     policy 'IGNORE': always NEUTRAL, 0
 */
export function verdictForCell(stats: CellStats | undefined, opts: VerdictPolicyOptions = {}): CellVerdict {
  if (!stats || stats.n < 20) {
    return { verdict: 'NEUTRAL', adjustment: 0, reason: stats ? `n=${stats.n} < 20` : 'no_stats' };
  }

  const policy = opts.policy || 'PENALIZE_ONLY';
  const isProtected = opts.protectedPattern === true;

  if (isProtected && policy === 'IGNORE') {
    return { verdict: 'NEUTRAL', adjustment: 0, reason: 'protected_pattern_ignored' };
  }

  const { n, avgNetPct, profitFactor, expectancyCI95 } = stats;

  // 1. BLOCK check
  if (n >= 30 && expectancyCI95 && expectancyCI95.hi < 0) {
    if (isProtected && policy === 'PENALIZE_ONLY') {
      return {
        verdict: 'PENALIZE',
        adjustment: -10,
        reason: `BLOCK downgraded to PENALIZE (-10) for protected pattern: expectancyCI95.hi=${expectancyCI95.hi} < 0 (n=${n})`,
        wouldBlockIfFullPolicy: true
      };
    }
    return {
      verdict: 'BLOCK',
      adjustment: -10,
      reason: `Expectancy CI95 hi=${expectancyCI95.hi} < 0 (n=${n})`
    };
  }

  // 2. PENALIZE check: n >= 20, avgNetPct < 0 and PF < 0.9
  if (avgNetPct < 0 && profitFactor !== null && profitFactor < 0.9) {
    if (profitFactor < 0.5) {
      return {
        verdict: 'PENALIZE',
        adjustment: -10,
        reason: `Severe underperformance: PF=${profitFactor} < 0.5, avgNet=${avgNetPct}% (n=${n})`
      };
    }
    if (profitFactor < 0.7) {
      return {
        verdict: 'PENALIZE',
        adjustment: -7,
        reason: `Underperformance: PF=${profitFactor} < 0.7, avgNet=${avgNetPct}% (n=${n})`
      };
    }
    return {
      verdict: 'PENALIZE',
      adjustment: -4,
      reason: `Moderate underperformance: PF=${profitFactor} < 0.9, avgNet=${avgNetPct}% (n=${n})`
    };
  }

  // 3. BOOST check: n >= 30 and expectancyCI95.lo > 0
  if (n >= 30 && expectancyCI95 && expectancyCI95.lo > 0) {
    const adj = n >= 60 ? 6 : 4;
    return {
      verdict: 'BOOST',
      adjustment: adj,
      reason: `Statistically significant edge: expectancyCI95.lo=${expectancyCI95.lo} > 0 (n=${n})`
    };
  }

  return {
    verdict: 'NEUTRAL',
    adjustment: 0,
    reason: `Inconclusive edge: avgNet=${avgNetPct}%, PF=${profitFactor ?? 'N/A'} (n=${n})`
  };
}

export interface ResolvedVerdictResult {
  cellKey: string;
  level: 'fine' | 'mid' | 'coarse' | 'none';
  n: number;
  stats?: CellStats;
  verdict: CellVerdictKind;
  adjustment: number;
  reason: string;
  wouldBlockIfFullPolicy?: boolean;
}

/**
 * Resolves verdict across hierarchy: fine -> mid -> coarse (choosing the most detailed where n >= 20)
 */
export function resolveVerdict(
  statsMap: Record<string, CellStats>,
  keys: CellKeys,
  opts: VerdictPolicyOptions = {}
): ResolvedVerdictResult {
  const levels: Array<{ name: 'fine' | 'mid' | 'coarse'; key: string }> = [
    { name: 'fine', key: keys.fine },
    { name: 'mid', key: keys.mid },
    { name: 'coarse', key: keys.coarse }
  ];

  for (const lvl of levels) {
    const s = statsMap[lvl.key];
    if (s && s.n >= 20) {
      const v = verdictForCell(s, opts);
      return {
        cellKey: lvl.key,
        level: lvl.name,
        n: s.n,
        stats: s,
        verdict: v.verdict,
        adjustment: v.adjustment,
        reason: v.reason,
        wouldBlockIfFullPolicy: v.wouldBlockIfFullPolicy
      };
    }
  }

  return {
    cellKey: keys.fine,
    level: 'none',
    n: statsMap[keys.fine]?.n || 0,
    verdict: 'NEUTRAL',
    adjustment: 0,
    reason: 'Insufficient samples on all hierarchy levels (n < 20)'
  };
}

export interface WalkForwardGroupStats {
  n: number;
  wins: number;
  winRate: number;
  avgNetPct: number;
  profitFactor: number | null;
  sumNetPct: number;
}

export interface WalkForwardReport {
  evaluatedTradesCount: number;
  groups: Record<CellVerdictKind, WalkForwardGroupStats>;
}

/**
 * Pure walk-forward evaluation without lookahead:
 * For each trade i, cells are computed strictly from trades closed before trade i opened.
 * Limit sample to latest 1500 trades to keep performance fast.
 */
export function walkForwardEvaluate(
  trades: any[],
  opts: {
    maxTrades?: number;
    policy?: 'PENALIZE_ONLY' | 'FULL' | 'IGNORE';
    halfLifeTrades?: number;
  } = {}
): WalkForwardReport {
  const maxTrades = opts.maxTrades ?? 1500;
  const policy = opts.policy || 'PENALIZE_ONLY';

  const clean = trades.filter(isCleanLearningTrade);
  if (clean.length === 0) {
    return {
      evaluatedTradesCount: 0,
      groups: {
        BOOST: { n: 0, wins: 0, winRate: 0, avgNetPct: 0, profitFactor: null, sumNetPct: 0 },
        NEUTRAL: { n: 0, wins: 0, winRate: 0, avgNetPct: 0, profitFactor: null, sumNetPct: 0 },
        PENALIZE: { n: 0, wins: 0, winRate: 0, avgNetPct: 0, profitFactor: null, sumNetPct: 0 },
        BLOCK: { n: 0, wins: 0, winRate: 0, avgNetPct: 0, profitFactor: null, sumNetPct: 0 }
      }
    };
  }

  // Sort by openTime
  clean.sort((a, b) => (a.openTime || a.createdAt || 0) - (b.openTime || b.createdAt || 0));

  const sample = clean.slice(-maxTrades);

  // Group accumulators
  const groupAccum: Record<CellVerdictKind, { returns: number[]; wins: number; sumNet: number; grossProfit: number; grossLoss: number }> = {
    BOOST: { returns: [], wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
    NEUTRAL: { returns: [], wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
    PENALIZE: { returns: [], wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
    BLOCK: { returns: [], wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 }
  };

  // We sort closed trades by closeTime for lookahead-free search
  const closedByCloseTime = [...clean].sort(
    (a, b) => (a.closeTime || a.closedAt || 0) - (b.closeTime || b.closedAt || 0)
  );

  let evaluatedCount = 0;

  for (const trade of sample) {
    const openTs = trade.openTime || trade.createdAt || 0;
    // Strictly trades closed before openTs
    const priorTrades: any[] = [];
    for (const prior of closedByCloseTime) {
      const closeTs = prior.closeTime || prior.closedAt || 0;
      if (closeTs < openTs) {
        priorTrades.push(prior);
      } else {
        break; // since sorted by closeTime
      }
    }

    const priorStats = computeCellStats(priorTrades, { halfLifeTrades: opts.halfLifeTrades });
    const keys = cellKeys(trade);
    const rawPattern = extractPatternFromTrade(trade) || trade?.matchedPattern || '';
    const protectedPattern = isPatternProtected(rawPattern);

    const resolved = resolveVerdict(priorStats, keys, { protectedPattern, policy });
    const ret = netReturnPct(trade);
    const isWin = ret > 0 || trade.outcome === 1 || trade.outcome === 'WIN';

    const g = groupAccum[resolved.verdict];
    g.returns.push(ret);
    g.sumNet += ret;
    if (isWin) g.wins++;
    if (ret > 0) g.grossProfit += ret;
    else if (ret < 0) g.grossLoss += Math.abs(ret);

    evaluatedCount++;
  }

  const makeGroupStats = (kind: CellVerdictKind): WalkForwardGroupStats => {
    const g = groupAccum[kind];
    const n = g.returns.length;
    const wins = g.wins;
    const winRate = n > 0 ? Number((wins / n).toFixed(4)) : 0;
    const avgNetPct = n > 0 ? Number((g.sumNet / n).toFixed(4)) : 0;
    const sumNetPct = Number(g.sumNet.toFixed(2));
    let profitFactor: number | null = null;
    if (g.grossLoss === 0) {
      profitFactor = g.grossProfit > 0 ? 10.0 : null;
    } else {
      profitFactor = Number(Math.min(10.0, g.grossProfit / g.grossLoss).toFixed(3));
    }
    return { n, wins, winRate, avgNetPct, profitFactor, sumNetPct };
  };

  return {
    evaluatedTradesCount: evaluatedCount,
    groups: {
      BOOST: makeGroupStats('BOOST'),
      NEUTRAL: makeGroupStats('NEUTRAL'),
      PENALIZE: makeGroupStats('PENALIZE'),
      BLOCK: makeGroupStats('BLOCK')
    }
  };
}
