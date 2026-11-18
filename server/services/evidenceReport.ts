import path from 'path';
import {
  isCleanLearningTrade,
  netReturnPct,
  bootstrapExpectancyCI95,
  computeCellStats,
  verdictForCell,
  type CellStats,
  type CellVerdictKind
} from './learningCells.ts';
import { extractPatternFromTrade, isPatternProtected } from './signalEngine.ts';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';
import { writeJsonAtomically } from './selfLearningGuard.ts';
import { evaluateEvidenceGate, type EvidenceGateResult } from './evidenceGate.ts';
import { resolveEvidenceTrades } from './tradeArchive.ts';

export interface CohortStats {
  n: number;
  wins: number;
  winRate: number;
  avgNetReturnPct: number;
  sumNetReturnPct: number;
  profitFactor: number | null;
  expectancyCI95: { lo: number; hi: number };
  maxDrawdownPct: number;
}

export interface EvidenceCellSummary {
  cellKey: string;
  pattern: string;
  side: string;
  regime: string;
  n: number;
  wins: number;
  winRate: number;
  avgNetPct: number;
  profitFactor: number | null;
  expectancyCI95: { lo: number; hi: number } | null;
  verdict: CellVerdictKind;
  adjustment: number;
  reason: string;
  protectedPattern: boolean;
  wouldBlockIfFullPolicy: boolean;
}

export interface CostModelEvidenceBreakdown {
  costModelVersion: number;
  summary: CohortStats;
  byPattern: Record<string, CohortStats>;
  byHourUtc: Record<string, CohortStats>;
  bySide: Record<string, CohortStats>;
  byRegimeLegacy: Record<string, CohortStats>;
  byRegimeReal: Record<string, CohortStats>;
  byDataQuality: Record<string, CohortStats>;
}

export interface EvidenceReport {
  generatedAt: string;
  dateUtc: string;
  totalTrades: number;
  closedTrades: number;
  cleanTrades: number;
  excludedTrades: number;
  protectedPatternsPolicy: string;
  evidenceGate: EvidenceGateResult;
  byCostModelVersion: Record<string, CostModelEvidenceBreakdown>;
  cells: EvidenceCellSummary[];
}

export function computeCohortStats(trades: any[], seedKey: string): CohortStats {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      wins: 0,
      winRate: 0,
      avgNetReturnPct: 0,
      sumNetReturnPct: 0,
      profitFactor: null,
      expectancyCI95: { lo: 0, hi: 0 },
      maxDrawdownPct: 0
    };
  }

  const sorted = [...trades].sort(
    (a, b) => (a.closeTime || a.closedAt || a.openTime || 0) - (b.closeTime || b.closedAt || b.openTime || 0)
  );

  const returns: number[] = new Array(n);
  const weights: number[] = new Array(n);
  let wins = 0;
  let sumRet = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let cumRet = 0;
  let peakCum = 0;
  let maxDd = 0;

  for (let i = 0; i < n; i++) {
    const r = netReturnPct(sorted[i]);
    returns[i] = r;
    weights[i] = 1;
    sumRet += r;
    if (r > 0 || sorted[i].outcome === 1 || sorted[i].outcome === 'WIN') wins++;
    if (r > 0) grossProfit += r;
    else if (r < 0) grossLoss += Math.abs(r);

    cumRet += r;
    if (cumRet > peakCum) peakCum = cumRet;
    const dd = peakCum - cumRet;
    if (dd > maxDd) maxDd = dd;
  }

  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? 10.0 : null)
    : Number(Math.min(10.0, grossProfit / grossLoss).toFixed(3));

  return {
    n,
    wins,
    winRate: Number((wins / n).toFixed(4)),
    avgNetReturnPct: Number((sumRet / n).toFixed(4)),
    sumNetReturnPct: Number(sumRet.toFixed(2)),
    profitFactor,
    expectancyCI95: bootstrapExpectancyCI95(returns, weights, seedKey, 500),
    maxDrawdownPct: Number(maxDd.toFixed(2))
  };
}

function groupStatsBy(
  trades: any[],
  keyFn: (t: any) => string,
  seedPrefix: string
): Record<string, CohortStats> {
  const buckets: Record<string, any[]> = {};
  for (const t of trades) {
    const k = keyFn(t) || 'UNKNOWN';
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(t);
  }
  const out: Record<string, CohortStats> = {};
  for (const [k, list] of Object.entries(buckets)) {
    out[k] = computeCohortStats(list, `${seedPrefix}:${k}`);
  }
  return out;
}

function buildCohortBreakdown(trades: any[], versionLabel: string, versionNum: number): CostModelEvidenceBreakdown {
  return {
    costModelVersion: versionNum,
    summary: computeCohortStats(trades, `evidence:${versionLabel}:summary`),
    byPattern: groupStatsBy(
      trades,
      (t) => {
        const raw = extractPatternFromTrade(t) || t?.matchedPattern || t?.patternName || t?.type || 'UNKNOWN';
        return SignalPerformanceAnalyticsService.normalizePattern(raw);
      },
      `evidence:${versionLabel}:pattern`
    ),
    byHourUtc: groupStatsBy(
      trades,
      (t) => {
        const ts = t.openTime || t.createdAt || t.closeTime;
        if (!ts) return 'UNKNOWN';
        const hour = new Date(ts).getUTCHours();
        return Number.isNaN(hour) ? 'UNKNOWN' : String(hour).padStart(2, '0');
      },
      `evidence:${versionLabel}:hour`
    ),
    bySide: groupStatsBy(
      trades,
      (t) => String(t?.side || 'UNKNOWN').toUpperCase(),
      `evidence:${versionLabel}:side`
    ),
    byRegimeLegacy: groupStatsBy(
      trades,
      (t) => String(t?.entryDiagnostics?.regimeLegacy || t?.marketRegime || t?.decisionTrace?.marketRegime || 'UNKNOWN'),
      `evidence:${versionLabel}:regimeLegacy`
    ),
    byRegimeReal: groupStatsBy(
      trades,
      (t) => {
        const shadowReal = t?.entryDiagnostics?.shadow?.regimeReal;
        if (typeof shadowReal === 'string') return shadowReal;
        if (shadowReal && typeof shadowReal === 'object' && shadowReal.regime) return String(shadowReal.regime);
        if (t?.entryDiagnostics?.regimeReal) return String(t.entryDiagnostics.regimeReal);
        return 'UNAVAILABLE';
      },
      `evidence:${versionLabel}:regimeReal`
    ),
    byDataQuality: groupStatsBy(
      trades,
      (t) => String(t?.entryDiagnostics?.dataQuality || t?.dataQuality || 'UNKNOWN'),
      `evidence:${versionLabel}:dataQuality`
    )
  };
}

export function buildEvidenceReport(
  trades: any[],
  settings: any = {},
  learningCellsMap?: Record<string, CellStats>,
  opts: {
    writeSnapshot?: boolean;
    reportsDir?: string;
    nowTs?: number;
    archiveFilePath?: string;
  } = {}
): EvidenceReport {
  const safeTrades = resolveEvidenceTrades(Array.isArray(trades) ? trades : [], settings, opts.archiveFilePath);
  const nowTs = opts.nowTs ?? Date.now();
  const dateUtc = new Date(nowTs).toISOString().split('T')[0];

  const closedTrades = safeTrades.filter(
    (t) => t && (t.status === 'CLOSED' || t.status === 'closed' || !!t.closeTime || !!t.closedAt)
  );
  const cleanTrades = safeTrades.filter(isCleanLearningTrade);

  const byCostVersionBuckets: Record<number, any[]> = {};
  for (const t of cleanTrades) {
    const v = typeof t.costModelVersion === 'number' ? t.costModelVersion : 1;
    if (!byCostVersionBuckets[v]) byCostVersionBuckets[v] = [];
    byCostVersionBuckets[v].push(t);
  }

  const byCostModelVersion: Record<string, CostModelEvidenceBreakdown> = {};
  for (const [vStr, list] of Object.entries(byCostVersionBuckets)) {
    const vNum = Number(vStr);
    const label = `v${vNum}`;
    byCostModelVersion[label] = buildCohortBreakdown(list, label, vNum);
  }

  const s = settings || {};
  const policy: 'PENALIZE_ONLY' | 'FULL' | 'IGNORE' = (s.learningProtectedPatternsPolicy as any) ?? 'PENALIZE_ONLY';

  let cellSource = learningCellsMap && Object.keys(learningCellsMap).length > 0
    ? learningCellsMap
    : computeCellStats(cleanTrades, { halfLifeTrades: s.learningHalfLifeTrades ?? 150 });

  const cells: EvidenceCellSummary[] = Object.entries(cellSource)
    .map(([cellKey, stats]) => {
      const parts = cellKey.split('|');
      const pattern = parts[0] || '';
      const side = parts[1] || 'ALL';
      const regime = parts[2] || 'ALL';
      const protectedPattern = isPatternProtected(pattern);
      const currentVerdict = verdictForCell(stats, { protectedPattern, policy });
      const fullVerdict = verdictForCell(stats, { protectedPattern, policy: 'FULL' });

      return {
        cellKey,
        pattern,
        side,
        regime,
        n: stats.n,
        wins: stats.wins,
        winRate: stats.winRate,
        avgNetPct: stats.avgNetPct,
        profitFactor: stats.profitFactor,
        expectancyCI95: stats.expectancyCI95,
        verdict: currentVerdict.verdict,
        adjustment: currentVerdict.adjustment,
        reason: currentVerdict.reason,
        protectedPattern,
        wouldBlockIfFullPolicy: Boolean(currentVerdict.wouldBlockIfFullPolicy || fullVerdict.verdict === 'BLOCK')
      };
    })
    .sort((a, b) => b.n - a.n);

  const report: EvidenceReport = {
    generatedAt: new Date(nowTs).toISOString(),
    dateUtc,
    totalTrades: safeTrades.length,
    closedTrades: closedTrades.length,
    cleanTrades: cleanTrades.length,
    excludedTrades: closedTrades.length - cleanTrades.length,
    protectedPatternsPolicy: policy,
    evidenceGate: evaluateEvidenceGate(safeTrades, s, nowTs),
    byCostModelVersion,
    cells
  };

  if (opts.writeSnapshot) {
    try {
      const reportsDir = opts.reportsDir || path.resolve(process.cwd(), 'reports');
      const snapshotPath = path.join(reportsDir, `evidence-${dateUtc}.json`);
      writeJsonAtomically(snapshotPath, report);
    } catch (err) {
      console.warn('[EVIDENCE REPORT] Failed saving daily evidence snapshot:', err);
    }
  }

  return report;
}
