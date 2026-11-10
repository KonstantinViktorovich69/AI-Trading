import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

import { evaluateEvidenceGate } from './evidenceGate.ts';
import { buildEvidenceReport } from './evidenceReport.ts';
import { isEntryPaused, resetEntryGateForTest } from './entryGate.ts';
import {
  validateExpertInstructionModification,
  validateKnowledgeRebalanceSize,
  FORBIDDEN_EXPERT_INSTRUCTION_MARKERS
} from './selfLearningGuard.ts';
import { SettingsManager, createDefaultGlobalSettings } from './settingsManager.ts';
import { DEFAULT_BASELINE_EXPERT_INSTRUCTIONS } from '../data/defaultStrategyKnowledge.ts';
import { createAiOptimizationWorker } from '../workers/aiOptimizationWorker.ts';
import { createRealTradeRouter } from '../routes/realTradeRoutes.ts';
import { createPaperTradeRouter } from '../routes/paperTradeRoutes.ts';
import { createSystemRouter } from '../routes/systemRoutes.ts';
import { createSettingsRouter, sanitizeAiSettingsUpdate } from '../routes/settingsRoutes.ts';
import { isCleanLearningTrade } from './learningCells.ts';
import { resetLearningCellServiceForTest } from './learningCellService.ts';
import { inferCloseReasonCode } from './tradeSchema.ts';
import { AtomicStateStore } from '../atomicDbSaver.ts';
import { aiGatewayService } from './aiOrchestrator.ts';

function makeCleanTrade(idx: number, pnlPct: number, overrides: Record<string, any> = {}): any {
  const baseTs = Date.UTC(2026, 2, 1, 0, 0, 0);
  const openTime = baseTs + idx * 2.5 * 3600 * 1000;
  const closeTime = openTime + 30 * 60 * 1000;
  return {
    id: `T7-${idx}`,
    symbol: 'ETHUSDT',
    side: idx % 2 === 0 ? 'SHORT' : 'LONG',
    status: 'CLOSED',
    mode: 'AUTO',
    dataOrigin: 'PAPER',
    isReal: false,
    isAutoLearning: false,
    isForcedReset: false,
    entryPrice: 2000,
    closePrice: pnlPct >= 0 ? 2020 : 1980,
    amount: 100,
    leverage: 1,
    pnl: pnlPct,
    pnlPercent: pnlPct,
    grossPnlUsd: pnlPct + 0.16,
    feeUsd: 0.12,
    slippageUsd: 0.04,
    costModelVersion: 2,
    featuresVersion: 2,
    closeReasonCode: pnlPct >= 0 ? 'TAKE_PROFIT' : 'STOP_LOSS',
    closeReason: pnlPct >= 0 ? 'Take Profit' : 'Stop Loss',
    matchedPattern: 'Double Top',
    marketRegime: 'RANGING',
    dataQuality: 'LIVE',
    openTime,
    closeTime,
    ...overrides
  };
}

async function withServer(router: express.Router, mountPath: string, fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}${mountPath}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Phase 7 — Self-control & Real Trading Protection (T7.1 - T7.6)', () => {
  let tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    resetEntryGateForTest();
    resetLearningCellServiceForTest();
    aiGatewayService.resetAiFallbackCount();
  });

  afterEach(() => {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  describe('T7.1 — Evidence Gate for real orders', () => {
    it('blocks when fewer than 150 clean trades exist even if all are profitable', () => {
      const trades = Array.from({ length: 10 }, (_, i) => makeCleanTrade(i, 5));
      const res = evaluateEvidenceGate(trades, createDefaultGlobalSettings());
      expect(res.enabled).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.checks.minTradesOk).toBe(false);
      expect(res.reason).toContain('EVIDENCE_GATE:');
    });

    it('blocks 200 losing trades with negative expectancy', () => {
      const trades = Array.from({ length: 200 }, (_, i) => makeCleanTrade(i, -1.5));
      const res = evaluateEvidenceGate(trades, createDefaultGlobalSettings());
      expect(res.passed).toBe(false);
      expect(res.checks.minTradesOk).toBe(true);
      expect(res.checks.minDaysOk).toBe(true);
      expect(res.checks.ciPositiveOk).toBe(false);
    });

    it('passes when >= 150 clean v2 trades span >= 14 days with positive CI95.lo and low drawdown', () => {
      const trades = Array.from({ length: 200 }, (_, i) =>
        makeCleanTrade(i, i % 5 === 0 ? -0.4 : 1.2)
      );
      const res = evaluateEvidenceGate(trades, createDefaultGlobalSettings());
      expect(res.passed).toBe(true);
      expect(res.rawPassed).toBe(true);
      expect(res.ci95.lo).toBeGreaterThan(0);
      expect(res.maxDrawdownPct).toBeLessThanOrEqual(15);
      expect(res.spanDays).toBeGreaterThanOrEqual(14);
    });

    it('enforces featuresVersion >= 2 when modelSideAwareFeatures is true', () => {
      const v1FeatureTrades = Array.from({ length: 160 }, (_, i) =>
        makeCleanTrade(i, 1.5, { featuresVersion: 1 })
      );
      const res = evaluateEvidenceGate(v1FeatureTrades, {
        ...createDefaultGlobalSettings(),
        modelSideAwareFeatures: true
      });
      expect(res.eligibleTradesCount).toBe(0);
      expect(res.passed).toBe(false);
    });

    it('blocks POST /api/real-trade/open (403) when evidence fails, allows virtual POST /api/paper-trade/open (200)', async () => {
      const prevRealFlag = process.env.ENABLE_REAL_TRADING;
      process.env.ENABLE_REAL_TRADING = 'true';
      try {
        const trades = Array.from({ length: 5 }, (_, i) => makeCleanTrade(i, 4));
        const settings = {
          ...createDefaultGlobalSettings(),
          exchangeApiConfig: { exchange: 'weex', apiKey: 'k', apiSecret: 's', password: 'p', isEnabled: true }
        };
        const executeRealOpenOnExchange = vi.fn().mockResolvedValue({ success: true, entryPrice: 100 });

        const realRouter = createRealTradeRouter({
          getGlobalSettings: () => settings,
          getVirtualTrades: () => trades,
          saveTradeDB: vi.fn(),
          sendTelegramMessage: vi.fn(async () => {}),
          sendTelegramTestMessage: vi.fn(async () => ({ success: true })),
          enrichExchangeError: (e: any) => String(e),
          getCcxtClient: () => null,
          getUnifiedTradeClosePnl: () => ({ pnlUsd: 0, pnlPercent: 0 }),
          findTickerInMap: () => null,
          getWsTickers: () => ({}),
          getGlobalCcxtTickers: () => ({}),
          getTradeSyncAttempts: () => new Map(),
          getRealPositionsCache: () => ({ data: [], lastUpdated: 0 }),
          setRealPositionsCache: vi.fn(),
          isRealTradingAllowed: () => true,
          executeRealOpenOnExchange
        });

        await withServer(realRouter, '/api', async (baseUrl) => {
          const resp = await fetch(`${baseUrl}/real-trade/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: 'BTC/USDT', side: 'LONG', amount: 50, leverage: 5 })
          });
          const data: any = await resp.json();
          expect(resp.status).toBe(403);
          expect(data.success).toBe(false);
          expect(data.error).toContain('EVIDENCE_GATE:');
          expect(executeRealOpenOnExchange).not.toHaveBeenCalled();
        });

        const paperRouter = createPaperTradeRouter({
          getVirtualTrades: () => trades,
          getVirtualBalance: () => 500,
          setVirtualBalance: vi.fn(),
          getStartOfDayBalance: () => 500,
          setStartOfDayBalance: vi.fn(),
          getStartOfDayRealBalance: () => 0,
          setStartOfDayRealBalance: vi.fn(),
          getStartOfWeekBalance: () => 500,
          setStartOfWeekBalance: vi.fn(),
          getIsCircuitBreakerActive: () => false,
          setIsCircuitBreakerActive: vi.fn(),
          getLastBtcShockTime: () => 0,
          getGlobalSettings: () => settings,
          getWsTickers: () => ({}),
          getGlobalCcxtTickers: () => ({}),
          getSignalsData: () => [],
          getModelWeights: () => ({}),
          getAtomicStoreRevision: () => 1,
          saveTradeDB: vi.fn(async () => {}),
          saveBalanceDB: vi.fn(),
          normalizeSymbol: (s: string) => s.replace(/[/:]/g, '').toUpperCase(),
          findTickerInMap: () => null,
          validatePaperTradeInput: (i: any) => ({ valid: true, value: i }),
          acquireExecutionLock: () => true,
          releaseExecutionLock: vi.fn(),
          executeRealOpenOnExchange,
          getUnifiedTradeClosePnl: () => ({ pnlUsd: 0 }),
          getExchangeLink: () => '',
          getTradingAdvice: () => '',
          getChartImageHtml: () => '',
          sendTelegramMessage: vi.fn(async () => {}),
          streamEmitter: { emit: vi.fn(() => true) },
          log400: vi.fn()
        });

        await withServer(paperRouter, '/api', async (baseUrl) => {
          // Virtual entry must succeed regardless of evidence gate
          const virtResp = await fetch(`${baseUrl}/paper-trade/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: 'BTC/USDT',
              exchange: 'weex',
              entryPrice: 50000,
              amount: 50,
              leverage: 5,
              side: 'LONG',
              isReal: false
            })
          });
          expect(virtResp.status).toBe(200);

          // Real entry through paper-trade route must be blocked (403)
          const realResp = await fetch(`${baseUrl}/paper-trade/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: 'ETH/USDT',
              exchange: 'weex',
              entryPrice: 2000,
              amount: 50,
              leverage: 5,
              side: 'LONG',
              isReal: true
            })
          });
          expect(realResp.status).toBe(403);
          expect(executeRealOpenOnExchange).not.toHaveBeenCalled();
        });
      } finally {
        if (prevRealFlag === undefined) delete process.env.ENABLE_REAL_TRADING;
        else process.env.ENABLE_REAL_TRADING = prevRealFlag;
      }
    });

    it('protects Evidence Gate settings against AI optimizer updates', () => {
      const cleaned = sanitizeAiSettingsUpdate({
        realTradingEvidenceGateEnabled: false,
        evidenceGateOverride: true,
        evidenceGateMinTrades: 1,
        staleDataPauseSec: 99999,
        btcShockThreshold: 2.0
      }, 'test');
      expect(cleaned.realTradingEvidenceGateEnabled).toBeUndefined();
      expect(cleaned.evidenceGateOverride).toBeUndefined();
      expect(cleaned.evidenceGateMinTrades).toBeUndefined();
      expect(cleaned.staleDataPauseSec).toBeUndefined();
      expect(cleaned.btcShockThreshold).toBe(2.0);
    });
  });

  describe('T7.2 — Evidence Report & Snapshot', () => {
    it('builds breakdowns across costModelVersion, pattern, hour UTC, side, regimes, dataQuality, and writes snapshot', () => {
      const tmpDir = makeTempDir('p7-report-');
      const fixture = [
        makeCleanTrade(0, 2.5, { costModelVersion: 1, matchedPattern: 'Double Top', side: 'SHORT', entryDiagnostics: { regimeLegacy: 'UPTREND', shadow: { regimeReal: 'RANGING' }, dataQuality: 'LIVE' } }),
        makeCleanTrade(1, -1.2, { costModelVersion: 2, matchedPattern: 'False Breakout', side: 'LONG', entryDiagnostics: { regimeLegacy: 'FLAT', shadow: { regimeReal: 'DOWNTREND' }, dataQuality: 'ESTIMATED' } }),
        makeCleanTrade(2, 3.1, { costModelVersion: 2, matchedPattern: 'Double Top', side: 'SHORT', entryDiagnostics: { regimeLegacy: 'UPTREND', shadow: { regimeReal: 'UPTREND' }, dataQuality: 'LIVE' } }),
        makeCleanTrade(3, 0, { closeReasonCode: 'STALE_UNPRICED', closePriceSource: 'ENTRY_FALLBACK' })
      ];

      const report = buildEvidenceReport(fixture, createDefaultGlobalSettings(), undefined, {
        writeSnapshot: true,
        reportsDir: tmpDir,
        nowTs: Date.UTC(2026, 2, 15)
      });

      expect(report.totalTrades).toBe(4);
      expect(report.cleanTrades).toBe(3);
      expect(report.excludedTrades).toBe(1);
      expect(report.byCostModelVersion.v1.summary.n).toBe(1);
      expect(report.byCostModelVersion.v2.summary.n).toBe(2);
      expect(Object.keys(report.byCostModelVersion.v2.byPattern).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(report.byCostModelVersion.v2.bySide)).toEqual(expect.arrayContaining(['LONG', 'SHORT']));
      expect(report.protectedPatternsPolicy).toBe('PENALIZE_ONLY');

      const snapPath = path.join(tmpDir, 'evidence-2026-03-15.json');
      expect(fs.existsSync(snapPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
      expect(parsed.cleanTrades).toBe(3);
    });

    it('handles empty trades without throwing and serves GET /api/system/evidence-report', async () => {
      const emptyReport = buildEvidenceReport([], createDefaultGlobalSettings());
      expect(emptyReport.cleanTrades).toBe(0);
      expect(emptyReport.cells).toEqual([]);
      expect(emptyReport.evidenceGate.passed).toBe(false);

      const sysRouter = createSystemRouter({
        getVirtualTrades: () => [],
        getKnowledgeBase: () => [],
        getGlobalSettings: () => createDefaultGlobalSettings(),
        getCachedDB: () => ({}),
        requestDBSave: vi.fn(),
        streamEmitter: { emit: vi.fn(() => true) },
        queryStructuredLogs: () => ({ logs: [], total: 0 }),
        getCurrentExchangePingMs: () => 25,
        getExchangePingHistory: () => [],
        getProlivPeaks: () => [],
        getAiCommitteeCache: () => ({}),
        getSignalsCache: () => ({ data: [], marketRegime: 'FLAT' }),
        getPendingFrontendAiTasks: () => [],
        setPendingFrontendAiTasks: vi.fn()
      });

      await withServer(sysRouter, '/api', async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/system/evidence-report?snapshot=0`);
        expect(resp.status).toBe(200);
        const json: any = await resp.json();
        expect(json.success).toBe(true);
        expect(json.cleanTrades).toBe(0);
      });
    });
  });

  describe('T7.3 — Unified read-only health panel', () => {
    it('returns signal/loop/data ages, aiGateway stats, positions, evidenceGate, regimes, and flags without side effects', async () => {
      const now = Date.now();
      const requestDBSave = vi.fn();
      const trades = [
        { id: 'OPEN-V', status: 'OPEN', isReal: false },
        { id: 'OPEN-R', status: 'OPEN', isReal: true },
        makeCleanTrade(0, 2)
      ];
      aiGatewayService.recordSuccessEvent(now - 5000);

      const sysRouter = createSystemRouter({
        getVirtualTrades: () => trades,
        getKnowledgeBase: () => [],
        getGlobalSettings: () => createDefaultGlobalSettings(),
        getCachedDB: () => ({}),
        requestDBSave,
        streamEmitter: { emit: vi.fn(() => true) },
        queryStructuredLogs: () => ({ logs: [], total: 0 }),
        getCurrentExchangePingMs: () => 18,
        getExchangePingHistory: () => [],
        getProlivPeaks: () => [],
        getAiCommitteeCache: () => ({}),
        getSignalsCache: () => ({
          data: [],
          lastUpdated: now - 10_000,
          marketRegime: 'UPTREND',
          regimeLegacy: 'UPTREND',
          regimeReal: 'RANGING'
        }),
        getPendingFrontendAiTasks: () => [],
        setPendingFrontendAiTasks: vi.fn(),
        getGlobalCcxtTickers: () => ({ weex: {} }),
        getGlobalTrueOhlcv: () => ({ BTCUSDT: { updatedAt: now - 15_000 } }),
        getApiHealth: () => ({ weex: { latency: 18, status: 'online', lastCheck: now, lastSuccessfulSyncAt: now - 12_000 } })
      });

      await withServer(sysRouter, '/api', async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/system/health`);
        expect(resp.status).toBe(200);
        const body: any = await resp.json();
        expect(body.success).toBe(true);
        expect(body.signalScanAgeSec).toBeGreaterThanOrEqual(9);
        expect(body.autopilotTickAgeSec).toBeGreaterThanOrEqual(0);
        expect(body.tickersAgeSec).toBeGreaterThanOrEqual(11);
        expect(body.btcOhlcvAgeSec).toBeGreaterThanOrEqual(14);
        expect(body.entryGate).toEqual({ paused: false });
        expect(body.openPositions).toEqual({ virtual: 1, real: 1, total: 2 });
        expect(body.aiGateway.lastSuccessAt).toBeTruthy();
        expect(body.evidenceGate.enabled).toBe(true);
        expect(body.regimes).toEqual({ current: 'UPTREND', legacy: 'UPTREND', real: 'RANGING' });
        expect(body.flags.realTradingEvidenceGateEnabled).toBe(true);
        expect(body.flags.staleDataPauseSec).toBe(300);
        expect(requestDBSave).not.toHaveBeenCalled();
      });
    });
  });

  describe('T7.4 — Self-learning contour protections', () => {
    it('rejects overly long (> 600), forbidden safety-disabling, and within-24h retrospective instruction updates', () => {
      const longMod = 'A'.repeat(601);
      expect(validateExpertInstructionModification(longMod).valid).toBe(false);
      expect(validateExpertInstructionModification(longMod).reason).toContain('LENGTH_EXCEEDED');

      expect(FORBIDDEN_EXPERT_INSTRUCTION_MARKERS.length).toBeGreaterThan(5);
      const badMod1 = validateExpertInstructionModification('Рекомендация: отключить стоп-лосс при росте волатильности');
      expect(badMod1.valid).toBe(false);
      expect(badMod1.reason).toContain('FORBIDDEN_MARKER');

      const badMod2 = validateExpertInstructionModification('Всегда закрывать в +0.1% без ожидания целей');
      expect(badMod2.valid).toBe(false);

      const t0 = Date.UTC(2026, 2, 10, 12, 0, 0);
      const tooSoon = validateExpertInstructionModification('Усилить фильтр объема', {
        lastRetrospectiveUpdateAt: t0,
        nowTs: t0 + 2 * 3600 * 1000
      });
      expect(tooSoon.valid).toBe(false);
      expect(tooSoon.reason).toContain('COOLDOWN_ACTIVE');

      const okAfter25h = validateExpertInstructionModification('Усилить фильтр объема после пробоя', {
        lastRetrospectiveUpdateAt: t0,
        nowTs: t0 + 25 * 3600 * 1000
      });
      expect(okAfter25h.valid).toBe(true);
    });

    it('keeps version history (last 20) and restores previous version via POST /api/system/expert-instructions/rollback', async () => {
      const tmpDir = makeTempDir('p7-inst-');
      const settingsPath = path.join(tmpDir, 'settings.json');
      const dbPath = path.join(tmpDir, 'db.json');
      const historyPath = path.join(tmpDir, 'expert_instructions_history.json');
      const cachedDb: any = { aiExpertTraderInstructionsHistory: [] };

      fs.writeFileSync(
        settingsPath,
        JSON.stringify(createDefaultGlobalSettings(DEFAULT_BASELINE_EXPERT_INSTRUCTIONS), null, 2),
        'utf-8'
      );

      const sm = new SettingsManager({
        settingsFilePath: settingsPath,
        dbFilePath: dbPath,
        expertHistoryFilePath: historyPath,
        getCachedDB: () => cachedDb,
        flushDB: vi.fn(async () => {})
      });

      const initialInstructions = sm.getSettings().aiExpertTraderInstructions;
      const baseWithoutSec5 = initialInstructions.split('### 5. АДАПТИВНЫЕ')[0].trim();
      const sec5Header = '### 5. АДАПТИВНЫЕ РЕТРОСПЕКТИВНЫЕ КОРРЕКТИРОВКИ (ОБНОВЛЯЮТСЯ ИИ-ОПТИМИЗАТОРОМ)';

      // 1st USER change creates a history entry containing initialInstructions
      sm.setExpertInstructions(`${baseWithoutSec5}\n\n${sec5Header}\nВерсия 2: Усилить проверку VWAP.`, 'USER', 'Test v2');
      // 2nd USER change creates another history entry containing Version 2
      sm.setExpertInstructions(`${baseWithoutSec5}\n\n${sec5Header}\nВерсия 3: Ограничить плечо.`, 'USER', 'Test v3');

      // Forbidden RETROSPECTIVE attempt must be rejected cleanly
      const beforeForbidden = sm.getSettings().aiExpertTraderInstructions;
      const resRejected = sm.setExpertInstructions(
        `${baseWithoutSec5}\n\n${sec5Header}\nНужно убрать стоп-лосс на всех монетах.`,
        'RETROSPECTIVE',
        'Malicious'
      );
      expect(resRejected.sanitized).toBe(true);
      expect(sm.getSettings().aiExpertTraderInstructions).toBe(beforeForbidden);

      // History file persisted atomically with capped length <= 20
      expect(fs.existsSync(historyPath)).toBe(true);
      const savedHist = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      expect(savedHist.length).toBe(2);

      const sysRouter = createSystemRouter({
        getVirtualTrades: () => [],
        getKnowledgeBase: () => [],
        getGlobalSettings: () => sm.getSettings(),
        getCachedDB: () => cachedDb,
        requestDBSave: vi.fn(),
        streamEmitter: { emit: vi.fn(() => true) },
        queryStructuredLogs: () => ({ logs: [], total: 0 }),
        getCurrentExchangePingMs: () => 20,
        getExchangePingHistory: () => [],
        getProlivPeaks: () => [],
        getAiCommitteeCache: () => ({}),
        getSignalsCache: () => ({}),
        getPendingFrontendAiTasks: () => [],
        setPendingFrontendAiTasks: vi.fn(),
        setExpertInstructions: (inst, src, rsn) => sm.setExpertInstructions(inst, src as any, rsn),
        saveSettings: () => sm.saveSettings()
      });

      await withServer(sysRouter, '/api', async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/system/expert-instructions/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        expect(resp.status).toBe(200);
        const body: any = await resp.json();
        expect(body.success).toBe(true);
        expect(sm.getSettings().aiExpertTraderInstructions).toContain('Версия 2');
      });
    });

    it('blocks autonomousKnowledgeRebalance when compressed below 30% of active rules and saves snapshot', async () => {
      const tmpDir = makeTempDir('p7-kb-');
      const kb = Array.from({ length: 10 }, (_, i) => ({
        id: `r-${i}`,
        agent: 'GENERAL',
        text: `Rule ${i} about liquidity sweep and VWAP confluence`,
        impact: 10,
        successRate: 0.6,
        usageCount: 5,
        isArchived: false
      }));
      const cachedDb: any = { knowledge: [...kb] };
      const flushDB = vi.fn();

      const worker = createAiOptimizationWorker({
        getCachedDB: () => cachedDb,
        flushDB,
        syncToFirebase: vi.fn(async () => {}),
        isFirebaseFirestoreDisabled: true,
        getDb: () => null,
        getKnowledgeBase: () => kb,
        saveKnowledgeDB: vi.fn(async () => {}),
        deleteKnowledgeDB: vi.fn(async () => {}),
        getVirtualTrades: () => [],
        getGlobalSettings: () => createDefaultGlobalSettings(),
        setExpertInstructions: vi.fn(),
        getMarketRegime: () => 'RANGING',
        getMarketHealth: () => 60,
        runAiGeneration: vi.fn(async () => ({
          text: JSON.stringify([{ agent: 'GENERAL', text: 'Only 1 compressed rule', impact: 15 }])
        })),
        safeJsonParse: (s: string) => JSON.parse(s),
        getSmartArchivistPrompt: () => '',
        getArchivistPrompt: () => 'archivist prompt',
        getRetrospectivePrompt: () => '',
        logAgentExchange: vi.fn(),
        sendTelegramMessage: vi.fn(),
        streamEmitter: { emit: vi.fn(() => true) },
        updatePatternBlacklistFromStats: vi.fn(),
        isMainThread: false,
        getReportsDir: () => tmpDir
      });

      await worker.autonomousKnowledgeRebalance();

      // KB must NOT be overwritten (1 rule < 30% of 10 active = 3)
      expect(kb.length).toBe(10);
      expect(flushDB).not.toHaveBeenCalled();

      // Pre-rebalance snapshot must exist in tmpDir
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('kb_snapshot_') && f.endsWith('.json'));
      expect(files.length).toBe(1);
      const snap = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
      expect(snap.length).toBe(10);

      expect(validateKnowledgeRebalanceSize(3, 10).allowed).toBe(true);
      expect(validateKnowledgeRebalanceSize(2, 10).allowed).toBe(false);
    });
  });

  describe('T7.5 — Entry Gate pauses on stale ticker or BTC OHLCV data', () => {
    it('allows fresh data and pauses when tickers or BTC OHLCV age > staleDataPauseSec', () => {
      const now = 1_700_000_000_000;
      const fresh = isEntryPaused(now, {
        getGlobalSettings: () => ({ staleDataPauseSec: 300 }),
        getApiHealth: () => ({ weex: { lastSuccessfulSyncAt: now - 30_000 } }),
        getGlobalTrueOhlcv: () => ({ BTCUSDT: { updatedAt: now - 45_000 } })
      });
      expect(fresh.paused).toBe(false);

      const staleTickers = isEntryPaused(now, {
        getGlobalSettings: () => ({ staleDataPauseSec: 300 }),
        getApiHealth: () => ({ weex: { lastSuccessfulSyncAt: now - 350_000 } }),
        getGlobalTrueOhlcv: () => ({ BTCUSDT: { updatedAt: now - 30_000 } })
      });
      expect(staleTickers.paused).toBe(true);
      expect(staleTickers.reason).toContain('stale_data_tickers');

      const staleBtc = isEntryPaused(now, {
        getGlobalSettings: () => ({ staleDataPauseSec: 300 }),
        getApiHealth: () => ({ weex: { lastSuccessfulSyncAt: now - 10_000 } }),
        getGlobalTrueOhlcv: () => ({ BTCUSDT: { updatedAt: now - 420_000 } })
      });
      expect(staleBtc.paused).toBe(true);
      expect(staleBtc.reason).toContain('stale_data_btc_ohlcv');
    });
  });

  describe('T7.6 — Storage atomic write & STALE_UNPRICED exclusion', () => {
    it('tags unpriced closure as STALE_UNPRICED and excludes it from clean learning trades', async () => {
      const openTrade = {
        id: 'VT-UNPRICED-1',
        symbol: 'XRP/USDT',
        side: 'LONG',
        status: 'OPEN',
        entryPrice: 0.5,
        amount: 100,
        leverage: 5,
        isReal: false,
        isAutoLearning: false,
        openTime: Date.now() - 600_000
      };
      const trades = [openTrade];

      const paperRouter = createPaperTradeRouter({
        getVirtualTrades: () => trades,
        getVirtualBalance: () => 500,
        setVirtualBalance: vi.fn(),
        getStartOfDayBalance: () => 500,
        setStartOfDayBalance: vi.fn(),
        getStartOfDayRealBalance: () => 0,
        setStartOfDayRealBalance: vi.fn(),
        getStartOfWeekBalance: () => 500,
        setStartOfWeekBalance: vi.fn(),
        getIsCircuitBreakerActive: () => false,
        setIsCircuitBreakerActive: vi.fn(),
        getLastBtcShockTime: () => 0,
        getGlobalSettings: () => createDefaultGlobalSettings(),
        getWsTickers: () => ({}),
        getGlobalCcxtTickers: () => ({}),
        getSignalsData: () => [],
        getModelWeights: () => ({}),
        getAtomicStoreRevision: () => 1,
        saveTradeDB: vi.fn(async () => {}),
        saveBalanceDB: vi.fn(),
        normalizeSymbol: (s: string) => s,
        findTickerInMap: () => null,
        validatePaperTradeInput: (i: any) => ({ valid: true, value: i }),
        acquireExecutionLock: () => true,
        releaseExecutionLock: vi.fn(),
        executeRealOpenOnExchange: vi.fn(),
        getUnifiedTradeClosePnl: () => ({ pnlUsd: 0, grossPnlUsd: 0, feeUsd: 0, slippageUsd: 0, costModelVersion: 2 }),
        getExchangeLink: () => '',
        getTradingAdvice: () => '',
        getChartImageHtml: () => '',
        sendTelegramMessage: vi.fn(async () => {}),
        streamEmitter: { emit: vi.fn(() => true) },
        log400: vi.fn()
      });

      await withServer(paperRouter, '/api', async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/paper-trade/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'VT-UNPRICED-1', closePrice: 0, notes: 'No ticker' })
        });
        expect(resp.status).toBe(200);
        const body: any = await resp.json();
        expect(body.data.closeReasonCode).toBe('STALE_UNPRICED');
        expect(body.data.closePriceSource).toBe('ENTRY_FALLBACK');
        expect(inferCloseReasonCode(body.data)).toBe('STALE_UNPRICED');
        expect(isCleanLearningTrade(body.data)).toBe(false);
      });
    });

    it('writes AtomicStateStore cleanly without leaving .tmp files behind', () => {
      const tmpDir = makeTempDir('p7-atomic-');
      const target = path.join(tmpDir, 'database.json');
      const store = new AtomicStateStore(target);
      store.writeDirect({ virtualTrades: [{ id: 'A1' }] });
      expect(fs.existsSync(target)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(parsed.virtualTrades[0].id).toBe('A1');
      const leftoverTmp = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'));
      expect(leftoverTmp.length).toBe(0);
    });
  });
});
