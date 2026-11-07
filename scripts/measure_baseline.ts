import fs from 'fs';
import path from 'path';

// Standalone implementation matching server/services/learningCells.ts
function netReturnPct(t: any): number {
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

function extractPattern(t: any): string {
  if (!t) return 'UNKNOWN';
  const raw = t.triggerPattern ||
              t.pattern ||
              t.decisionTrace?.triggerPattern ||
              t.patternName ||
              t.matchedPattern ||
              (t.decisionTrace?.agentVotes && t.decisionTrace.agentVotes.map((v: any) => v.reason).find((r: string) => r && r.includes('Обнаружен паттерн'))) ||
              (Array.isArray(t.matchedRuleIds) && t.matchedRuleIds.find((r: string) => !r.startsWith('RULE_')));
  if (typeof raw === 'string') {
    const clean = raw.replace(/^Обнаружен паттерн\s*["«]/, '').replace(/["»]$/, '').trim();
    if (clean && clean !== 'GENERAL' && clean !== 'OPEN' && clean !== 'CLOSE' && clean !== 'AVERAGE') {
      return clean;
    }
  }
  return 'UNKNOWN';
}

interface MetricSummary {
  count: number;
  wins: number;
  losses: number;
  winRatePct: number;
  meanNetReturnPct: number;
  grossProfitPct: number;
  grossLossPct: number;
  profitFactor: number | null;
}

function computeMetrics(trades: any[]): MetricSummary {
  const n = trades.length;
  if (n === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      meanNetReturnPct: 0,
      grossProfitPct: 0,
      grossLossPct: 0,
      profitFactor: null
    };
  }

  let wins = 0;
  let losses = 0;
  let sumNetPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    const ret = netReturnPct(t);
    sumNetPct += ret;
    if (ret > 0) {
      wins++;
      grossProfit += ret;
    } else if (ret < 0) {
      losses++;
      grossLoss += Math.abs(ret);
    }
  }

  const winRatePct = Number(((wins / n) * 100).toFixed(2));
  const meanNetReturnPct = Number((sumNetPct / n).toFixed(4));
  const grossProfitPct = Number(grossProfit.toFixed(4));
  const grossLossPct = Number(grossLoss.toFixed(4));
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? 10.0 : null)
    : Number((grossProfit / grossLoss).toFixed(3));

  return {
    count: n,
    wins,
    losses,
    winRatePct,
    meanNetReturnPct,
    grossProfitPct,
    grossLossPct,
    profitFactor
  };
}

function getUtcHourBlock(t: any): string {
  const ts = t.openTime || t.timestamp || t.createdAt;
  if (!ts) return 'UNKNOWN';
  const hour = new Date(ts).getUTCHours();
  if (hour >= 0 && hour < 6) return '00-06';
  if (hour >= 6 && hour < 12) return '06-12';
  if (hour >= 12 && hour < 18) return '12-18';
  return '18-24';
}

function analyzeDataset(trades: any[]) {
  const overall = computeMetrics(trades);

  // Group by pattern
  const byPatternMap: Record<string, any[]> = {};
  for (const t of trades) {
    const pat = extractPattern(t);
    if (!byPatternMap[pat]) byPatternMap[pat] = [];
    byPatternMap[pat].push(t);
  }
  const byPattern: Record<string, MetricSummary> = {};
  for (const [pat, list] of Object.entries(byPatternMap)) {
    byPattern[pat] = computeMetrics(list);
  }

  // Group by UTC Hour block
  const byHourBlockMap: Record<string, any[]> = {
    '00-06': [],
    '06-12': [],
    '12-18': [],
    '18-24': []
  };
  for (const t of trades) {
    const block = getUtcHourBlock(t);
    if (byHourBlockMap[block]) byHourBlockMap[block].push(t);
  }
  const byUtcHour: Record<string, MetricSummary> = {};
  for (const [block, list] of Object.entries(byHourBlockMap)) {
    byUtcHour[block] = computeMetrics(list);
  }

  // Group by Side
  const bySideMap: Record<string, any[]> = { LONG: [], SHORT: [] };
  for (const t of trades) {
    const side = (t.side || '').toUpperCase();
    if (bySideMap[side]) bySideMap[side].push(t);
  }
  const bySide: Record<string, MetricSummary> = {};
  for (const [side, list] of Object.entries(bySideMap)) {
    bySide[side] = computeMetrics(list);
  }

  // Feature completeness
  const total = trades.length;
  const withFeatures = trades.filter(t => t.features && typeof t.features === 'object' && Object.keys(t.features).length > 0).length;
  const withEntryDiagnostics = trades.filter(t => t.entryDiagnostics && typeof t.entryDiagnostics === 'object').length;
  const withFeaturesV2 = trades.filter(t => t.entryDiagnostics?.featuresV2 && typeof t.entryDiagnostics.featuresV2 === 'object').length;
  const withQuantPV2 = trades.filter(t => {
    const v = t.quantPV2 ?? t.entryDiagnostics?.quantPV2;
    return typeof v === 'number' && !isNaN(v);
  }).length;

  return {
    overall,
    byPattern,
    byUtcHour,
    bySide,
    featureCompleteness: {
      totalClosedTrades: total,
      withFeatures: { count: withFeatures, pct: total > 0 ? Number(((withFeatures / total) * 100).toFixed(2)) : 0 },
      withEntryDiagnostics: { count: withEntryDiagnostics, pct: total > 0 ? Number(((withEntryDiagnostics / total) * 100).toFixed(2)) : 0 },
      withFeaturesV2: { count: withFeaturesV2, pct: total > 0 ? Number(((withFeaturesV2 / total) * 100).toFixed(2)) : 0 },
      withQuantPV2: { count: withQuantPV2, pct: total > 0 ? Number(((withQuantPV2 / total) * 100).toFixed(2)) : 0 }
    }
  };
}

async function main() {
  const dbPath = path.join(process.cwd(), 'database.json');
  const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const dbTrades = (dbData.trades || []).filter((t: any) => t && (t.status === 'CLOSED' || t.status === 'closed' || t.closedAt || t.closeTime));

  const archivePath = path.join(process.cwd(), 'data', 'trades-archive.jsonl');
  let archiveTrades: any[] = [];
  if (fs.existsSync(archivePath)) {
    archiveTrades = fs.readFileSync(archivePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((t: any) => t && (t.status === 'CLOSED' || t.status === 'closed' || t.closedAt || t.closeTime));
  }

  // Unique trades across database.json and archive
  const tradeMap = new Map<string, any>();
  for (const t of dbTrades) { if (t.id) tradeMap.set(t.id, t); }
  for (const t of archiveTrades) { if (t.id && !tradeMap.has(t.id)) tradeMap.set(t.id, t); }
  const allUniqueClosed = Array.from(tradeMap.values());

  const result = {
    generatedAt: new Date().toISOString(),
    databaseJsonTrades: analyzeDataset(dbTrades),
    allHistoricalTrades: analyzeDataset(allUniqueClosed)
  };

  const outputPath = path.join(process.cwd(), 'reports', 'baseline_trades_20261107.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[BASELINE] Baseline trade metrics saved to ${outputPath}`);
  console.log('--- DATABASE.JSON SUMMARY ---');
  console.log(JSON.stringify(result.databaseJsonTrades.overall, null, 2));
  console.log('--- ALL HISTORICAL TRADES SUMMARY ---');
  console.log(JSON.stringify(result.allHistoricalTrades.overall, null, 2));
}

main().catch(err => {
  console.error('[BASELINE ERROR]', err);
  process.exit(1);
});
