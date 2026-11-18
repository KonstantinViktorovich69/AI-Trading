/**
 * H4 / G7 v2: Honest Offline Historical Backtest on Top-30 WEEX USDT Futures
 *
 * Pure scanner functions imported directly from production code (never rewritten from memory):
 *   1) server/services/patternScannerService.ts -> detectTradingPatterns()
 *   2) server/services/marketSignalScanner.ts  -> evaluateScannerPatternPure()
 *   3) server/services/marketDataCollectorService.ts -> computeVolumeSpikeRatio()
 *   4) server/services/exitPolicy.ts -> evaluateExitPolicy()
 *
 * v2 Methodological Fixes (addressing Round 7 H4):
 *   - One active position per symbol per timeframe/engine (no overlapping trades per pattern/side).
 *   - Separate Gross ROE% (before costs) and Net ROE% (0.16%, 0.20%, 0.30% RT).
 *   - Non-compounded Max Drawdown measured in percentage points of ROE (п.п. ROE) on fixed-size equity curve.
 *   - 200-run Monte Carlo random entry baseline per group (reporting 95th percentile & "Лучше случайного").
 *   - Top-30 WEEX USDT Perpetuals universe by 24h turnover (excluding synthetic equity symbols).
 *   - Pre-committed OOS-40% Pass Criterion (defined before running results):
 *       OOS n >= 30 && OOS Mean Net@(0.20%) > 0 && OOS CI95 lo > 0 && OOS Mean Net@(0.20%) > OOS Rand p95
 *
 * Anti-lookahead discipline:
 *   - Signal detected strictly after candle `t` closes.
 *   - Entry executes at open price of candle `t + 1`.
 *   - Conservative intra-bar tie-breaker: SL evaluated before TP on same bar when 1m sub-bars unavailable.
 *
 * Usage: npx tsx scripts/backtestPatterns.ts [--top=30] [--concurrency=5]
 */

import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';
import { RSI, BollingerBands, VWAP, PSAR, ATR } from 'technicalindicators';
import { detectTradingPatterns, type Candle } from '../server/services/patternScannerService.ts';
import { evaluateScannerPatternPure, isTraditionalEquitySymbol } from '../server/services/marketSignalScanner.ts';
import { computeVolumeSpikeRatio } from '../server/services/marketDataCollectorService.ts';
import { evaluateExitPolicy, type ExitPolicySettings, type ExitTradeSnapshot } from '../server/services/exitPolicy.ts';
import { calculateStructuralStopLoss } from '../server/services/structuralExitLevels.ts';

const FALLBACK_TOP30_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'SOLUSDT', 'XRPUSDT',
  'IDOLUSDT', 'XPINUSDT', 'ZECUSDT', 'BCHUSDT', 'DOGEUSDT',
  'ATOMUSDT', 'AVAXUSDT', 'LINKUSDT', 'BNBUSDT', 'BTWUSDT',
  'CROSSUSDT', 'ZAMAUSDT', 'KGENUSDT', 'TRXUSDT', 'SUIUSDT',
  'LTCUSDT', 'ADAUSDT', 'UNIUSDT', 'HYPEUSDT', 'XLMUSDT',
  'ASTERUSDT', 'BZUSDT', 'THETAUSDT', 'DOTUSDT', 'AKEUSDT'
];

// Fixed liquid benchmark universe (independent of current 24h turnover spikes to measure survivorship/recency bias)
const FIXED_CONTROL_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'BCHUSDT', 'TRXUSDT', 'DOTUSDT', 'ATOMUSDT', 'UNIUSDT',
  'SUIUSDT', 'XLMUSDT', 'XMRUSDT', 'HYPEUSDT', 'ZECUSDT'
];

const USE_FIXED_UNIVERSE = process.argv.includes('--fixed-universe');

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'backtest_cache');
const AMBIGUOUS_1M_SLICE_CACHE_FILE = path.join(CACHE_DIR, '1m_ambiguous_slices.json');
const REPORT_JSON_OUT = path.resolve(process.cwd(), 'reports', 'diagnostics_2026-11-14', 'g7_backtest_summary.json');
const REPORT_TXT_OUT = path.resolve(process.cwd(), 'reports', 'diagnostics_2026-11-14', 'g7_backtest_report.txt');

const DAYS_15M = 180;
const DAYS_1M = 60;
const LEVERAGE = 5;
const STOP_LOSS_PCT = 0.02;   // 2.0% unleveraged => -10.0% ROE before costs
const TAKE_PROFIT_PCT = 0.03; // 3.0% unleveraged => +15.0% ROE before costs
const MONTE_CARLO_RUNS = 200;
const MULTIPLE_TESTING_M_PROD = 16; // 16 production marketSignalScanner patterns (8 SHORT + 8 LONG); patternScannerService excluded (not production)

// PRE-COMMITTED OOS PASS CRITERION (locked before inspecting v2 results)
const OOS_PASS_CRITERION_TEXT =
  'OOS-40% PASS <=> (n >= 30) AND (Mean Net@(0.20%) > 0%) AND (95% CI lo > 0%) AND (Mean Net@(0.20%) > Rand p95@(0.20%))';

type EngineName = 'patternScannerService' | 'marketSignalScanner';
type TieBreakerMode = 'SL_FIRST' | 'TP_FIRST' | '1M_RESOLVED';

interface RawWeexKline extends Array<any> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: number;
}

interface SimTrade {
  engine: EngineName;
  symbol: string;
  timeframe: '15m' | '1m';
  patternName: string;
  side: 'LONG' | 'SHORT';
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reasonCode: string;
  unleveragedGrossPct: number;
  leveragedGrossPct: number;
  leveragedNetPct016: number;
  leveragedNetPct020: number;
  leveragedNetPct030: number;
  used1mExecution: boolean;
  encounteredAmbiguousBar: boolean;
  ambiguousBarTime: number | null;
  change24hPct: number;
  range24hPct: number;
  atrAtEntry: number;
  localHigh: number;
  localLow: number;
  entryCandleIdx: number;
}

interface ExecOutcome {
  exitPrice: number;
  exitTime: number;
  reasonCode: string;
  unleveragedGrossPct: number;
  leveragedGrossPct: number;
  leveragedNetPct016: number;
  leveragedNetPct020: number;
  leveragedNetPct030: number;
  used1mExecution: boolean;
  encounteredAmbiguousBar: boolean;
  ambiguousBarTime: number | null;
  resolvedVia1mSlice: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Regularized incomplete beta I_x(a, b) via Lentz continued fraction for exact Student-t CDF
function logGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) {
    x += p[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function studentTOneSidedUpperP(tStat: number, df: number): number {
  if (!Number.isFinite(tStat) || df < 1) return 1;
  const x = df / (df + tStat * tStat);
  const twoSided = betainc(x, df / 2, 0.5);
  return tStat >= 0 ? twoSided / 2 : 1 - twoSided / 2;
}

function computeOneSampleTTest(values: number[]): { tStat: number; df: number; pOneSided: number; pTwoSided: number; sd: number } {
  const n = values.length;
  if (n < 2) return { tStat: 0, df: 0, pOneSided: 1, pTwoSided: 1, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) {
    const pOne = mean > 0 ? 0 : 1;
    return { tStat: mean > 0 ? 999 : mean < 0 ? -999 : 0, df: n - 1, pOneSided: pOne, pTwoSided: mean === 0 ? 1 : 0, sd: 0 };
  }
  const se = sd / Math.sqrt(n);
  const tStat = mean / se;
  const pOneSided = studentTOneSidedUpperP(tStat, n - 1);
  const pTwoSided = Math.min(1, 2 * Math.min(pOneSided, 1 - pOneSided));
  return { tStat, df: n - 1, pOneSided, pTwoSided, sd };
}

function bootstrapMeanCi95(values: number[], iterations = 2000, seed = 20261115): [number, number] {
  if (values.length === 0) return [0, 0];
  if (values.length === 1) return [values[0], values[0]];
  const rng = createMulberry32(seed);
  const n = values.length;
  const means = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += values[Math.floor(rng() * n)];
    }
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.max(0, Math.floor(iterations * 0.025))],
    means[Math.min(iterations - 1, Math.floor(iterations * 0.975))]
  ];
}

// Non-compounded drawdown measured in percentage points of ROE on cumulative ROE curve
function maxDrawdownRoePp(returnsPct: number[]): number {
  let equityPp = 0;
  let peakPp = 0;
  let maxDdPp = 0;
  for (const r of returnsPct) {
    equityPp += r;
    if (equityPp > peakPp) peakPp = equityPp;
    const dd = peakPp - equityPp;
    if (dd > maxDdPp) maxDdPp = dd;
  }
  return maxDdPp;
}

async function resolveTop30WeexSymbols(targetCount = 30): Promise<{ symbols: string[]; source: string; topDetails: Array<{ symbol: string; quoteVolume: number }> }> {
  try {
    const weex = new (ccxt as any).weex({
      enableRateLimit: false,
      timeout: 25000,
      options: { defaultType: 'swap' },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacktestResearch/2.0)' }
    });
    const tickers = await weex.fetchTickers(undefined, { type: 'swap' });
    const dedup = new Map<string, number>();
    for (const [rawSym, t] of Object.entries<any>(tickers || {})) {
      const baseClean = rawSym.split(':')[0].replace(/[\/:]/g, '').toUpperCase();
      if (!baseClean.endsWith('USDT') || isTraditionalEquitySymbol(baseClean)) continue;
      const qVol = Number(t?.quoteVolume ?? 0);
      if (!Number.isFinite(qVol) || qVol <= 0) continue;
      const prev = dedup.get(baseClean) || 0;
      if (qVol > prev) dedup.set(baseClean, qVol);
    }
    const sorted = Array.from(dedup.entries())
      .map(([symbol, quoteVolume]) => ({ symbol, quoteVolume }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);

    if (sorted.length >= targetCount) {
      const top = sorted.slice(0, targetCount);
      return {
        symbols: top.map(x => x.symbol),
        source: `live WEEX ccxt.fetchTickers (${sorted.length} non-equity USDT perpetuals)`,
        topDetails: top
      };
    }
  } catch (err: any) {
    console.warn(`[UNIVERSE WARN] Live WEEX ticker fetch failed (${err?.message || err}); using fallback Top-30 list.`);
  }
  return {
    symbols: FALLBACK_TOP30_SYMBOLS.slice(0, targetCount),
    source: 'fallback Top-30 list',
    topDetails: FALLBACK_TOP30_SYMBOLS.slice(0, targetCount).map(symbol => ({ symbol, quoteVolume: 0 }))
  };
}

async function fetchWeexHistoryChunk(
  symbol: string,
  interval: '15m' | '1m',
  startTime: number,
  endTime: number,
  limit = 100
): Promise<Candle[]> {
  const url =
    `https://api-contract.weex.com/capi/v3/market/historyKlines` +
    `?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacktestResearch/2.0)' },
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) {
        if (resp.status === 429 || resp.status >= 500) {
          await sleep(600 * attempt);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const raw = (await resp.json()) as RawWeexKline[];
      if (!Array.isArray(raw)) return [];
      return raw
        .map(row => ({
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5])
        }))
        .filter(c => Number.isFinite(c.time) && c.open > 0 && c.close > 0);
    } catch {
      if (attempt === 4) {
        return [];
      }
      await sleep(500 * attempt);
    }
  }
  return [];
}

async function loadOrDownloadCandles(symbol: string, interval: '15m' | '1m', days: number, onlyIfCached = false): Promise<Candle[]> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_${interval}_${days}d.json`);
  const barMs = interval === '15m' ? 15 * 60 * 1000 : 60 * 1000;
  const expectedMinBars = Math.floor((days * 24 * 3600 * 1000) / barMs * 0.75);

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Candle[];
      if (Array.isArray(cached) && (onlyIfCached || cached.length >= expectedMinBars || cached.length >= 200)) {
        return cached;
      }
    } catch {
      if (onlyIfCached) return [];
    }
  }
  if (onlyIfCached) return [];

  const endMs = Math.floor(Date.now() / barMs) * barMs;
  const startMs = endMs - days * 24 * 3600 * 1000;
  const chunkSpanMs = 100 * barMs;

  const windows: Array<{ s: number; e: number }> = [];
  for (let s = startMs; s < endMs; s += chunkSpanMs) {
    windows.push({ s, e: Math.min(endMs, s + chunkSpanMs - barMs) });
  }

  const byTime = new Map<number, Candle>();
  for (let i = 0; i < windows.length; i += 12) {
    const batch = windows.slice(i, i + 12);
    const results = await Promise.all(
      batch.map(w => fetchWeexHistoryChunk(symbol, interval, w.s, w.e, 100))
    );
    for (const candles of results) {
      for (const c of candles) {
        byTime.set(c.time, c);
      }
    }
    await sleep(60);
  }

  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (sorted.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(sorted), 'utf8');
  }
  return sorted;
}

function build1mIndex(candles1m: Candle[]): { times: number[]; candles: Candle[] } {
  return {
    times: candles1m.map(c => c.time),
    candles: candles1m
  };
}

function findFirstIndexGte(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function loadAmbiguous1mSliceCache(): Record<string, Candle[]> {
  try {
    if (fs.existsSync(AMBIGUOUS_1M_SLICE_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AMBIGUOUS_1M_SLICE_CACHE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

function saveAmbiguous1mSliceCache(cache: Record<string, Candle[]>) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(AMBIGUOUS_1M_SLICE_CACHE_FILE, JSON.stringify(cache), 'utf8');
}

const EXIT_POLICY_SETTINGS: ExitPolicySettings = {
  enablePttp: true,
  enableTimeLimitExit: true,
  enableStagnationTimeout: true,
  timeoutStagnationHours: 8.0,
  maxStagnationPnlPct: 0.5,
  maxLifetimeHours: 24,
  allowEmergencyMaxLifetime: true,
  minNormalAutoCloseNetPnlPct: 4.0,
  estimatedFeePct: 0.0008,
  estimatedSlippagePct: 0.0004
};

const LIVE_EXIT_POLICY_SETTINGS: ExitPolicySettings = {
  enablePttp: true,
  enableTimeLimitExit: true,
  enableStagnationTimeout: true,
  timeoutStagnationHours: 8.0,
  maxStagnationPnlPct: 0.5,
  maxLifetimeHours: 24,
  allowEmergencyMaxLifetime: true,
  timeoutProfitHours: 18,
  minTimeoutProfitNetPnlPct: 6.0,
  minNormalAutoCloseNetPnlPct: 6.0,
  bypassProfitFloorForPrimaryTp: true,
  bypassProfitFloorForMultiTp: true,
  enableTrailingStop: true,
  trailingStopTriggerPnlPct: 14.0,
  trailingStopDistancePct: 3.0,
  estimatedFeePct: 0.0006,
  estimatedSlippagePct: 0.0004
};

function executeSingleTradeAtEntry(
  symbol: string,
  timeframe: '15m' | '1m',
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number,
  candles: Candle[],
  candles1mIdx: { times: number[]; candles: Candle[] } | null,
  tieMode: TieBreakerMode = 'SL_FIRST',
  ambiguous1mSlices?: Record<string, Candle[]>
): ExecOutcome {
  const entryCandle = candles[entryCandleIdx];
  const entryPrice = entryCandle.open;
  const entryTime = entryCandle.time;
  const stopLoss = side === 'LONG' ? entryPrice * (1 - STOP_LOSS_PCT) : entryPrice * (1 + STOP_LOSS_PCT);
  const takeProfit = side === 'LONG' ? entryPrice * (1 + TAKE_PROFIT_PCT) : entryPrice * (1 - TAKE_PROFIT_PCT);

  const tradeSnapshot: ExitTradeSnapshot = {
    id: `bt_${symbol}_${entryTime}`,
    symbol,
    side,
    entryPrice,
    highestPrice: entryCandle.high,
    lowestPrice: entryCandle.low,
    amount: 100,
    leverage: LEVERAGE,
    stopLoss,
    takeProfit,
    createdAt: entryTime
  };

  let exitPrice = entryCandle.close;
  let exitTime = entryTime;
  let reasonCode = 'END_OF_SERIES';
  let used1mExecution = false;
  let encounteredAmbiguousBar = false;
  let ambiguousBarTime: number | null = null;
  let resolvedVia1mSlice = false;

  const evalPathBar = (bar: Candle, allowOnDemand1m: boolean): boolean => {
    tradeSnapshot.highestPrice = Math.max(tradeSnapshot.highestPrice || bar.high, bar.high);
    tradeSnapshot.lowestPrice = Math.min(tradeSnapshot.lowestPrice || bar.low, bar.low);

    const activeSl = tradeSnapshot.stopLoss ?? stopLoss;
    const slHit = side === 'LONG' ? bar.low <= activeSl : bar.high >= activeSl;
    const tpHit = side === 'LONG' ? bar.high >= takeProfit : bar.low <= takeProfit;

    if (slHit && tpHit) {
      encounteredAmbiguousBar = true;
      ambiguousBarTime = bar.time;

      if (allowOnDemand1m && tieMode === '1M_RESOLVED' && ambiguous1mSlices) {
        const sliceKey = `${symbol}:${bar.time}`;
        const slice = ambiguous1mSlices[sliceKey];
        if (Array.isArray(slice) && slice.length > 0) {
          for (const sub of slice) {
            if (sub.time < bar.time || sub.time >= bar.time + 15 * 60 * 1000) continue;
            const subSl = side === 'LONG' ? sub.low <= activeSl : sub.high >= activeSl;
            const subTp = side === 'LONG' ? sub.high >= takeProfit : sub.low <= takeProfit;
            if (subSl && !subTp) {
              exitPrice = activeSl;
              exitTime = sub.time;
              reasonCode = 'STOP_LOSS';
              resolvedVia1mSlice = true;
              return true;
            }
            if (subTp && !subSl) {
              exitPrice = takeProfit;
              exitTime = sub.time;
              reasonCode = 'TAKE_PROFIT';
              resolvedVia1mSlice = true;
              return true;
            }
            if (subSl && subTp) {
              // 1m sub-bar itself touched both; default conservative SL_FIRST on 1m
              exitPrice = activeSl;
              exitTime = sub.time;
              reasonCode = 'STOP_LOSS';
              resolvedVia1mSlice = true;
              return true;
            }
          }
        }
      }

      if (tieMode === 'TP_FIRST') {
        exitPrice = takeProfit;
        exitTime = bar.time;
        reasonCode = 'TAKE_PROFIT';
        return true;
      }
      exitPrice = activeSl;
      exitTime = bar.time;
      reasonCode = 'STOP_LOSS';
      return true;
    }

    if (slHit) {
      exitPrice = activeSl;
      exitTime = bar.time;
      reasonCode = 'STOP_LOSS';
      return true;
    }
    if (tpHit) {
      exitPrice = takeProfit;
      exitTime = bar.time;
      reasonCode = 'TAKE_PROFIT';
      return true;
    }

    const dec = evaluateExitPolicy(
      tradeSnapshot,
      {
        currentPrice: bar.close,
        bid: bar.close,
        ask: bar.close,
        currentTime: bar.time
      },
      EXIT_POLICY_SETTINGS
    );

    if (dec.kind === 'MOVE_STOP' && dec.newStopLoss) {
      tradeSnapshot.stopLoss = dec.newStopLoss;
    } else if (dec.kind === 'FULL_CLOSE' || dec.kind === 'EMERGENCY_FULL_CLOSE') {
      exitPrice = bar.close;
      exitTime = bar.time;
      reasonCode = dec.reasonCode;
      return true;
    }
    return false;
  };

  let closed = false;
  const allowFull1mSeries =
    tieMode === '1M_RESOLVED' &&
    candles1mIdx &&
    candles1mIdx.times.length > 0 &&
    entryTime >= candles1mIdx.times[0];

  if (allowFull1mSeries && candles1mIdx) {
    used1mExecution = true;
    const start1m = findFirstIndexGte(candles1mIdx.times, entryTime);
    const max1mBars = 24 * 60 + 5;
    for (let k = start1m; k < Math.min(candles1mIdx.candles.length, start1m + max1mBars); k++) {
      const b = candles1mIdx.candles[k];
      if (evalPathBar(b, false)) {
        closed = true;
        break;
      }
      exitPrice = b.close;
      exitTime = b.time;
    }
  }

  if (!closed && !used1mExecution) {
    const maxBars = timeframe === '15m' ? 24 * 4 + 2 : 24 * 60 + 5;
    if (!evalPathBar(entryCandle, true)) {
      for (let k = entryCandleIdx + 1; k < Math.min(candles.length, entryCandleIdx + 1 + maxBars); k++) {
        const b = candles[k];
        if (evalPathBar(b, true)) {
          closed = true;
          break;
        }
        exitPrice = b.close;
        exitTime = b.time;
      }
    } else {
      closed = true;
    }
  }

  if (!closed && reasonCode === 'END_OF_SERIES') {
    reasonCode = 'MAX_HORIZON';
  }

  const unleveragedGrossPct =
    side === 'SHORT'
      ? ((entryPrice - exitPrice) / entryPrice) * 100
      : ((exitPrice - entryPrice) / entryPrice) * 100;

  return {
    exitPrice,
    exitTime,
    reasonCode,
    unleveragedGrossPct,
    leveragedGrossPct: unleveragedGrossPct * LEVERAGE,
    leveragedNetPct016: (unleveragedGrossPct - 0.16) * LEVERAGE,
    leveragedNetPct020: (unleveragedGrossPct - 0.20) * LEVERAGE,
    leveragedNetPct030: (unleveragedGrossPct - 0.30) * LEVERAGE,
    used1mExecution,
    encounteredAmbiguousBar,
    ambiguousBarTime,
    resolvedVia1mSlice
  };
}

// Live config sensitivity: matches settings.json (conservative, costModel v2 0.16% RT),
// autoPilotEngine.ts vol-capped leverage (5x -> 3x if vol>3.5 or |24h|>=4 -> 2x if vol>=5 or |24h|>=7),
// structuralExitLevels.ts SL [1.0%, 2.2%], and buildExitPolicyConfig (6% minNormalClose, bypassTP, Trail 14%/3%).
function computeLiveSensitivityCore(
  symbol: string,
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number,
  range24hPct: number,
  change24hPct: number,
  atrAtEntry: number,
  localHigh: number,
  localLow: number,
  candles: Candle[],
  ambiguous1mSlices: Record<string, Candle[]>
): { leverage: number; slPct: number; netPctLiveCost016: number; netPctTaker020: number } {
  let leverage = 5;
  if (range24hPct >= 5.0 || Math.abs(change24hPct) >= 7.0) {
    leverage = Math.min(4, Math.max(2, Math.round(leverage * 0.4))); // 2x
  } else if (range24hPct > 3.5 || Math.abs(change24hPct) >= 4.0) {
    leverage = Math.min(6, Math.max(2, Math.round(leverage * 0.6))); // 3x
  }

  const entryCandle = candles[entryCandleIdx];
  const entryPrice = entryCandle.open;
  const entryTime = entryCandle.time;

  const slCalc = calculateStructuralStopLoss({
    isSellSignal: side === 'SHORT',
    referencePrice: entryPrice,
    localLow5m: localLow,
    localHigh5m: localHigh,
    atr: atrAtEntry,
    dAutoTp1OrDRealTp1: 1.35 // 30% of 4.50% TP4 floor
  });
  const slPct = slCalc.slPct;
  const tpPct = 0.045; // default structural TP4 floor in autoPilotEngine

  const stopLoss = side === 'LONG' ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const takeProfit = side === 'LONG' ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);

  const snapshot: ExitTradeSnapshot = {
    id: `live_sens_${symbol}_${entryTime}`,
    symbol,
    side,
    entryPrice,
    highestPrice: entryCandle.high,
    lowestPrice: entryCandle.low,
    amount: 100,
    leverage,
    stopLoss,
    takeProfit,
    createdAt: entryTime
  };

  let exitPrice = entryCandle.close;
  const maxBars = 24 * 4 + 2;

  const evalBar = (bar: Candle): boolean => {
    snapshot.highestPrice = Math.max(snapshot.highestPrice || bar.high, bar.high);
    snapshot.lowestPrice = Math.min(snapshot.lowestPrice || bar.low, bar.low);
    const activeSl = snapshot.stopLoss ?? stopLoss;
    const slHit = side === 'LONG' ? bar.low <= activeSl : bar.high >= activeSl;
    const tpHit = side === 'LONG' ? bar.high >= takeProfit : bar.low <= takeProfit;

    if (slHit && tpHit) {
      const slice = ambiguous1mSlices[`${symbol}:${bar.time}`];
      if (Array.isArray(slice) && slice.length > 0) {
        for (const sub of slice) {
          const sSl = side === 'LONG' ? sub.low <= activeSl : sub.high >= activeSl;
          const sTp = side === 'LONG' ? sub.high >= takeProfit : sub.low <= takeProfit;
          if (sSl) { exitPrice = activeSl; return true; }
          if (sTp) { exitPrice = takeProfit; return true; }
        }
      }
      exitPrice = activeSl;
      return true;
    }
    if (slHit) { exitPrice = activeSl; return true; }
    if (tpHit) { exitPrice = takeProfit; return true; }

    const dec = evaluateExitPolicy(
      snapshot,
      { currentPrice: bar.close, bid: bar.close, ask: bar.close, currentTime: bar.time },
      LIVE_EXIT_POLICY_SETTINGS
    );
    if (dec.kind === 'MOVE_STOP' && dec.newStopLoss) {
      snapshot.stopLoss = dec.newStopLoss;
    } else if (dec.kind === 'FULL_CLOSE' || dec.kind === 'EMERGENCY_FULL_CLOSE') {
      exitPrice = bar.close;
      return true;
    }
    return false;
  };

  if (!evalBar(entryCandle)) {
    for (let k = entryCandleIdx + 1; k < Math.min(candles.length, entryCandleIdx + 1 + maxBars); k++) {
      const b = candles[k];
      if (evalBar(b)) break;
      exitPrice = b.close;
    }
  }

  const rawPct =
    side === 'SHORT'
      ? ((entryPrice - exitPrice) / entryPrice) * 100
      : ((exitPrice - entryPrice) / entryPrice) * 100;

  return {
    leverage,
    slPct,
    netPctLiveCost016: (rawPct - 0.16) * leverage,
    netPctTaker020: (rawPct - 0.20) * leverage
  };
}

function getCachedLiveSensitivityOutcome(
  ser: SymbolSeries,
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number,
  ambiguous1mSlices: Record<string, Candle[]>,
  overrides?: { range24hPct: number; change24hPct: number; atrAtEntry: number; localHigh: number; localLow: number }
): { leverage: number; slPct: number; netPctLiveCost016: number; netPctTaker020: number } {
  const key = `${side}:${entryCandleIdx}`;
  let hit = ser.liveOutcomeCache.get(key);
  if (!hit) {
    const candles = ser.candles15;
    let params = overrides;
    if (!params) {
      const sigIdx = Math.max(0, entryCandleIdx - 1);
      const stats24 = computeBar24hStats(candles, sigIdx);
      const swingSlice = candles.slice(Math.max(0, sigIdx - 7), sigIdx + 1);
      const localHigh = Math.max(...swingSlice.map(c => c.high));
      const localLow = Math.min(...swingSlice.map(c => c.low));
      if (!ser.atr15) {
        const values = ATR.calculate({
          high: candles.map(c => c.high),
          low: candles.map(c => c.low),
          close: candles.map(c => c.close),
          period: 14
        });
        ser.atr15 = { values, offset: candles.length - values.length };
      }
      const atrIdx = sigIdx - ser.atr15.offset;
      const atrAtEntry = atrIdx >= 0 ? ser.atr15.values[atrIdx] : candles[entryCandleIdx].open * 0.015;
      params = {
        range24hPct: stats24.range24h,
        change24hPct: stats24.change24h,
        atrAtEntry,
        localHigh,
        localLow
      };
    }
    hit = computeLiveSensitivityCore(
      ser.symbol,
      side,
      entryCandleIdx,
      params.range24hPct,
      params.change24hPct,
      params.atrAtEntry,
      params.localHigh,
      params.localLow,
      candles,
      ambiguous1mSlices
    );
    ser.liveOutcomeCache.set(key, hit);
  }
  return hit;
}

interface SymbolSeries {
  symbol: string;
  candles15: Candle[];
  candles1: Candle[];
  idx1m: { times: number[]; candles: Candle[] } | null;
  outcomeCache: Map<string, ExecOutcome>;
  liveOutcomeCache: Map<string, { leverage: number; slPct: number; netPctLiveCost016: number; netPctTaker020: number }>;
  atr15?: { values: number[]; offset: number };
  cond24hPool15m?: { isAll: number[]; oosAll: number[]; all: number[] };
}

function getCachedOutcome(
  series: SymbolSeries,
  timeframe: '15m' | '1m',
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number,
  tieMode: TieBreakerMode = 'SL_FIRST',
  ambiguous1mSlices?: Record<string, Candle[]>
): ExecOutcome {
  const key = `${tieMode}:${timeframe}:${side}:${entryCandleIdx}`;
  let hit = series.outcomeCache.get(key);
  if (!hit) {
    const candles = timeframe === '15m' ? series.candles15 : series.candles1;
    const subIdx = timeframe === '1m' ? { times: candles.map(c => c.time), candles } : series.idx1m;
    hit = executeSingleTradeAtEntry(series.symbol, timeframe, side, entryCandleIdx, candles, subIdx, tieMode, ambiguous1mSlices);
    series.outcomeCache.set(key, hit);
  }
  return hit;
}

function computeBar24hStats(candles: Candle[], i: number): { high24h: number; low24h: number; vol24hUsdt: number; open24h: number; change24h: number; range24h: number } {
  let high24h = -Infinity;
  let low24h = Infinity;
  let vol24hUsdt = 0;
  const start24 = Math.max(0, i - 95);
  for (let j = start24; j <= i; j++) {
    if (candles[j].high > high24h) high24h = candles[j].high;
    if (candles[j].low < low24h) low24h = candles[j].low;
    vol24hUsdt += candles[j].volume * candles[j].close;
  }
  const open24h = candles[start24].open;
  const closeNow = candles[i].close;
  const change24h = open24h > 0 ? ((closeNow - open24h) / open24h) * 100 : 0;
  const range24h = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;
  return { high24h, low24h, vol24hUsdt, open24h, change24h, range24h };
}

function backtestPatternScanner(series: SymbolSeries, timeframe: '15m' | '1m'): SimTrade[] {
  const candles = timeframe === '15m' ? series.candles15 : series.candles1;
  const trades: SimTrade[] = [];
  const windowSize = 48;
  const atrAll = ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period: 14
  });
  const atrOffset = candles.length - atrAll.length;
  let activeUntil = 0;

  for (let i = Math.max(windowSize, 96); i < candles.length - 2; i++) {
    const entryCandle = candles[i + 1];
    if (entryCandle.time <= activeUntil) continue;

    const window = candles.slice(i - windowSize + 1, i + 1);
    const detected = detectTradingPatterns(window);
    if (!detected) continue;

    const outcome = getCachedOutcome(series, timeframe, detected.side, i + 1, 'SL_FIRST');
    activeUntil = outcome.exitTime;

    const stats24 = timeframe === '15m'
      ? computeBar24hStats(candles, i)
      : { change24h: ((candles[i].close - candles[Math.max(0, i - 60)].open) / Math.max(1e-9, candles[Math.max(0, i - 60)].open)) * 100, range24h: 0 };
    const swingSlice = candles.slice(Math.max(0, i - 7), i + 1);
    const localHigh = Math.max(...swingSlice.map(c => c.high));
    const localLow = Math.min(...swingSlice.map(c => c.low));
    const atrIdx = i - atrOffset;

    trades.push({
      engine: 'patternScannerService',
      symbol: series.symbol,
      timeframe,
      patternName: detected.patternName,
      side: detected.side,
      signalTime: candles[i].time,
      entryTime: entryCandle.time,
      exitTime: outcome.exitTime,
      entryPrice: entryCandle.open,
      exitPrice: outcome.exitPrice,
      reasonCode: outcome.reasonCode,
      unleveragedGrossPct: outcome.unleveragedGrossPct,
      leveragedGrossPct: outcome.leveragedGrossPct,
      leveragedNetPct016: outcome.leveragedNetPct016,
      leveragedNetPct020: outcome.leveragedNetPct020,
      leveragedNetPct030: outcome.leveragedNetPct030,
      used1mExecution: outcome.used1mExecution,
      encounteredAmbiguousBar: outcome.encounteredAmbiguousBar,
      ambiguousBarTime: outcome.ambiguousBarTime,
      change24hPct: stats24.change24h,
      range24hPct: stats24.range24h,
      atrAtEntry: atrIdx >= 0 ? atrAll[atrIdx] : entryCandle.open * 0.015,
      localHigh,
      localLow,
      entryCandleIdx: i + 1
    });
  }
  return trades;
}

function backtestMarketSignalScanner(series: SymbolSeries): SimTrade[] {
  const candles = series.candles15;
  const trades: SimTrade[] = [];
  if (candles.length < 110) return trades;

  const closesAll = candles.map(c => c.close);
  const highsAll = candles.map(c => c.high);
  const lowsAll = candles.map(c => c.low);
  const psarAll = PSAR.calculate({ high: highsAll, low: lowsAll, step: 0.02, max: 0.2 });
  const rsiAll = RSI.calculate({ values: closesAll, period: 14 });
  const bbAll = BollingerBands.calculate({ period: 20, values: closesAll, stdDev: 2 });
  const atrAll = ATR.calculate({ high: highsAll, low: lowsAll, close: closesAll, period: 14 });

  const psarOffset = candles.length - psarAll.length;
  const rsiOffset = candles.length - rsiAll.length;
  const bbOffset = candles.length - bbAll.length;
  const atrOffset = candles.length - atrAll.length;

  let activeUntil = 0;

  for (let i = 96; i < candles.length - 2; i++) {
    const entryCandle = candles[i + 1];
    if (entryCandle.time <= activeUntil) continue;

    const { high24h, low24h, vol24hUsdt, open24h, change24h: change, range24h } = computeBar24hStats(candles, i);
    const bar = candles[i];
    const tickerPrice = bar.close;

    const psarIdx = i - psarOffset;
    const rsiIdx = i - rsiOffset;
    const bbIdx = i - bbOffset;
    if (psarIdx < 6 || rsiIdx < 0 || bbIdx < 0) continue;

    const lastSar = psarAll[psarIdx];
    const trueRsi = rsiAll[rsiIdx];
    const bb = bbAll[bbIdx];
    const bb1h = tickerPrice > bb.upper ? 'OVERBOUGHT' : tickerPrice < bb.lower ? 'OVERSOLD' : 'INSIDE';

    const psarStatus = tickerPrice > lastSar ? 'BULLISH' : 'BEARISH';
    let isSarBearishFlipped = false;
    let isSarBullishFlipped = false;
    for (let k = 0; k < 5; k++) {
      const cIdx = i - k;
      const pIdx = psarIdx - k;
      if (pIdx <= 0 || cIdx <= 0) break;
      const cStat = candles[cIdx].close > psarAll[pIdx] ? 'BULLISH' : 'BEARISH';
      const prevStat = candles[cIdx - 1].close > psarAll[pIdx - 1] ? 'BULLISH' : 'BEARISH';
      if (cStat === 'BEARISH' && prevStat === 'BULLISH') isSarBearishFlipped = true;
      if (cStat === 'BULLISH' && prevStat === 'BEARISH') isSarBullishFlipped = true;
    }

    const vwapWindow = candles.slice(Math.max(0, i - 47), i + 1);
    let lastVwap = tickerPrice;
    try {
      const vw = VWAP.calculate({
        high: vwapWindow.map(c => c.high),
        low: vwapWindow.map(c => c.low),
        close: vwapWindow.map(c => c.close),
        volume: vwapWindow.map(c => c.volume)
      });
      if (vw.length > 0) lastVwap = vw[vw.length - 1];
    } catch {}

    const bodyMax = Math.max(bar.open, bar.close);
    const bodyMin = Math.min(bar.open, bar.close);
    const totalSize = (bar.high - bar.low) || 1;
    const rangePct = bar.low > 0 ? ((bar.high - bar.low) / bar.low) * 100 : 0;
    const wicks = {
      topPct: rangePct >= 0.15 ? (bar.high - bodyMax) / totalSize : 0,
      bottomPct: rangePct >= 0.15 ? (bodyMin - bar.low) / totalSize : 0,
      bodySize: bodyMax - bodyMin
    };

    const closedVolSlice = candles.slice(Math.max(0, i - 21), i + 1).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]);
    closedVolSlice.push([entryCandle.time, entryCandle.open, entryCandle.open, entryCandle.open, entryCandle.open, 0]);
    const volumeSpike = computeVolumeSpikeRatio(closedVolSlice);

    const evalRes = evaluateScannerPatternPure({
      tickerPrice,
      change,
      high: high24h,
      low: low24h,
      volume: vol24hUsdt,
      open: open24h,
      rawIndicators: {
        rsi1h: trueRsi,
        volumeSpike,
        wicks,
        sar: lastSar,
        vwap: lastVwap,
        bb1h,
        psarStatus1m: psarStatus,
        isSarBearishFlipped1m: isSarBearishFlipped,
        isSarBullishFlipped1m: isSarBullishFlipped
      }
    });

    if (evalRes.signalSide === 'NEUTRAL' || evalRes.matchedPattern === 'None') continue;

    const outcome = getCachedOutcome(series, '15m', evalRes.signalSide, i + 1, 'SL_FIRST');
    activeUntil = outcome.exitTime;

    const swingSlice = candles.slice(Math.max(0, i - 7), i + 1);
    const localHigh = Math.max(...swingSlice.map(c => c.high));
    const localLow = Math.min(...swingSlice.map(c => c.low));
    const atrIdx = i - atrOffset;

    trades.push({
      engine: 'marketSignalScanner',
      symbol: series.symbol,
      timeframe: '15m',
      patternName: evalRes.matchedPattern,
      side: evalRes.signalSide,
      signalTime: bar.time,
      entryTime: entryCandle.time,
      exitTime: outcome.exitTime,
      entryPrice: entryCandle.open,
      exitPrice: outcome.exitPrice,
      reasonCode: outcome.reasonCode,
      unleveragedGrossPct: outcome.unleveragedGrossPct,
      leveragedGrossPct: outcome.leveragedGrossPct,
      leveragedNetPct016: outcome.leveragedNetPct016,
      leveragedNetPct020: outcome.leveragedNetPct020,
      leveragedNetPct030: outcome.leveragedNetPct030,
      used1mExecution: outcome.used1mExecution,
      encounteredAmbiguousBar: outcome.encounteredAmbiguousBar,
      ambiguousBarTime: outcome.ambiguousBarTime,
      change24hPct: change,
      range24hPct: range24h,
      atrAtEntry: atrIdx >= 0 ? atrAll[atrIdx] : entryCandle.open * 0.015,
      localHigh,
      localLow,
      entryCandleIdx: i + 1
    });
  }

  return trades;
}

function runRandomBaselineMonteCarlo(
  subset: SimTrade[],
  seriesBySym: Map<string, SymbolSeries>,
  timeframe: '15m' | '1m',
  side: 'LONG' | 'SHORT',
  splitLabel: 'ALL' | 'IS-60%' | 'OOS-40%',
  splitTime: number,
  seedKey: string,
  volatilityConditionedOnly: boolean
): { p50: number; p95: number; mean: number } {
  if (subset.length === 0) return { p50: 0, p95: 0, mean: 0 };

  const countBySym = new Map<string, number>();
  for (const t of subset) {
    countBySym.set(t.symbol, (countBySym.get(t.symbol) || 0) + 1);
  }

  const candidateIndicesBySym = new Map<string, number[]>();
  for (const [sym] of countBySym.entries()) {
    const ser = seriesBySym.get(sym);
    if (!ser) continue;
    const candles = timeframe === '15m' ? ser.candles15 : ser.candles1;
    const minIdx = 97;
    const idxs: number[] = [];
    const fallbackIdxs: number[] = [];
    for (let idx = minIdx; idx < candles.length - 2; idx++) {
      const entryT = candles[idx].time;
      if (splitLabel === 'IS-60%' && entryT > splitTime) continue;
      if (splitLabel === 'OOS-40%' && entryT <= splitTime) continue;
      fallbackIdxs.push(idx);
      if (volatilityConditionedOnly && timeframe === '15m') {
        const sigIdx = idx - 1;
        const open24 = candles[Math.max(0, sigIdx - 95)].open;
        const closeSig = candles[sigIdx].close;
        const ch24 = open24 > 0 ? Math.abs((closeSig - open24) / open24) * 100 : 0;
        if (ch24 < 3.0) continue;
      }
      idxs.push(idx);
    }
    candidateIndicesBySym.set(sym, idxs.length >= 10 ? idxs : fallbackIdxs);
  }

  const rng = createMulberry32(hashString(`MC_${volatilityConditionedOnly ? 'VOL3' : 'UNCOND'}_${seedKey}`));
  const simMeans: number[] = new Array(MONTE_CARLO_RUNS);

  for (let r = 0; r < MONTE_CARLO_RUNS; r++) {
    let totalNet = 0;
    let totalN = 0;

    for (const [sym, k] of countBySym.entries()) {
      const ser = seriesBySym.get(sym);
      const pool = candidateIndicesBySym.get(sym);
      if (!ser || !pool || pool.length === 0) continue;
      const candles = timeframe === '15m' ? ser.candles15 : ser.candles1;

      const chosen = new Array<number>(k);
      for (let j = 0; j < k; j++) {
        chosen[j] = pool[Math.floor(rng() * pool.length)];
      }
      chosen.sort((a, b) => a - b);

      let busyUntil = 0;
      for (const entryIdx of chosen) {
        if (candles[entryIdx].time <= busyUntil) {
          let found = -1;
          for (let tries = 0; tries < 5; tries++) {
            const alt = pool[Math.floor(rng() * pool.length)];
            if (candles[alt].time > busyUntil) {
              found = alt;
              break;
            }
          }
          if (found === -1) continue;
          const out = getCachedOutcome(ser, timeframe, side, found, 'SL_FIRST');
          busyUntil = out.exitTime;
          totalNet += out.leveragedNetPct020;
          totalN++;
        } else {
          const out = getCachedOutcome(ser, timeframe, side, entryIdx, 'SL_FIRST');
          busyUntil = out.exitTime;
          totalNet += out.leveragedNetPct020;
          totalN++;
        }
      }
    }

    simMeans[r] = totalN > 0 ? totalNet / totalN : 0;
  }

  simMeans.sort((a, b) => a - b);
  const mean = simMeans.reduce((a, b) => a + b, 0) / MONTE_CARLO_RUNS;
  const p50 = simMeans[Math.floor(MONTE_CARLO_RUNS * 0.50)];
  const p95 = simMeans[Math.min(MONTE_CARLO_RUNS - 1, Math.floor(MONTE_CARLO_RUNS * 0.95))];
  return { p50, p95, mean };
}

function runLiveCondVolRandomBaselineMonteCarlo(
  subset: SimTrade[],
  seriesBySym: Map<string, SymbolSeries>,
  side: 'LONG' | 'SHORT',
  splitTime: number,
  seedKey: string,
  ambiguous1mSlices: Record<string, Candle[]>
): { mean_016: number; p95_016: number; mean_020: number; p95_020: number } {
  if (subset.length === 0) return { mean_016: 0, p95_016: 0, mean_020: 0, p95_020: 0 };

  const countBySym = new Map<string, number>();
  for (const t of subset) {
    countBySym.set(t.symbol, (countBySym.get(t.symbol) || 0) + 1);
  }

  const candidateIndicesBySym = new Map<string, number[]>();
  for (const [sym] of countBySym.entries()) {
    const ser = seriesBySym.get(sym);
    if (!ser) continue;
    const candles = ser.candles15;
    const idxs: number[] = [];
    const fallbackIdxs: number[] = [];
    for (let idx = 97; idx < candles.length - 2; idx++) {
      if (candles[idx].time <= splitTime) continue;
      fallbackIdxs.push(idx);
      const sigIdx = idx - 1;
      const open24 = candles[Math.max(0, sigIdx - 95)].open;
      const closeSig = candles[sigIdx].close;
      const ch24 = open24 > 0 ? Math.abs((closeSig - open24) / open24) * 100 : 0;
      if (ch24 >= 3.0) idxs.push(idx);
    }
    candidateIndicesBySym.set(sym, idxs.length >= 10 ? idxs : fallbackIdxs);
  }

  const rng = createMulberry32(hashString(`MC_LIVE_VOL3_${seedKey}`));
  const simMeans016: number[] = new Array(MONTE_CARLO_RUNS);
  const simMeans020: number[] = new Array(MONTE_CARLO_RUNS);

  for (let r = 0; r < MONTE_CARLO_RUNS; r++) {
    let total016 = 0;
    let total020 = 0;
    let totalN = 0;

    for (const [sym, k] of countBySym.entries()) {
      const ser = seriesBySym.get(sym);
      const pool = candidateIndicesBySym.get(sym);
      if (!ser || !pool || pool.length === 0) continue;
      const candles = ser.candles15;

      const chosen = new Array<number>(k);
      for (let j = 0; j < k; j++) {
        chosen[j] = pool[Math.floor(rng() * pool.length)];
      }
      chosen.sort((a, b) => a - b);

      let busyUntil = 0;
      for (const entryIdx of chosen) {
        let pickIdx = entryIdx;
        if (candles[entryIdx].time <= busyUntil) {
          let found = -1;
          for (let tries = 0; tries < 5; tries++) {
            const alt = pool[Math.floor(rng() * pool.length)];
            if (candles[alt].time > busyUntil) {
              found = alt;
              break;
            }
          }
          if (found === -1) continue;
          pickIdx = found;
        }
        const ls = getCachedLiveSensitivityOutcome(ser, side, pickIdx, ambiguous1mSlices);
        // Estimate non-overlap horizon via 6h conservative spacing for fast random loop
        busyUntil = candles[pickIdx].time + 6 * 3600 * 1000;
        total016 += ls.netPctLiveCost016;
        total020 += ls.netPctTaker020;
        totalN++;
      }
    }

    simMeans016[r] = totalN > 0 ? total016 / totalN : 0;
    simMeans020[r] = totalN > 0 ? total020 / totalN : 0;
  }

  const sorted016 = [...simMeans016].sort((a, b) => a - b);
  const sorted020 = [...simMeans020].sort((a, b) => a - b);
  return {
    mean_016: simMeans016.reduce((a, b) => a + b, 0) / MONTE_CARLO_RUNS,
    p95_016: sorted016[Math.min(MONTE_CARLO_RUNS - 1, Math.floor(MONTE_CARLO_RUNS * 0.95))],
    mean_020: simMeans020.reduce((a, b) => a + b, 0) / MONTE_CARLO_RUNS,
    p95_020: sorted020[Math.min(MONTE_CARLO_RUNS - 1, Math.floor(MONTE_CARLO_RUNS * 0.95))]
  };
}

function summarizeTrades(trades: SimTrade[], seedKey: string) {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      wins: 0,
      winRatePct: 0,
      meanGrossPct: 0,
      meanNet016Pct: 0,
      meanNet020Pct: 0,
      meanNet030Pct: 0,
      sumNet020Pp: 0,
      profitFactor: 0,
      maxDdRoePp: 0,
      ci95: [0, 0] as [number, number],
      tStat: 0,
      pOneSidedRaw: 1,
      pTwoSidedRaw: 1,
      note: 'выборка мала (n<30)'
    };
  }

  const grossVals = trades.map(t => t.leveragedGrossPct);
  const net016 = trades.map(t => t.leveragedNetPct016);
  const net020 = trades.map(t => t.leveragedNetPct020);
  const net030 = trades.map(t => t.leveragedNetPct030);

  const wins = net020.filter(v => v > 0).length;
  const sum020 = net020.reduce((a, b) => a + b, 0);
  const grossWin = net020.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(net020.filter(v => v <= 0).reduce((a, b) => a + b, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const ci95 = bootstrapMeanCi95(net020, 2000, hashString(seedKey));
  const tRes = computeOneSampleTTest(net020);

  return {
    n,
    wins,
    winRatePct: (wins / n) * 100,
    meanGrossPct: grossVals.reduce((a, b) => a + b, 0) / n,
    meanNet016Pct: net016.reduce((a, b) => a + b, 0) / n,
    meanNet020Pct: sum020 / n,
    meanNet030Pct: net030.reduce((a, b) => a + b, 0) / n,
    sumNet020Pp: sum020,
    profitFactor: pf,
    maxDdRoePp: maxDrawdownRoePp(net020),
    ci95,
    tStat: tRes.tStat,
    pOneSidedRaw: tRes.pOneSided,
    pTwoSidedRaw: tRes.pTwoSided,
    note: n < 30 ? 'выборка мала (n<30)' : 'OK (n >= 30)'
  };
}

function summarizeValues(vals: number[]) {
  if (vals.length === 0) return { n: 0, wr: 0, mean: 0, sum: 0, maxDd: 0 };
  const wins = vals.filter(v => v > 0).length;
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    n: vals.length,
    wr: (wins / vals.length) * 100,
    mean: sum / vals.length,
    sum,
    maxDd: maxDrawdownRoePp(vals)
  };
}

async function resolveAmbiguous1mSlices(
  trades: SimTrade[],
  seriesBySym: Map<string, SymbolSeries>
): Promise<{
  ambiguous15mCount: number;
  ambiguous15mPct: number;
  fetchedNewSlices: number;
  resolvedBy1mSeriesCount: number;
  resolvedBy1mSliceCount: number;
  unresolvedAmbiguousCount: number;
  slices: Record<string, Candle[]>;
}> {
  const slices = loadAmbiguous1mSliceCache();
  const trades15m = trades.filter(t => t.timeframe === '15m');
  const ambiguousTrades = trades15m.filter(t => t.encounteredAmbiguousBar && t.ambiguousBarTime !== null);

  let fetchedNewSlices = 0;
  let resolvedBy1mSeriesCount = 0;
  let resolvedBy1mSliceCount = 0;
  let unresolvedAmbiguousCount = 0;

  const missingPairs: Array<{ symbol: string; barTime: number; key: string }> = [];
  const seenKeys = new Set<string>();

  for (const t of ambiguousTrades) {
    const ser = seriesBySym.get(t.symbol);
    const barTime = t.ambiguousBarTime!;
    const has60d1m = Boolean(ser?.idx1m && ser.idx1m.times.length > 0 && t.entryTime >= ser.idx1m.times[0]);
    if (has60d1m) {
      resolvedBy1mSeriesCount++;
      continue;
    }
    const key = `${t.symbol}:${barTime}`;
    if (!slices[key] && !seenKeys.has(key)) {
      seenKeys.add(key);
      missingPairs.push({ symbol: t.symbol, barTime, key });
    }
  }

  for (let i = 0; i < missingPairs.length; i += 6) {
    const batch = missingPairs.slice(i, i + 6);
    const fetched = await Promise.all(
      batch.map(async p => {
        const candles = await fetchWeexHistoryChunk(p.symbol, '1m', p.barTime, p.barTime + 15 * 60 * 1000, 30);
        return { key: p.key, candles };
      })
    );
    for (const item of fetched) {
      slices[item.key] = item.candles;
      if (item.candles.length > 0) fetchedNewSlices++;
    }
    await sleep(50);
  }

  if (missingPairs.length > 0) {
    saveAmbiguous1mSliceCache(slices);
  }

  for (const t of ambiguousTrades) {
    const ser = seriesBySym.get(t.symbol);
    const barTime = t.ambiguousBarTime!;
    const has60d1m = Boolean(ser?.idx1m && ser.idx1m.times.length > 0 && t.entryTime >= ser.idx1m.times[0]);
    if (has60d1m) continue;
    const key = `${t.symbol}:${barTime}`;
    if (Array.isArray(slices[key]) && slices[key].length > 0) {
      resolvedBy1mSliceCount++;
    } else {
      unresolvedAmbiguousCount++;
    }
  }

  return {
    ambiguous15mCount: ambiguousTrades.length,
    ambiguous15mPct: trades15m.length > 0 ? (ambiguousTrades.length / trades15m.length) * 100 : 0,
    fetchedNewSlices,
    resolvedBy1mSeriesCount,
    resolvedBy1mSliceCount,
    unresolvedAmbiguousCount,
    slices
  };
}

async function main() {
  const lines: string[] = [];
  const log = (s = '') => {
    console.log(s);
    lines.push(s);
  };

  log('=== H4 / G7 / J1 BACKTEST v2.1 (TOP-30 WEEX FUTURES, 1 POS/SYMBOL, SENSITIVITY & M=32 FDR) ===');
  log(`Pre-committed OOS Pass Criterion: ${OOS_PASS_CRITERION_TEXT}`);
  log(`Depth: 15m=${DAYS_15M}d (Top-30), 1m=${DAYS_1M}d (cached majors) + on-demand 1m slices for ambiguous 15m bars`);
  log(`Baseline v2 Params: Leverage=${LEVERAGE}x, SL=${(STOP_LOSS_PCT * 100).toFixed(1)}% (-10% ROE), TP=${(TAKE_PROFIT_PCT * 100).toFixed(1)}% (+15% ROE), Floor=4.0%, Trail=off`);
  log(`MaxDD unit: linear non-compounded ROE percentage points (п.п. ROE) on fixed margin per trade`);
  log('');

  log('--- J1.6: BREAK-EVEN ARITHMETIC (LEVERAGE 5x) ---');
  log('Formula: BreakEven_Gross_ROE(%) = RoundTripCostPct(%) * Leverage');
  log(`  - Cost 0.16% (live costModel v2: 0.06%x2 + 0.04% slip) * ${LEVERAGE}x => +${(0.16 * LEVERAGE).toFixed(2)}% Gross ROE break-even`);
  log(`  - Cost 0.20% (taker fee: 0.08%x2 + 0.04% slip)        * ${LEVERAGE}x => +${(0.20 * LEVERAGE).toFixed(2)}% Gross ROE break-even`);
  log(`  - Cost 0.30% (stress illiquid altcoin tier)            * ${LEVERAGE}x => +${(0.30 * LEVERAGE).toFixed(2)}% Gross ROE break-even`);
  log('Interpretation: Whenever 0 < Mean Gross ROE < +1.00% (at 5x, 0.20% cost), strategy edge before fees is positive but smaller than fees+slippage => Mean Net@(0.20%) < 0.');
  log('');

  log('--- J1.1: LIVE VS BACKTEST v2 INDICATORS & CONFIG COMPARISON ---');
  log('Parameter | Live Production (Code & settings.json) | Backtest v2 (Baseline) | Impact / Gap');
  log('---|---|---|---');
  log('rsi1h | RSI-14 on 15m (marketDataCollectorService.ts:241-243) | RSI-14 on 15m | Match');
  log('bb1h | BB(20,2) on 15m (marketDataCollectorService.ts:307-313) | BB(20,2) on 15m | Match');
  log('vwap | VWAP on 100 x 15m bars (marketDataCollectorService.ts:375-379) | VWAP on 48 x 15m bars (12h) | Minor drift (48 vs 100 bars)');
  log('psarStatus1m / flips | PSAR(0.02,0.2) on 60 x 1m bars (collector:335-363) | PSAR(0.02,0.2) on 15m bars | Moderate divergence (15m smoother than 1m)');
  log('volumeSpike | Closed bar[-2] / median(prev <=20 closed 15m bars) | Exact computeVolumeSpikeRatio() | Match');
  log('change/high/low/vol | Live WEEX 24h rolling ticker | Rolling 96 x 15m bars | Near match (~24h window)');
  log('Leverage | conservative 3-5x -> cap 2x (vol>=5/|24h|>=7) / 3x (vol>3.5/|24h|>=4) | Fixed 5x | Tested below in J1.4 Live Sensitivity');
  log('SL / TP & ExitPolicy | Struct SL [1.0%,2.2%], TP4>=4.5%, minClose=6%, bypassTP=true, Trail 14%/3%, timeoutProfit 18h@6%, cost=0.16% | Fixed SL 2% / TP 3%, minClose=4%, bypassTP=false, Trail=false, cost=0.20% | Tested below in J1.4 Live Sensitivity');
  log('');

  const universe = USE_FIXED_UNIVERSE
    ? {
        symbols: FIXED_CONTROL_SYMBOLS,
        source: `fixed liquid control universe (${FIXED_CONTROL_SYMBOLS.length} symbols)`,
        topDetails: FIXED_CONTROL_SYMBOLS.map(symbol => ({ symbol, quoteVolume: 0 }))
      }
    : await resolveTop30WeexSymbols(30);
  log(`Universe (${universe.symbols.length}): ${universe.source}`);
  log(`Symbols: ${universe.symbols.join(', ')}`);
  log('');

  const seriesList: SymbolSeries[] = [];
  const seriesBySym = new Map<string, SymbolSeries>();
  const dataCoverage: Record<string, any> = {};

  for (let i = 0; i < universe.symbols.length; i += 5) {
    const chunk = universe.symbols.slice(i, i + 5);
    const loaded = await Promise.all(
      chunk.map(async sym => {
        const c15 = await loadOrDownloadCandles(sym, '15m', DAYS_15M, false);
        const c1 = await loadOrDownloadCandles(sym, '1m', DAYS_1M, true);
        return { sym, c15, c1 };
      })
    );
    for (const { sym, c15, c1 } of loaded) {
      if (c15.length < 150) {
        log(`[SKIP] ${sym}: only ${c15.length} 15m bars`);
        continue;
      }
      const ser: SymbolSeries = {
        symbol: sym,
        candles15: c15,
        candles1: c1,
        idx1m: c1.length > 0 ? build1mIndex(c1) : null,
        outcomeCache: new Map(),
        liveOutcomeCache: new Map()
      };
      seriesList.push(ser);
      seriesBySym.set(sym, ser);
      dataCoverage[sym] = {
        bars15m: c15.length,
        start15m: new Date(c15[0].time).toISOString(),
        end15m: new Date(c15[c15.length - 1].time).toISOString(),
        bars1m: c1.length
      };
    }
    log(`[LOAD] Loaded ${Math.min(i + 5, universe.symbols.length)}/${universe.symbols.length} symbols (active: ${seriesList.length})`);
  }

  const allTrades: SimTrade[] = [];
  for (const ser of seriesList) {
    allTrades.push(...backtestPatternScanner(ser, '15m'));
    if (ser.candles1.length >= 200) {
      allTrades.push(...backtestPatternScanner(ser, '1m'));
    }
    allTrades.push(...backtestMarketSignalScanner(ser));
  }

  // J1.2: Resolve ambiguous 15m bars on demand via 1m WEEX klines
  const ambigInfo = await resolveAmbiguous1mSlices(allTrades, seriesBySym);
  const trades15mAll = allTrades.filter(t => t.timeframe === '15m');

  const evaluateTieModeOn15mTrades = (mode: TieBreakerMode) => {
    const vals: number[] = [];
    for (const t of trades15mAll) {
      const ser = seriesBySym.get(t.symbol)!;
      const out = getCachedOutcome(ser, '15m', t.side, t.entryCandleIdx, mode, ambigInfo.slices);
      vals.push(out.leveragedNetPct020);
    }
    return summarizeValues(vals);
  };

  const slFirstPooled15m = evaluateTieModeOn15mTrades('SL_FIRST');
  const tpFirstPooled15m = evaluateTieModeOn15mTrades('TP_FIRST');
  const resolved1mPooled15m = evaluateTieModeOn15mTrades('1M_RESOLVED');

  log('');
  log('--- J1.2: AMBIGUOUS 15m BARS & TIE-BREAKER SENSITIVITY (ALL 15m TRADES, n=' + trades15mAll.length + ') ---');
  log(
    `Ambiguous 15m trades (both SL & TP touched on same 15m bar): ${ambigInfo.ambiguous15mCount}/${trades15mAll.length} ` +
    `(${ambigInfo.ambiguous15mPct.toFixed(2)}%) | Resolved via 60d 1m: ${ambigInfo.resolvedBy1mSeriesCount}, ` +
    `via on-demand 1m WEEX slice: ${ambigInfo.resolvedBy1mSliceCount} (newly fetched: ${ambigInfo.fetchedNewSlices}), ` +
    `unresolved fallback: ${ambigInfo.unresolvedAmbiguousCount} ` +
    `(${trades15mAll.length > 0 ? ((ambigInfo.unresolvedAmbiguousCount / trades15mAll.length) * 100).toFixed(2) : '0.00'}%)`
  );
  log(`  - SL_FIRST    (pure 15m conservative): WR=${slFirstPooled15m.wr.toFixed(2)}%, MeanNet@0.20%=${slFirstPooled15m.mean.toFixed(3)}%, Sum=${slFirstPooled15m.sum.toFixed(1)} п.п.`);
  log(`  - 1M_RESOLVED (actual 1m intra-bar)  : WR=${resolved1mPooled15m.wr.toFixed(2)}%, MeanNet@0.20%=${resolved1mPooled15m.mean.toFixed(3)}%, Sum=${resolved1mPooled15m.sum.toFixed(1)} п.п.`);
  log(`  - TP_FIRST    (pure 15m optimistic)  : WR=${tpFirstPooled15m.wr.toFixed(2)}%, MeanNet@0.20%=${tpFirstPooled15m.mean.toFixed(3)}%, Sum=${tpFirstPooled15m.sum.toFixed(1)} п.п.`);
  log('');

  log(`Total trades simulated (1 active pos/symbol/engine): ${allTrades.length}`);
  log(`  - patternScannerService (15m): ${allTrades.filter(t => t.engine === 'patternScannerService' && t.timeframe === '15m').length}`);
  log(`  - patternScannerService (1m):  ${allTrades.filter(t => t.engine === 'patternScannerService' && t.timeframe === '1m').length}`);
  log(`  - marketSignalScanner (15m):   ${allTrades.filter(t => t.engine === 'marketSignalScanner').length}`);
  log('');

  const summaryRows: any[] = [];
  const oosRowsForFdr: any[] = [];
  const oosPassingStrategies: any[] = [];
  const liveSensitivityByGroup = new Map<string, {
    label: string;
    side: 'LONG' | 'SHORT';
    splitTime: number;
    subset: SimTrade[];
    baseline020: number[];
    live016: number[];
    live020: number[];
    levSum: number;
    slSum: number;
  }>();

  for (const engine of ['patternScannerService', 'marketSignalScanner'] as const) {
    for (const tf of ['15m', '1m'] as const) {
      const engineTfTrades = allTrades
        .filter(t => t.engine === engine && t.timeframe === tf)
        .sort((a, b) => a.entryTime - b.entryTime);
      if (engineTfTrades.length === 0) continue;

      const minT = engineTfTrades[0].entryTime;
      const maxT = engineTfTrades[engineTfTrades.length - 1].entryTime;
      const splitTime = minT + (maxT - minT) * 0.6;

      const groups = new Map<string, SimTrade[]>();
      for (const t of engineTfTrades) {
        const k = `${t.patternName}|||${t.side}`;
        const arr = groups.get(k) || [];
        arr.push(t);
        groups.set(k, arr);
      }

      const engineLabel = engine === 'marketSignalScanner'
        ? `${engine} [БОЕВОЙ ДВИЖОК]`
        : `${engine} [НЕ БОЕВОЙ ДВИЖОК — исключён из выводов и FDR]`;
      log(`--- ENGINE=${engineLabel} | TF=${tf} (IS 60% <= ${new Date(splitTime).toISOString()} < OOS 40%) ---`);
      log('Pattern | Side | Split | n | Ambig15m% | WR% | Mean Gross% | Mean Net@(0.20%) [SL/1m/TP] | Sum ROE | PF | MaxDD | 95% CI Net% | Rand p95 (Uncond / |24h|>=3%) | Better? | p_raw(1s) | OOS Pass');
      log('---|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|---|---|---|---|---|---|');

      for (const [key, list] of groups.entries()) {
        const [patternName, side] = key.split('|||') as [string, 'LONG' | 'SHORT'];
        const isList = list.filter(t => t.entryTime <= splitTime);
        const oosList = list.filter(t => t.entryTime > splitTime);

        for (const [splitLabel, subset] of [
          ['ALL', list],
          ['IS-60%', isList],
          ['OOS-40%', oosList]
        ] as const) {
          const stats = summarizeTrades(subset, `${engine}_${tf}_${key}_${splitLabel}`);
          const randUncond = runRandomBaselineMonteCarlo(
            subset,
            seriesBySym,
            tf,
            side,
            splitLabel,
            splitTime,
            `${engine}_${tf}_${key}_${splitLabel}`,
            false
          );
          const randCondVol = tf === '15m'
            ? runRandomBaselineMonteCarlo(
                subset,
                seriesBySym,
                tf,
                side,
                splitLabel,
                splitTime,
                `${engine}_${tf}_${key}_${splitLabel}`,
                true
              )
            : randUncond;

          // Ambiguous % and 1M_RESOLVED / TP_FIRST for this subset
          let ambigCnt = 0;
          let mean1mRes = stats.meanNet020Pct;
          let meanTpFirst = stats.meanNet020Pct;
          if (subset.length > 0 && tf === '15m') {
            let sum1m = 0;
            let sumTp = 0;
            for (const t of subset) {
              if (t.encounteredAmbiguousBar) ambigCnt++;
              const ser = seriesBySym.get(t.symbol)!;
              sum1m += getCachedOutcome(ser, '15m', t.side, t.entryCandleIdx, '1M_RESOLVED', ambigInfo.slices).leveragedNetPct020;
              sumTp += getCachedOutcome(ser, '15m', t.side, t.entryCandleIdx, 'TP_FIRST', ambigInfo.slices).leveragedNetPct020;
            }
            mean1mRes = sum1m / subset.length;
            meanTpFirst = sumTp / subset.length;
          }
          const ambigPct = subset.length > 0 ? (ambigCnt / subset.length) * 100 : 0;

          const betterUncond = stats.n > 0 && stats.meanNet020Pct > randUncond.p95;
          const betterCond = stats.n > 0 && stats.meanNet020Pct > randCondVol.p95;
          const oosPass =
            splitLabel === 'OOS-40%' &&
            stats.n >= 30 &&
            stats.meanNet020Pct > 0 &&
            stats.ci95[0] > 0 &&
            betterUncond;

          // Live config sensitivity computation for OOS-40% (15m)
          if (splitLabel === 'OOS-40%' && subset.length > 0 && tf === '15m') {
            const gKey = `${engine}:${patternName}:${side}`;
            const b020: number[] = [];
            const l016: number[] = [];
            const l020: number[] = [];
            let levSum = 0;
            let slSum = 0;
            for (const t of subset) {
              const ser = seriesBySym.get(t.symbol)!;
              const ls = getCachedLiveSensitivityOutcome(ser, t.side, t.entryCandleIdx, ambigInfo.slices, {
                range24hPct: t.range24hPct,
                change24hPct: t.change24hPct,
                atrAtEntry: t.atrAtEntry,
                localHigh: t.localHigh,
                localLow: t.localLow
              });
              b020.push(t.leveragedNetPct020);
              l016.push(ls.netPctLiveCost016);
              l020.push(ls.netPctTaker020);
              levSum += ls.leverage;
              slSum += ls.slPct;
            }
            liveSensitivityByGroup.set(gKey, {
              label: gKey,
              side,
              splitTime,
              subset,
              baseline020: b020,
              live016: l016,
              live020: l020,
              levSum,
              slSum
            });
          }

          const isProductionEngine = engine === 'marketSignalScanner';
          const pBonfProd16 = isProductionEngine
            ? Number(Math.min(1, stats.pOneSidedRaw * MULTIPLE_TESTING_M_PROD).toFixed(6))
            : null;

          const rowObj: any = {
            engine,
            isProductionEngine,
            timeframe: tf,
            patternName,
            side,
            split: splitLabel,
            n: stats.n,
            wins: stats.wins,
            winRatePct: Number(stats.winRatePct.toFixed(2)),
            ambiguous15mPct: Number(ambigPct.toFixed(2)),
            meanGrossPct: Number(stats.meanGrossPct.toFixed(3)),
            meanNet016Pct: Number(stats.meanNet016Pct.toFixed(3)),
            meanNet020Pct: Number(stats.meanNet020Pct.toFixed(3)),
            meanNet020_1mResolvedPct: Number(mean1mRes.toFixed(3)),
            meanNet020_TpFirstPct: Number(meanTpFirst.toFixed(3)),
            meanNet030Pct: Number(stats.meanNet030Pct.toFixed(3)),
            sumNet020Pp: Number(stats.sumNet020Pp.toFixed(2)),
            profitFactor: Number(stats.profitFactor.toFixed(3)),
            maxDdRoePp: Number(stats.maxDdRoePp.toFixed(2)),
            ci95: [Number(stats.ci95[0].toFixed(3)), Number(stats.ci95[1].toFixed(3))],
            tStat: Number(stats.tStat.toFixed(3)),
            pOneSidedRaw: Number(stats.pOneSidedRaw.toFixed(6)),
            pTwoSidedRaw: Number(stats.pTwoSidedRaw.toFixed(6)),
            pBonferroniProd16: pBonfProd16,
            qBhProd16: null,
            qBhProdTested: null,
            randMean020Pct: Number(randUncond.mean.toFixed(3)),
            randP95020Pct: Number(randUncond.p95.toFixed(3)),
            condVolRandP95020Pct: Number(randCondVol.p95.toFixed(3)),
            betterThanRandom: betterUncond,
            betterThanCondVolRandom: betterCond,
            oosPass: isProductionEngine ? oosPass : false,
            rawCandidatePassBeforeProdFilter: oosPass,
            note: stats.note
          };
          summaryRows.push(rowObj);
          if (splitLabel === 'OOS-40%') oosRowsForFdr.push(rowObj);
          if (isProductionEngine && oosPass) oosPassingStrategies.push(rowObj);

          log(
            `${patternName}${isProductionEngine ? '' : ' [НЕ БОЕВОЙ]'} | ${side} | ${splitLabel} | ${stats.n} | ${ambigPct.toFixed(1)}% | ${stats.winRatePct.toFixed(1)}% | ` +
            `${stats.meanGrossPct.toFixed(2)}% | ${stats.meanNet020Pct.toFixed(2)}% / ${mean1mRes.toFixed(2)}% / ${meanTpFirst.toFixed(2)}% | ` +
            `${stats.sumNet020Pp.toFixed(1)} | ${stats.profitFactor >= 99 ? 'INF' : stats.profitFactor.toFixed(2)} | ${stats.maxDdRoePp.toFixed(1)} | ` +
            `[${stats.ci95[0].toFixed(2)}%, ${stats.ci95[1].toFixed(2)}%] | ${randUncond.p95.toFixed(2)}% / ${randCondVol.p95.toFixed(2)}% | ` +
            `${betterUncond ? 'да' : 'нет'}/${betterCond ? 'да' : 'нет'} | ${stats.pOneSidedRaw.toFixed(4)} | ${splitLabel === 'OOS-40%' ? (!isProductionEngine ? 'N/A(NON-PROD)' : (oosPass ? 'PASS' : 'FAIL')) : '-'}`
          );
        }
      }
      log('');
    }
  }

  // J1.5: Compute Benjamini-Hochberg FDR q-values ONLY over production marketSignalScanner OOS rows (M_prod = 16 / actualProdOosCount)
  const oosProdRows = oosRowsForFdr.filter(r => r.isProductionEngine);
  const oosNonProdRows = oosRowsForFdr.filter(r => !r.isProductionEngine);
  const oosProdSortedByP = [...oosProdRows].sort((a, b) => a.pOneSidedRaw - b.pOneSidedRaw);
  const actualProdOosCount = oosProdSortedByP.length;
  let minBhTested = 1;
  let minBh16 = 1;
  for (let idx = oosProdSortedByP.length - 1; idx >= 0; idx--) {
    const rank = idx + 1;
    const rawTested = (oosProdSortedByP[idx].pOneSidedRaw * actualProdOosCount) / rank;
    const raw16 = (oosProdSortedByP[idx].pOneSidedRaw * MULTIPLE_TESTING_M_PROD) / rank;
    minBhTested = Math.min(minBhTested, Math.min(1, rawTested));
    minBh16 = Math.min(minBh16, Math.min(1, raw16));
    oosProdSortedByP[idx].qBhProdTested = Number(minBhTested.toFixed(6));
    oosProdSortedByP[idx].qBhProd16 = Number(minBh16.toFixed(6));
  }

  log(`--- J1.5: IS-60% VS OOS-40% STABILITY & MULTIPLE-TESTING CORRECTIONS (PRODUCTION ONLY: marketSignalScanner, M_prod = ${MULTIPLE_TESTING_M_PROD}, tested in OOS = ${actualProdOosCount}, alpha_bonf = ${(0.05 / MULTIPLE_TESTING_M_PROD).toFixed(6)}) ---`);
  log('Engine | Pattern | Side | TF | IS MeanNet% (n) | OOS MeanNet% (n) | OOS CondRandP95% | t-stat | p_raw (1-sided) | p_Bonf(M=16) | q_BH(M=16) | q_BH(tested)');
  log('---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of oosProdSortedByP) {
    const isRow = summaryRows.find(
      x => x.engine === r.engine && x.timeframe === r.timeframe && x.patternName === r.patternName && x.side === r.side && x.split === 'IS-60%'
    );
    const isStr = isRow ? `${isRow.meanNet020Pct.toFixed(2)}% (n=${isRow.n})` : 'N/A';
    log(
      `${r.engine} | ${r.patternName} | ${r.side} | ${r.timeframe} | ${isStr} | ` +
      `${r.meanNet020Pct.toFixed(2)}% (n=${r.n}) | ${r.condVolRandP95020Pct.toFixed(2)}% | ` +
      `${r.tStat.toFixed(2)} | ${r.pOneSidedRaw.toFixed(5)} | ${Number(r.pBonferroniProd16).toFixed(5)} | ${Number(r.qBhProd16).toFixed(5)} | ${Number(r.qBhProdTested).toFixed(5)}`
    );
  }
  if (oosNonProdRows.length > 0) {
    log('');
    log('--- НЕ БОЕВОЙ ДВИЖОК (patternScannerService — в server/ НЕ вызывается, исключён из выводов и FDR M_prod) ---');
    for (const r of oosNonProdRows) {
      const isRow = summaryRows.find(
        x => x.engine === r.engine && x.timeframe === r.timeframe && x.patternName === r.patternName && x.side === r.side && x.split === 'IS-60%'
      );
      const isStr = isRow ? `${isRow.meanNet020Pct.toFixed(2)}% (n=${isRow.n})` : 'N/A';
      log(
        `${r.engine} [НЕ БОЕВОЙ ДВИЖОК] | ${r.patternName} | ${r.side} | ${r.timeframe} | ${isStr} | ` +
        `${r.meanNet020Pct.toFixed(2)}% (n=${r.n}) | ${r.condVolRandP95020Pct.toFixed(2)}% | ${r.tStat.toFixed(2)} | ${r.pOneSidedRaw.toFixed(5)} | EXCLUDED | EXCLUDED | EXCLUDED`
      );
    }
  }
  log('');

  // J1.4: Live Config Sensitivity Output with CI95, tStat, FDR & Live-Geometry CondVol Monte Carlo Baseline
  log('--- J1.4: LIVE CONFIG SENSITIVITY RUN ON OOS-40% (15m) ---');
  log('Baseline v2: fixed 5x, SL 2.0%, TP 3.0%, minNormalAutoClose=4%, bypassTP=false, Trail=off, cost=0.20%');
  log('Live Approx: settings.json conservative vol-capped leverage (5x->3x/2x), Struct SL [1.0%,2.2%], TP4=4.5%, minNormalAutoClose=6%, bypassTP=true, Trail 14%/3%, timeoutProfit 18h@6%, cost=0.16% & 0.20%');
  log('Group | n | AvgLev | AvgSL% | Base@0.20% | Live@0.16% [CI95] | Live@0.20% [CI95] | t(0.20) | p_raw | p_Bonf16 | q_BH16 | LiveCondRandP95(0.16/0.20) | BeatRand(0.16/0.20) | Live WR@0.16% | MaxDD@0.16%');
  log('---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---|---|---:|---:|');
  const liveSensitivityRows: any[] = [];
  for (const g of liveSensitivityByGroup.values()) {
    const isProductionEngine = g.label.startsWith('marketSignalScanner:');
    const n = g.baseline020.length;
    const baseS = summarizeValues(g.baseline020);
    const l016S = summarizeValues(g.live016);
    const l020S = summarizeValues(g.live020);
    const avgLev = g.levSum / n;
    const avgSlPct = (g.slSum / n) * 100;

    const liveCi95_016 = bootstrapMeanCi95(g.live016, 2000, hashString(`LIVE_CI16_${g.label}`));
    const liveCi95_020 = bootstrapMeanCi95(g.live020, 2000, hashString(`LIVE_CI20_${g.label}`));
    const tTest016 = computeOneSampleTTest(g.live016);
    const tTest020 = computeOneSampleTTest(g.live020);
    const liveRand = runLiveCondVolRandomBaselineMonteCarlo(
      g.subset,
      seriesBySym,
      g.side,
      g.splitTime,
      g.label,
      ambigInfo.slices
    );

    liveSensitivityRows.push({
      group: g.label,
      isProductionEngine,
      n,
      avgLeverage: Number(avgLev.toFixed(2)),
      avgSlPct: Number(avgSlPct.toFixed(2)),
      baselineMeanNet020Pct: Number(baseS.mean.toFixed(3)),
      liveMeanNet016Pct: Number(l016S.mean.toFixed(3)),
      liveMeanNet020Pct: Number(l020S.mean.toFixed(3)),
      liveCi95_016: [Number(liveCi95_016[0].toFixed(3)), Number(liveCi95_016[1].toFixed(3))],
      liveCi95_020: [Number(liveCi95_020[0].toFixed(3)), Number(liveCi95_020[1].toFixed(3))],
      tStat_016: Number(tTest016.tStat.toFixed(3)),
      tStat_020: Number(tTest020.tStat.toFixed(3)),
      pOneSidedRaw_020: Number(tTest020.pOneSided.toFixed(6)),
      pBonferroniProd16_020: isProductionEngine ? Number(Math.min(1, tTest020.pOneSided * MULTIPLE_TESTING_M_PROD).toFixed(6)) : null,
      qBhProd16_020: null,
      qBhProdTested_020: null,
      liveCondVolRandMean016Pct: Number(liveRand.mean_016.toFixed(3)),
      liveCondVolRandP95016Pct: Number(liveRand.p95_016.toFixed(3)),
      liveCondVolRandMean020Pct: Number(liveRand.mean_020.toFixed(3)),
      liveCondVolRandP95020Pct: Number(liveRand.p95_020.toFixed(3)),
      betterThanLiveCondVolRand016: l016S.mean > liveRand.p95_016,
      betterThanLiveCondVolRand020: l020S.mean > liveRand.p95_020,
      liveWr016Pct: Number(l016S.wr.toFixed(2)),
      liveSum016Pp: Number(l016S.sum.toFixed(2)),
      liveMaxDd016Pp: Number(l016S.maxDd.toFixed(2))
    });
  }

  // BH FDR q-values ONLY across production marketSignalScanner liveSensitivityOosRows
  const liveProdSortedByP = liveSensitivityRows.filter(r => r.isProductionEngine).sort((a, b) => a.pOneSidedRaw_020 - b.pOneSidedRaw_020);
  const liveProdTestedCount = liveProdSortedByP.length;
  let minLiveBh16 = 1;
  let minLiveBhTested = 1;
  for (let idx = liveProdSortedByP.length - 1; idx >= 0; idx--) {
    const rank = idx + 1;
    const raw16 = (liveProdSortedByP[idx].pOneSidedRaw_020 * MULTIPLE_TESTING_M_PROD) / rank;
    const rawTested = (liveProdSortedByP[idx].pOneSidedRaw_020 * liveProdTestedCount) / rank;
    minLiveBh16 = Math.min(minLiveBh16, Math.min(1, raw16));
    minLiveBhTested = Math.min(minLiveBhTested, Math.min(1, rawTested));
    liveProdSortedByP[idx].qBhProd16_020 = Number(minLiveBh16.toFixed(6));
    liveProdSortedByP[idx].qBhProdTested_020 = Number(minLiveBhTested.toFixed(6));
  }

  for (const row of liveSensitivityRows) {
    const labelStr = row.isProductionEngine ? row.group : `${row.group} [НЕ БОЕВОЙ ДВИЖОК]`;
    const bonfStr = row.pBonferroniProd16_020 !== null ? row.pBonferroniProd16_020.toFixed(5) : 'EXCLUDED';
    const qStr = row.qBhProd16_020 !== null ? row.qBhProd16_020.toFixed(5) : 'EXCLUDED';
    log(
      `${labelStr} | ${row.n} | ${row.avgLeverage.toFixed(2)}x | ${row.avgSlPct.toFixed(2)}% | ${row.baselineMeanNet020Pct.toFixed(2)}% | ` +
      `${row.liveMeanNet016Pct.toFixed(2)}% [${row.liveCi95_016[0].toFixed(2)}, ${row.liveCi95_016[1].toFixed(2)}] | ` +
      `${row.liveMeanNet020Pct.toFixed(2)}% [${row.liveCi95_020[0].toFixed(2)}, ${row.liveCi95_020[1].toFixed(2)}] | ` +
      `${row.tStat_020.toFixed(2)} | ${row.pOneSidedRaw_020.toFixed(5)} | ${bonfStr} | ${qStr} | ` +
      `${row.liveCondVolRandP95016Pct.toFixed(2)}% / ${row.liveCondVolRandP95020Pct.toFixed(2)}% | ` +
      `${row.betterThanLiveCondVolRand016 ? 'да' : 'нет'}/${row.betterThanLiveCondVolRand020 ? 'да' : 'нет'} | ` +
      `${row.liveWr016Pct.toFixed(1)}% | ${row.liveMaxDd016Pp.toFixed(1)}`
    );
  }
  log('');

  // J1.7: Fixed Control Universe (20 established liquid perpetuals, independent of current 24h turnover recency bias)
  let fixedControlComparison: any = null;
  if (!USE_FIXED_UNIVERSE) {
    const missingFixed = FIXED_CONTROL_SYMBOLS.filter(s => !seriesBySym.has(s));
    for (let i = 0; i < missingFixed.length; i += 5) {
      const chunk = missingFixed.slice(i, i + 5);
      const loaded = await Promise.all(
        chunk.map(async sym => ({
          sym,
          c15: await loadOrDownloadCandles(sym, '15m', DAYS_15M, false),
          c1: await loadOrDownloadCandles(sym, '1m', DAYS_1M, true)
        }))
      );
      for (const { sym, c15, c1 } of loaded) {
        if (c15.length < 150) continue;
        seriesBySym.set(sym, {
          symbol: sym,
          candles15: c15,
          candles1: c1,
          idx1m: c1.length > 0 ? build1mIndex(c1) : null,
          outcomeCache: new Map(),
          liveOutcomeCache: new Map()
        });
      }
    }

    const fixedTrades: SimTrade[] = [];
    for (const sym of FIXED_CONTROL_SYMBOLS) {
      const ser = seriesBySym.get(sym);
      if (!ser) continue;
      fixedTrades.push(...backtestPatternScanner(ser, '15m'));
      fixedTrades.push(...backtestMarketSignalScanner(ser));
    }

    const scanner15Fixed = fixedTrades.filter(t => t.engine === 'marketSignalScanner' && t.timeframe === '15m').sort((a, b) => a.entryTime - b.entryTime);
    const fixedSplitTime = scanner15Fixed.length > 0
      ? scanner15Fixed[0].entryTime + (scanner15Fixed[scanner15Fixed.length - 1].entryTime - scanner15Fixed[0].entryTime) * 0.6
      : 0;
    const fixedOosScanner = scanner15Fixed.filter(t => t.entryTime > fixedSplitTime);

    const summarizeFixedGroup = (label: string, subset: SimTrade[], side: 'LONG' | 'SHORT') => {
      const s = summarizeTrades(subset, `FIXED_CTRL_${label}`);
      const live016: number[] = [];
      for (const t of subset) {
        const ser = seriesBySym.get(t.symbol)!;
        live016.push(getCachedLiveSensitivityOutcome(ser, t.side, t.entryCandleIdx, ambigInfo.slices, {
          range24hPct: t.range24hPct,
          change24hPct: t.change24hPct,
          atrAtEntry: t.atrAtEntry,
          localHigh: t.localHigh,
          localLow: t.localLow
        }).netPctLiveCost016);
      }
      const lS = summarizeValues(live016);
      const lCi = bootstrapMeanCi95(live016, 2000, hashString(`FIXED_LIVE_CI_${label}`));
      return {
        label,
        side,
        n: s.n,
        wrPct: Number(s.winRatePct.toFixed(2)),
        baseMeanNet020Pct: Number(s.meanNet020Pct.toFixed(3)),
        baseCi95: [Number(s.ci95[0].toFixed(3)), Number(s.ci95[1].toFixed(3))],
        liveMeanNet016Pct: Number(lS.mean.toFixed(3)),
        liveCi95_016: [Number(lCi[0].toFixed(3)), Number(lCi[1].toFixed(3))]
      };
    };

    const fixedPooled = summarizeTrades(scanner15Fixed, 'FIXED_POOLED_SCANNER');
    const fixedOosPooled = summarizeTrades(fixedOosScanner, 'FIXED_OOS_SCANNER');
    const fixedVolClimaxShortOos = summarizeFixedGroup(
      'marketSignalScanner:💀 Volume Climax (Predictive Dump):SHORT',
      fixedOosScanner.filter(t => t.patternName.includes('Volume Climax (Predictive Dump)') && t.side === 'SHORT'),
      'SHORT'
    );
    const fixedProlivLongOos = summarizeFixedGroup(
      'marketSignalScanner:💥 ПРОЛИВ (SAR Bottom Reversal):LONG',
      fixedOosScanner.filter(t => t.patternName.includes('ПРОЛИВ (SAR Bottom Reversal)') && t.side === 'LONG'),
      'LONG'
    );

    const inLiveTop30 = FIXED_CONTROL_SYMBOLS.filter(s => seriesList.some(x => x.symbol === s));
    fixedControlComparison = {
      controlSymbols: FIXED_CONTROL_SYMBOLS,
      overlapWithLiveTop30: inLiveTop30.length,
      scanner15mPooled: { n: fixedPooled.n, wrPct: Number(fixedPooled.winRatePct.toFixed(2)), meanNet020Pct: Number(fixedPooled.meanNet020Pct.toFixed(3)), ci95: [Number(fixedPooled.ci95[0].toFixed(3)), Number(fixedPooled.ci95[1].toFixed(3))] },
      scanner15mOosPooled: { n: fixedOosPooled.n, wrPct: Number(fixedOosPooled.winRatePct.toFixed(2)), meanNet020Pct: Number(fixedOosPooled.meanNet020Pct.toFixed(3)), ci95: [Number(fixedOosPooled.ci95[0].toFixed(3)), Number(fixedOosPooled.ci95[1].toFixed(3))] },
      volumeClimaxShortOos: fixedVolClimaxShortOos,
      prolivLongOos: fixedProlivLongOos
    };

    log('--- J1.7: FIXED CONTROL UNIVERSE COMPARISON (20 LIQUID MAJORS, NO 24H VOLUME SELECTION) ---');
    log(`Control overlap with Live Top-30: ${inLiveTop30.length}/${FIXED_CONTROL_SYMBOLS.length} symbols`);
    log(`  - Pooled marketSignalScanner (15m, n=${fixedPooled.n}): WR=${fixedPooled.winRatePct.toFixed(1)}%, MeanNet@0.20%=${fixedPooled.meanNet020Pct.toFixed(2)}% [${fixedPooled.ci95[0].toFixed(2)}%, ${fixedPooled.ci95[1].toFixed(2)}%]`);
    log(`  - OOS-40% marketSignalScanner (15m, n=${fixedOosPooled.n}): WR=${fixedOosPooled.winRatePct.toFixed(1)}%, MeanNet@0.20%=${fixedOosPooled.meanNet020Pct.toFixed(2)}% [${fixedOosPooled.ci95[0].toFixed(2)}%, ${fixedOosPooled.ci95[1].toFixed(2)}%]`);
    log(`  - OOS Volume Climax SHORT (control n=${fixedVolClimaxShortOos.n}): Base@0.20%=${fixedVolClimaxShortOos.baseMeanNet020Pct.toFixed(2)}% [${fixedVolClimaxShortOos.baseCi95[0].toFixed(2)}%, ${fixedVolClimaxShortOos.baseCi95[1].toFixed(2)}%] | Live@0.16%=${fixedVolClimaxShortOos.liveMeanNet016Pct.toFixed(2)}% [${fixedVolClimaxShortOos.liveCi95_016[0].toFixed(2)}%, ${fixedVolClimaxShortOos.liveCi95_016[1].toFixed(2)}%]`);
    log(`  - OOS ПРОЛИВ LONG (control n=${fixedProlivLongOos.n}): Base@0.20%=${fixedProlivLongOos.baseMeanNet020Pct.toFixed(2)}% [${fixedProlivLongOos.baseCi95[0].toFixed(2)}%, ${fixedProlivLongOos.baseCi95[1].toFixed(2)}%] | Live@0.16%=${fixedProlivLongOos.liveMeanNet016Pct.toFixed(2)}% [${fixedProlivLongOos.liveCi95_016[0].toFixed(2)}%, ${fixedProlivLongOos.liveCi95_016[1].toFixed(2)}%]`);
    log('');
  }

  log('--- POOLED SUMMARY & COST SENSITIVITY BY ENGINE/TIMEFRAME ---');
  for (const engine of ['patternScannerService', 'marketSignalScanner'] as const) {
    for (const tf of ['15m', '1m'] as const) {
      const pool = allTrades.filter(t => t.engine === engine && t.timeframe === tf);
      if (pool.length === 0) continue;
      const s = summarizeTrades(pool, `POOL_${engine}_${tf}`);
      const engTag = engine === 'marketSignalScanner' ? `${engine} [БОЕВОЙ ДВИЖОК]` : `${engine} [НЕ БОЕВОЙ ДВИЖОК]`;
      log(
        `${engTag} (${tf}, n=${s.n}, WR=${s.winRatePct.toFixed(1)}%): MeanGross=${s.meanGrossPct.toFixed(2)}% | ` +
        `Net@0.16%=${s.meanNet016Pct.toFixed(2)}% | Net@0.20%=${s.meanNet020Pct.toFixed(2)}% (Sum=${s.sumNet020Pp.toFixed(1)} п.п., MaxDD=${s.maxDdRoePp.toFixed(1)} п.п.) | ` +
        `Net@0.30%=${s.meanNet030Pct.toFixed(2)}%`
      );
    }
  }

  log('');
  log(`PRODUCTION OOS PASSING STRATEGIES (${oosPassingStrategies.length}, marketSignalScanner only; patternScannerService excluded): ${oosPassingStrategies.length === 0 ? 'NONE' : oosPassingStrategies.map(x => `${x.engine}:${x.patternName}:${x.side}(${x.timeframe})`).join('; ')}`);

  const outDir = path.dirname(REPORT_JSON_OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    REPORT_JSON_OUT,
    JSON.stringify(
      {
        version: 'v2.3-l5',
        generatedAt: new Date().toISOString(),
        productionEngines: ['marketSignalScanner'],
        nonProductionEngines: ['patternScannerService'],
        patternScannerServiceExcludedFromConclusions: true,
        preCommittedOosCriterion: OOS_PASS_CRITERION_TEXT,
        multipleTestingHypothesesM: MULTIPLE_TESTING_M_PROD,
        multipleTestingActualProdOosCount: actualProdOosCount,
        bonferroniAlpha005: Number((0.05 / MULTIPLE_TESTING_M_PROD).toFixed(6)),
        breakEvenRoeAt5x: {
          cost016Pct: 0.8,
          cost020Pct: 1.0,
          cost030Pct: 1.5
        },
        ambiguous15mStats: {
          total15mTrades: trades15mAll.length,
          ambiguous15mCount: ambigInfo.ambiguous15mCount,
          ambiguous15mPct: Number(ambigInfo.ambiguous15mPct.toFixed(2)),
          resolvedBy1mSeriesCount: ambigInfo.resolvedBy1mSeriesCount,
          resolvedBy1mSliceCount: ambigInfo.resolvedBy1mSliceCount,
          fetchedNewSlices: ambigInfo.fetchedNewSlices,
          unresolvedAmbiguousCount: ambigInfo.unresolvedAmbiguousCount,
          pooled15mByTieMode: {
            SL_FIRST: { wrPct: Number(slFirstPooled15m.wr.toFixed(2)), meanNet020Pct: Number(slFirstPooled15m.mean.toFixed(3)), sumNet020Pp: Number(slFirstPooled15m.sum.toFixed(2)) },
            '1M_RESOLVED': { wrPct: Number(resolved1mPooled15m.wr.toFixed(2)), meanNet020Pct: Number(resolved1mPooled15m.mean.toFixed(3)), sumNet020Pp: Number(resolved1mPooled15m.sum.toFixed(2)) },
            TP_FIRST: { wrPct: Number(tpFirstPooled15m.wr.toFixed(2)), meanNet020Pct: Number(tpFirstPooled15m.mean.toFixed(3)), sumNet020Pp: Number(tpFirstPooled15m.sum.toFixed(2)) }
          }
        },
        universeSource: universe.source,
        symbols: seriesList.map(s => s.symbol),
        days15m: DAYS_15M,
        days1m: DAYS_1M,
        leverage: LEVERAGE,
        stopLossPct: STOP_LOSS_PCT,
        takeProfitPct: TAKE_PROFIT_PCT,
        monteCarloRuns: MONTE_CARLO_RUNS,
        maxDdMethod: 'non_compounded_roe_percentage_points',
        positionConstraint: 'one_active_position_per_symbol_per_engine_timeframe',
        dataCoverage,
        fixedControlComparison,
        totalTrades: allTrades.length,
        oosPassingCount: oosPassingStrategies.length,
        oosPassingStrategies,
        liveSensitivityOosRows: liveSensitivityRows,
        rows: summaryRows
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(REPORT_TXT_OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`\nSaved JSON -> ${path.relative(process.cwd(), REPORT_JSON_OUT)}`);
  console.log(`Saved TXT  -> ${path.relative(process.cwd(), REPORT_TXT_OUT)}`);
}

main().catch(err => {
  console.error('Backtest v2 failed:', err);
  process.exit(1);
});
