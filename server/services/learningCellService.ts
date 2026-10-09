import path from 'path';
import fs from 'fs';
import {
  computeCellStats,
  resolveVerdict,
  verdictForCell,
  cellKeys,
  type CellStats,
  type ResolvedVerdictResult,
  type VerdictPolicyOptions
} from './learningCells.ts';
import { getConfigVersion } from './buildInfo.ts';
import { isPatternProtected } from './signalEngine.ts';
import { SignalPerformanceAnalyticsService } from './signalPerformanceAnalyticsService.ts';

const LEARNING_CELLS_FILE = path.resolve(process.cwd(), 'data/learning-cells.json');

export type AggregatedLearningMode = 'OFF' | 'SHADOW' | 'ACTIVE';
export type ProtectedPatternsPolicy = 'PENALIZE_ONLY' | 'FULL' | 'IGNORE';

export interface LearningCellServiceConfig {
  aggregatedLearningMode: AggregatedLearningMode;
  learningProtectedPatternsPolicy: ProtectedPatternsPolicy;
  learningHalfLifeTrades: number;
}

let cachedStatsMap: Record<string, CellStats> = {};
let lastRecomputeTime = 0;
let debounceTimer: NodeJS.Timeout | null = null;

function ensureDataDir(): void {
  const dir = path.dirname(LEARNING_CELLS_FILE);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

function writeAtomicJson(filePath: string, data: any): void {
  ensureDataDir();
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    console.warn('[LEARNING CELL SERVICE] Could not save cells file:', err);
  }
}

function loadSavedCells(): Record<string, CellStats> {
  try {
    if (fs.existsSync(LEARNING_CELLS_FILE)) {
      const raw = fs.readFileSync(LEARNING_CELLS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[LEARNING CELL SERVICE] Could not load learning-cells.json:', err);
  }
  return {};
}

// Initial load on import
try {
  cachedStatsMap = loadSavedCells();
} catch {}

/**
 * Recomputes cells given current virtual trades and settings.
 * Saves state atomically to data/learning-cells.json.
 */
export function recomputeLearningCells(
  trades: any[],
  settings: any = {}
): Record<string, CellStats> {
  try {
    const configVersion = getConfigVersion(settings);
    const halfLifeTrades = (settings as any).learningHalfLifeTrades ?? 150;

    const stats = computeCellStats(trades, {
      currentConfigVersion: configVersion,
      halfLifeTrades
    });

    cachedStatsMap = stats;
    lastRecomputeTime = Date.now();
    writeAtomicJson(LEARNING_CELLS_FILE, cachedStatsMap);
    return cachedStatsMap;
  } catch (err: any) {
    console.warn('[LEARNING CELL SERVICE] Error recomputing cells:', err?.message || err);
    return cachedStatsMap;
  }
}

/**
 * Debounced trigger for recomputing learning cells (30 seconds debounce).
 */
export function scheduleLearningCellsRecompute(
  getTrades: () => any[],
  getSettings: () => any
): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    try {
      const trades = getTrades();
      const settings = getSettings();
      recomputeLearningCells(trades, settings);
    } catch (err: any) {
      console.warn('[LEARNING CELL SERVICE] Error in scheduled recompute:', err?.message || err);
    }
  }, 30000);
}

export interface GetCellVerdictParams {
  pattern: string;
  side: string;
  regime?: string;
  settings?: any;
}

/**
 * Evaluates the cell verdict for a prospective candidate signal.
 */
export function getCellVerdict(params: GetCellVerdictParams): ResolvedVerdictResult {
  const normPattern = SignalPerformanceAnalyticsService.normalizePattern(params.pattern);
  const side = (params.side || 'LONG').toUpperCase();
  const regime = params.regime || 'NEUTRAL';

  const keys = {
    fine: `${normPattern}|${side}|${regime}`,
    mid: `${normPattern}|${side}`,
    coarse: `${normPattern}`
  };

  const settings = params.settings || {};
  const policy: ProtectedPatternsPolicy = (settings as any).learningProtectedPatternsPolicy ?? 'PENALIZE_ONLY';
  const protectedPattern = isPatternProtected(params.pattern);

  return resolveVerdict(cachedStatsMap, keys, {
    protectedPattern,
    policy
  });
}

/**
 * Returns all current cached cells.
 */
export function getAllLearningCells(): Record<string, CellStats> {
  return cachedStatsMap;
}

/**
 * Resets memory state (useful for tests)
 */
export function resetLearningCellServiceForTest(): void {
  cachedStatsMap = {};
  lastRecomputeTime = 0;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
