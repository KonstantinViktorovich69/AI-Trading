/**
 * G6: Read-only Pattern Performance Report
 *
 * Reads `database.json` and `data/trades-archive.jsonl`, deduplicates closed trades by `id`,
 * groups by `decisionTrace.triggerPattern` (fallback 'UNKNOWN'), `side`, and `dataQuality`,
 * computes n, win-rate, mean & sum pnlPercent (and USD PnL), and 95% bootstrap CI of mean pnlPercent.
 * Prints "выборка мала, выводов нет" whenever n < 30.
 *
 * Usage: npx tsx scripts/patternReport.ts
 */

import fs from 'fs';
import path from 'path';

interface TradeRecord {
  id: string;
  symbol?: string;
  side?: string;
  status?: string;
  pnl?: number;
  pnlPercent?: number;
  openTime?: number;
  closeTime?: number;
  dataQuality?: string;
  entryDiagnostics?: {
    dataQuality?: string;
  };
  decisionTrace?: {
    triggerPattern?: string;
    metadata?: {
      dataQuality?: string;
    };
  };
  _source?: 'database' | 'archive';
}

interface GroupStats {
  pattern: string;
  side: string;
  dataQuality: string;
  n: number;
  wins: number;
  winRatePct: number;
  meanPnlPct: number;
  sumPnlPct: number;
  meanPnlUsd: number;
  sumPnlUsd: number;
  ci95Low: number;
  ci95High: number;
  note: string;
}

function createMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMeanCi95(values: number[], iterations = 2000, seed = 20261114): [number, number] {
  if (values.length === 0) return [0, 0];
  if (values.length === 1) return [values[0], values[0]];
  const rng = createMulberry32(seed);
  const n = values.length;
  const means = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += values[idx];
    }
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.max(0, Math.floor(iterations * 0.025));
  const hiIdx = Math.min(iterations - 1, Math.floor(iterations * 0.975));
  return [means[loIdx], means[hiIdx]];
}

function readTrades(): {
  allDeduped: TradeRecord[];
  dbOnlyCount: number;
  archiveLinesCount: number;
  archiveUniqueCount: number;
  archiveInternalDupes: number;
  overlapCount: number;
} {
  const root = process.cwd();
  const dbPath = path.join(root, 'database.json');
  const archivePath = path.join(root, 'data', 'trades-archive.jsonl');

  const byId = new Map<string, TradeRecord>();
  const dbIds = new Set<string>();
  const archiveIds = new Set<string>();
  let dbOnlyCount = 0;
  let archiveLinesCount = 0;
  let archiveInternalDupes = 0;
  let overlapCount = 0;

  if (fs.existsSync(dbPath)) {
    const rawDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const trades = Array.isArray(rawDb?.trades) ? rawDb.trades : [];
    for (const t of trades) {
      if (!t || !t.id) continue;
      dbOnlyCount++;
      const id = String(t.id);
      dbIds.add(id);
      byId.set(id, { ...t, _source: 'database' });
    }
  }

  if (fs.existsSync(archivePath)) {
    const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        if (!t || !t.id) continue;
        archiveLinesCount++;
        const id = String(t.id);
        if (archiveIds.has(id)) {
          archiveInternalDupes++;
        } else {
          archiveIds.add(id);
        }
        if (dbIds.has(id)) {
          overlapCount++;
        } else if (!byId.has(id)) {
          byId.set(id, { ...t, _source: 'archive' });
        }
      } catch {
        // skip malformed jsonl line
      }
    }
  }

  return {
    allDeduped: Array.from(byId.values()),
    dbOnlyCount,
    archiveLinesCount,
    archiveUniqueCount: archiveIds.size,
    archiveInternalDupes,
    overlapCount
  };
}

function getPattern(t: TradeRecord): string {
  const raw = t.decisionTrace?.triggerPattern;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return 'UNKNOWN';
}

function getDataQuality(t: TradeRecord): string {
  const q = t.entryDiagnostics?.dataQuality || t.decisionTrace?.metadata?.dataQuality || t.dataQuality;
  if (typeof q === 'string' && q.trim().length > 0) {
    return q.trim();
  }
  return 'UNKNOWN';
}

function getSide(t: TradeRecord): string {
  const s = t.side;
  if (typeof s === 'string' && s.trim().length > 0) {
    return s.trim().toUpperCase();
  }
  return 'UNKNOWN';
}

function computeGroupStats(
  trades: TradeRecord[],
  keyFn: (t: TradeRecord) => { pattern: string; side: string; dataQuality: string }
): GroupStats[] {
  const buckets = new Map<string, { meta: { pattern: string; side: string; dataQuality: string }; items: TradeRecord[] }>();

  for (const t of trades) {
    if (t.status !== 'CLOSED') continue;
    const meta = keyFn(t);
    const key = `${meta.pattern}|||${meta.side}|||${meta.dataQuality}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { meta, items: [] };
      buckets.set(key, entry);
    }
    entry.items.push(t);
  }

  const results: GroupStats[] = [];
  for (const [idxKey, { meta, items }] of buckets.entries()) {
    const n = items.length;
    const pnlPcts = items.map(t => (typeof t.pnlPercent === 'number' && isFinite(t.pnlPercent) ? t.pnlPercent : 0));
    const pnlUsds = items.map(t => (typeof t.pnl === 'number' && isFinite(t.pnl) ? t.pnl : 0));
    const wins = items.filter(t => (typeof t.pnlPercent === 'number' ? t.pnlPercent > 0 : (t.pnl || 0) > 0)).length;
    const sumPnlPct = pnlPcts.reduce((a, b) => a + b, 0);
    const sumPnlUsd = pnlUsds.reduce((a, b) => a + b, 0);
    const meanPnlPct = n > 0 ? sumPnlPct / n : 0;
    const meanPnlUsd = n > 0 ? sumPnlUsd / n : 0;
    const winRatePct = n > 0 ? (wins / n) * 100 : 0;
    const seedOffset = Array.from(idxKey).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const [ci95Low, ci95High] = bootstrapMeanCi95(pnlPcts, 2000, 20261114 + seedOffset);

    results.push({
      pattern: meta.pattern,
      side: meta.side,
      dataQuality: meta.dataQuality,
      n,
      wins,
      winRatePct,
      meanPnlPct,
      sumPnlPct,
      meanPnlUsd,
      sumPnlUsd,
      ci95Low,
      ci95High,
      note: n < 30 ? 'выборка мала, выводов нет' : 'OK (n >= 30)'
    });
  }

  results.sort((a, b) => b.n - a.n || a.pattern.localeCompare(b.pattern));
  return results;
}

function formatTable(rows: GroupStats[], includeSideAndQuality: boolean): string {
  const lines: string[] = [];
  if (includeSideAndQuality) {
    lines.push('Pattern | Side | DataQuality | n | Wins | WinRate | Mean pnl% | Sum pnl% | 95% CI mean% | Note');
    lines.push('---|---|---|---:|---:|---:|---:|---:|---|---|');
    for (const r of rows) {
      lines.push(
        `${r.pattern} | ${r.side} | ${r.dataQuality} | ${r.n} | ${r.wins} | ${r.winRatePct.toFixed(1)}% | ${r.meanPnlPct.toFixed(2)}% | ${r.sumPnlPct.toFixed(2)}% | [${r.ci95Low.toFixed(2)}%, ${r.ci95High.toFixed(2)}%] | ${r.note}`
      );
    }
  } else {
    lines.push('Pattern | n | Wins | WinRate | Mean pnl% | Sum pnl% | Sum USD | 95% CI mean% | Note');
    lines.push('---|---:|---:|---:|---:|---:|---:|---|---|');
    for (const r of rows) {
      lines.push(
        `${r.pattern} | ${r.n} | ${r.wins} | ${r.winRatePct.toFixed(1)}% | ${r.meanPnlPct.toFixed(2)}% | ${r.sumPnlPct.toFixed(2)}% | $${r.sumPnlUsd.toFixed(2)} | [${r.ci95Low.toFixed(2)}%, ${r.ci95High.toFixed(2)}%] | ${r.note}`
      );
    }
  }
  return lines.join('\n');
}

function main() {
  const {
    allDeduped,
    dbOnlyCount,
    archiveLinesCount,
    archiveUniqueCount,
    archiveInternalDupes,
    overlapCount
  } = readTrades();
  const closedAll = allDeduped.filter(t => t.status === 'CLOSED');
  const closedDbOnly = closedAll.filter(t => t._source === 'database');

  console.log('=== G6 PATTERN REPORT (READ-ONLY) ===');
  console.log(`database.json total records: ${dbOnlyCount} (closed: ${closedDbOnly.length})`);
  console.log(
    `data/trades-archive.jsonl lines: ${archiveLinesCount} (unique IDs: ${archiveUniqueCount}, internal duplicates: ${archiveInternalDupes})`
  );
  console.log(`Overlap DB vs archive by ID: ${overlapCount}`);
  console.log(`Unique deduplicated CLOSED trades: ${closedAll.length}`);
  console.log('');

  console.log('--- 1. DATABASE.JSON ONLY BY triggerPattern (comparable to 0ce49e0 slice) ---');
  const dbByPat = computeGroupStats(closedDbOnly, t => ({
    pattern: getPattern(t),
    side: 'ALL',
    dataQuality: 'ALL'
  }));
  console.log(formatTable(dbByPat, false));
  console.log('');

  console.log('--- 2. ALL UNIQUE CLOSED TRADES (DB + ARCHIVE) BY (triggerPattern, side, dataQuality) ---');
  const fullGrouped = computeGroupStats(closedAll, t => ({
    pattern: getPattern(t),
    side: getSide(t),
    dataQuality: getDataQuality(t)
  }));
  console.log(formatTable(fullGrouped, true));
  console.log('');

  console.log('--- 3. ALL UNIQUE CLOSED TRADES (DB + ARCHIVE) BY triggerPattern ---');
  const fullByPat = computeGroupStats(closedAll, t => ({
    pattern: getPattern(t),
    side: 'ALL',
    dataQuality: 'ALL'
  }));
  console.log(formatTable(fullByPat, false));
}

main();
