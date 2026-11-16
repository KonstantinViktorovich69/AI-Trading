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
import { RSI, BollingerBands, VWAP, PSAR } from 'technicalindicators';
import { detectTradingPatterns, type Candle } from '../server/services/patternScannerService.ts';
import { evaluateScannerPatternPure, isTraditionalEquitySymbol } from '../server/services/marketSignalScanner.ts';
import { computeVolumeSpikeRatio } from '../server/services/marketDataCollectorService.ts';
import { evaluateExitPolicy, type ExitPolicySettings, type ExitTradeSnapshot } from '../server/services/exitPolicy.ts';

const FALLBACK_TOP30_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'SOLUSDT', 'XRPUSDT',
  'IDOLUSDT', 'XPINUSDT', 'ZECUSDT', 'BCHUSDT', 'DOGEUSDT',
  'ATOMUSDT', 'AVAXUSDT', 'LINKUSDT', 'BNBUSDT', 'BTWUSDT',
  'CROSSUSDT', 'ZAMAUSDT', 'KGENUSDT', 'TRXUSDT', 'SUIUSDT',
  'LTCUSDT', 'ADAUSDT', 'UNIUSDT', 'HYPEUSDT', 'XLMUSDT',
  'ASTERUSDT', 'BZUSDT', 'THETAUSDT', 'DOTUSDT', 'AKEUSDT'
];

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'backtest_cache');
const REPORT_JSON_OUT = path.resolve(process.cwd(), 'reports', 'diagnostics_2026-11-14', 'g7_backtest_summary.json');
const REPORT_TXT_OUT = path.resolve(process.cwd(), 'reports', 'diagnostics_2026-11-14', 'g7_backtest_report.txt');

const DAYS_15M = 180;
const DAYS_1M = 60;
const LEVERAGE = 5;
const STOP_LOSS_PCT = 0.02;   // 2.0% unleveraged => -10.0% ROE before costs
const TAKE_PROFIT_PCT = 0.03; // 3.0% unleveraged => +15.0% ROE before costs
const MONTE_CARLO_RUNS = 200;

// PRE-COMMITTED OOS PASS CRITERION (locked before inspecting v2 results)
const OOS_PASS_CRITERION_TEXT =
  'OOS-40% PASS <=> (n >= 30) AND (Mean Net@(0.20%) > 0%) AND (95% CI lo > 0%) AND (Mean Net@(0.20%) > Rand p95@(0.20%))';

type EngineName = 'patternScannerService' | 'marketSignalScanner';

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
    } catch (err: any) {
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

function executeSingleTradeAtEntry(
  symbol: string,
  timeframe: '15m' | '1m',
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number,
  candles: Candle[],
  candles1mIdx: { times: number[]; candles: Candle[] } | null
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

  const evalPathBar = (bar: Candle): boolean => {
    tradeSnapshot.highestPrice = Math.max(tradeSnapshot.highestPrice || bar.high, bar.high);
    tradeSnapshot.lowestPrice = Math.min(tradeSnapshot.lowestPrice || bar.low, bar.low);

    // Conservative worst-case tie-breaker: SL evaluated before TP on same bar
    const slHit = side === 'LONG' ? bar.low <= stopLoss : bar.high >= stopLoss;
    const tpHit = side === 'LONG' ? bar.high >= takeProfit : bar.low <= takeProfit;

    if (slHit) {
      exitPrice = stopLoss;
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
  if (candles1mIdx && candles1mIdx.times.length > 0 && entryTime >= candles1mIdx.times[0]) {
    used1mExecution = true;
    const start1m = findFirstIndexGte(candles1mIdx.times, entryTime);
    const max1mBars = 24 * 60 + 5;
    for (let k = start1m; k < Math.min(candles1mIdx.candles.length, start1m + max1mBars); k++) {
      const b = candles1mIdx.candles[k];
      if (evalPathBar(b)) {
        closed = true;
        break;
      }
      exitPrice = b.close;
      exitTime = b.time;
    }
  }

  if (!closed && !used1mExecution) {
    const maxBars = timeframe === '15m' ? 24 * 4 + 2 : 24 * 60 + 5;
    if (!evalPathBar(entryCandle)) {
      for (let k = entryCandleIdx + 1; k < Math.min(candles.length, entryCandleIdx + 1 + maxBars); k++) {
        const b = candles[k];
        if (evalPathBar(b)) {
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
    used1mExecution
  };
}

interface SymbolSeries {
  symbol: string;
  candles15: Candle[];
  candles1: Candle[];
  idx1m: { times: number[]; candles: Candle[] } | null;
  outcomeCache: Map<string, ExecOutcome>;
}

function getCachedOutcome(
  series: SymbolSeries,
  timeframe: '15m' | '1m',
  side: 'LONG' | 'SHORT',
  entryCandleIdx: number
): ExecOutcome {
  const key = `${timeframe}:${side}:${entryCandleIdx}`;
  let hit = series.outcomeCache.get(key);
  if (!hit) {
    const candles = timeframe === '15m' ? series.candles15 : series.candles1;
    const subIdx = timeframe === '1m' ? { times: candles.map(c => c.time), candles } : series.idx1m;
    hit = executeSingleTradeAtEntry(series.symbol, timeframe, side, entryCandleIdx, candles, subIdx);
    series.outcomeCache.set(key, hit);
  }
  return hit;
}

function backtestPatternScanner(series: SymbolSeries, timeframe: '15m' | '1m'): SimTrade[] {
  const candles = timeframe === '15m' ? series.candles15 : series.candles1;
  const trades: SimTrade[] = [];
  const windowSize = 48;
  // ONE ACTIVE POSITION PER SYMBOL (per timeframe)
  let activeUntil = 0;

  for (let i = windowSize; i < candles.length - 2; i++) {
    const entryCandle = candles[i + 1];
    if (entryCandle.time <= activeUntil) continue;

    const window = candles.slice(i - windowSize + 1, i + 1);
    const detected = detectTradingPatterns(window);
    if (!detected) continue;

    const outcome = getCachedOutcome(series, timeframe, detected.side, i + 1);
    activeUntil = outcome.exitTime;

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
      used1mExecution: outcome.used1mExecution
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

  // Offset maps so index i matches indicator computed strictly up to closed bar i
  const psarOffset = candles.length - psarAll.length;
  const rsiOffset = candles.length - rsiAll.length;
  const bbOffset = candles.length - bbAll.length;

  // ONE ACTIVE POSITION PER SYMBOL
  let activeUntil = 0;

  for (let i = 96; i < candles.length - 2; i++) {
    const entryCandle = candles[i + 1];
    if (entryCandle.time <= activeUntil) continue;

    // Rolling 24h window (96 x 15m closed candles ending at i)
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
    const bar = candles[i];
    const tickerPrice = bar.close;
    const change = open24h > 0 ? ((tickerPrice - open24h) / open24h) * 100 : 0;

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

    // Pass 22 closed candles ending at i plus dummy trailing element representing unclosed bar i+1
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

    const outcome = getCachedOutcome(series, '15m', evalRes.signalSide, i + 1);
    activeUntil = outcome.exitTime;

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
      used1mExecution: outcome.used1mExecution
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
  seedKey: string
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
    const minIdx = 96;
    const idxs: number[] = [];
    for (let idx = minIdx; idx < candles.length - 2; idx++) {
      const entryT = candles[idx].time;
      if (splitLabel === 'IS-60%' && entryT > splitTime) continue;
      if (splitLabel === 'OOS-40%' && entryT <= splitTime) continue;
      idxs.push(idx);
    }
    candidateIndicesBySym.set(sym, idxs);
  }

  const rng = createMulberry32(hashString(`MC_${seedKey}`));
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
          // Resample once without overlap if collided
          let found = -1;
          for (let tries = 0; tries < 5; tries++) {
            const alt = pool[Math.floor(rng() * pool.length)];
            if (candles[alt].time > busyUntil) {
              found = alt;
              break;
            }
          }
          if (found === -1) continue;
          const out = getCachedOutcome(ser, timeframe, side, found);
          busyUntil = out.exitTime;
          totalNet += out.leveragedNetPct020;
          totalN++;
        } else {
          const out = getCachedOutcome(ser, timeframe, side, entryIdx);
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

function summarizeTrades(
  trades: SimTrade[],
  seedKey: string
) {
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
    note: n < 30 ? 'выборка мала (n<30)' : 'OK (n >= 30)'
  };
}

async function main() {
  const lines: string[] = [];
  const log = (s = '') => {
    console.log(s);
    lines.push(s);
  };

  log('=== H4 / G7 BACKTEST v2 (TOP-30 WEEX FUTURES, 1 POS/SYMBOL, MONTE CARLO BASELINE) ===');
  log(`Pre-committed OOS Pass Criterion: ${OOS_PASS_CRITERION_TEXT}`);
  log(`Depth: 15m=${DAYS_15M}d (all Top-30), 1m=${DAYS_1M}d (cached majors) | Leverage=${LEVERAGE}x, SL=${(STOP_LOSS_PCT * 100).toFixed(1)}% (-10% ROE), TP=${(TAKE_PROFIT_PCT * 100).toFixed(1)}% (+15% ROE)`);
  log(`MaxDD unit: linear non-compounded ROE percentage points (п.п. ROE) on fixed margin per trade`);
  log('');

  const universe = await resolveTop30WeexSymbols(30);
  log(`Universe (${universe.symbols.length}): ${universe.source}`);
  log(`Symbols: ${universe.symbols.join(', ')}`);
  log('');

  const seriesList: SymbolSeries[] = [];
  const seriesBySym = new Map<string, SymbolSeries>();
  const dataCoverage: Record<string, any> = {};

  // Download missing 15m histories with 5 symbols concurrently (~45-60s total if uncached)
  for (let i = 0; i < universe.symbols.length; i += 5) {
    const chunk = universe.symbols.slice(i, i + 5);
    const loaded = await Promise.all(
      chunk.map(async (sym) => {
        const c15 = await loadOrDownloadCandles(sym, '15m', DAYS_15M, false);
        const c1 = await loadOrDownloadCandles(sym, '1m', DAYS_1M, true); // reuse cached 1m sub-bars where available
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
        outcomeCache: new Map()
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
    log(`[LOAD] Loaded ${Math.min(i + 5, universe.symbols.length)}/${universe.symbols.length} symbols (active with >=150 bars: ${seriesList.length})`);
  }

  const allTrades: SimTrade[] = [];
  for (const ser of seriesList) {
    allTrades.push(...backtestPatternScanner(ser, '15m'));
    if (ser.candles1.length >= 200) {
      allTrades.push(...backtestPatternScanner(ser, '1m'));
    }
    allTrades.push(...backtestMarketSignalScanner(ser));
  }

  log('');
  log(`Total trades simulated (1 active pos/symbol/engine): ${allTrades.length}`);
  log(`  - patternScannerService (15m): ${allTrades.filter(t => t.engine === 'patternScannerService' && t.timeframe === '15m').length}`);
  log(`  - patternScannerService (1m):  ${allTrades.filter(t => t.engine === 'patternScannerService' && t.timeframe === '1m').length}`);
  log(`  - marketSignalScanner (15m):   ${allTrades.filter(t => t.engine === 'marketSignalScanner').length}`);
  log('');

  const summaryRows: any[] = [];
  const oosPassingStrategies: any[] = [];

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

      log(`--- ENGINE=${engine} | TF=${tf} (IS 60% <= ${new Date(splitTime).toISOString()} < OOS 40%) ---`);
      log('Pattern | Side | Split | n | WR% | Mean Gross% | Mean Net@(0.20%) | Sum ROE (п.п.) | PF | MaxDD (п.п. ROE) | 95% CI Net% | Rand p95% | Лучше случайного | OOS Pass');
      log('---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|');

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
          const rand = runRandomBaselineMonteCarlo(
            subset,
            seriesBySym,
            tf,
            side,
            splitLabel,
            splitTime,
            `${engine}_${tf}_${key}_${splitLabel}`
          );
          const betterThanRandom = stats.n > 0 && stats.meanNet020Pct > rand.p95;
          const oosPass =
            splitLabel === 'OOS-40%' &&
            stats.n >= 30 &&
            stats.meanNet020Pct > 0 &&
            stats.ci95[0] > 0 &&
            betterThanRandom;

          const rowObj = {
            engine,
            timeframe: tf,
            patternName,
            side,
            split: splitLabel,
            n: stats.n,
            wins: stats.wins,
            winRatePct: Number(stats.winRatePct.toFixed(2)),
            meanGrossPct: Number(stats.meanGrossPct.toFixed(3)),
            meanNet016Pct: Number(stats.meanNet016Pct.toFixed(3)),
            meanNet020Pct: Number(stats.meanNet020Pct.toFixed(3)),
            meanNet030Pct: Number(stats.meanNet030Pct.toFixed(3)),
            sumNet020Pp: Number(stats.sumNet020Pp.toFixed(2)),
            profitFactor: Number(stats.profitFactor.toFixed(3)),
            maxDdRoePp: Number(stats.maxDdRoePp.toFixed(2)),
            ci95: [Number(stats.ci95[0].toFixed(3)), Number(stats.ci95[1].toFixed(3))],
            randMean020Pct: Number(rand.mean.toFixed(3)),
            randP95020Pct: Number(rand.p95.toFixed(3)),
            betterThanRandom,
            oosPass,
            note: stats.note
          };
          summaryRows.push(rowObj);
          if (oosPass) oosPassingStrategies.push(rowObj);

          log(
            `${patternName} | ${side} | ${splitLabel} | ${stats.n} | ${stats.winRatePct.toFixed(1)}% | ` +
            `${stats.meanGrossPct.toFixed(2)}% | ${stats.meanNet020Pct.toFixed(2)}% | ${stats.sumNet020Pp.toFixed(1)} | ` +
            `${stats.profitFactor >= 99 ? 'INF' : stats.profitFactor.toFixed(2)} | ${stats.maxDdRoePp.toFixed(1)} | ` +
            `[${stats.ci95[0].toFixed(2)}%, ${stats.ci95[1].toFixed(2)}%] | ${rand.p95.toFixed(2)}% | ` +
            `${betterThanRandom ? 'да' : 'нет'} | ${splitLabel === 'OOS-40%' ? (oosPass ? 'PASS' : 'FAIL') : '-'}`
          );
        }
      }
      log('');
    }
  }

  log('--- POOLED SUMMARY & COST SENSITIVITY BY ENGINE/TIMEFRAME ---');
  for (const engine of ['patternScannerService', 'marketSignalScanner'] as const) {
    for (const tf of ['15m', '1m'] as const) {
      const pool = allTrades.filter(t => t.engine === engine && t.timeframe === tf);
      if (pool.length === 0) continue;
      const s = summarizeTrades(pool, `POOL_${engine}_${tf}`);
      log(
        `${engine} (${tf}, n=${s.n}, WR=${s.winRatePct.toFixed(1)}%): MeanGross=${s.meanGrossPct.toFixed(2)}% | ` +
        `Net@0.16%=${s.meanNet016Pct.toFixed(2)}% | Net@0.20%=${s.meanNet020Pct.toFixed(2)}% (Sum=${s.sumNet020Pp.toFixed(1)} п.п., MaxDD=${s.maxDdRoePp.toFixed(1)} п.п.) | ` +
        `Net@0.30%=${s.meanNet030Pct.toFixed(2)}%`
      );
    }
  }

  log('');
  log(`OOS PASSING STRATEGIES (${oosPassingStrategies.length}): ${oosPassingStrategies.length === 0 ? 'NONE' : oosPassingStrategies.map(x => `${x.engine}:${x.patternName}:${x.side}(${x.timeframe})`).join('; ')}`);

  const outDir = path.dirname(REPORT_JSON_OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    REPORT_JSON_OUT,
    JSON.stringify(
      {
        version: 'v2',
        generatedAt: new Date().toISOString(),
        preCommittedOosCriterion: OOS_PASS_CRITERION_TEXT,
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
        totalTrades: allTrades.length,
        oosPassingCount: oosPassingStrategies.length,
        oosPassingStrategies,
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
