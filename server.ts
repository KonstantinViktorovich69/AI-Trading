import express from 'express';
import https from 'https';
import * as Sentry from "@sentry/node";
import Redis from "ioredis";
import 'dotenv/config';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeSymbol as quantNormalizeSymbol, cleanSymbol as quantCleanSymbol, getUnifiedTradeClosePnl as quantGetUnifiedTradeClosePnl, calculateKelly as quantCalculateKelly, calculateAdaptiveCloseRatios as quantCalculateAdaptiveCloseRatios, calculateSMA as quantCalculateSMA, calculateEMA as quantCalculateEMA, calculateRSI as quantCalculateRSI, sanitizeExpertInstructions as quantSanitizeExpertInstructions, DEFAULT_BASELINE_EXPERT_INSTRUCTIONS as quantDefaultBaselineExpertInstructions, DEAD_ZONE_PCT, isTrainableOutcome, getLossStreakSizeDampening } from './server/quant.ts';

import { getCommitteePrompt } from './server/prompts/committee.ts';
import { getArchivistPrompt } from './server/prompts/archivist.ts';
import { getMarketPulsePrompt } from './server/prompts/marketPulse.ts';
import { getRuleTesterPrompt } from './server/prompts/ruleTester.ts';
import { getSocialScraperPrompt } from './server/prompts/socialScraper.ts';
import { getSignalAnalysisPrompt } from './server/prompts/signalAnalysis.ts';
import { getOrderFlowAnalystPrompt } from './server/prompts/orderFlowAnalyst.ts';
import { getSmartArchivistPrompt } from './server/prompts/smartArchivist.ts';
import { getTradeEvaluationPrompt } from './server/prompts/tradeEvaluation.ts';
import { getPositionManagerPrompt } from './server/prompts/positionManager.ts';
import { getSettingsOptimizerPrompt } from './server/prompts/settingsOptimizer.ts';
import { getRetrospectivePrompt } from './server/prompts/retrospective.ts';
import { getSentinelShieldPrompt } from './server/prompts/sentinelShield.ts';
import { atomicWriteJson, validateDbIntegrity, getAtomicStoreRevision, dbAtomicStore, settingsAtomicStore } from './server/atomicDbSaver.ts';
import { calculateExecutionPriceWithSlippage, calculateTradingFee, calculateNetPnl } from './server/slippageFeeSimulator.ts';
import { withRateLimitRetry } from './server/rateLimiter.ts';
import { isPostgresConfigured, syncTradesToPg, syncKnowledgeToPg, loadAllFromPg } from './server/postgresDb.ts';
import { setBinanceSymbols, isBinanceCrossListed, evaluateSignalByMarketType, analyzeSpotAccumulationPatterns, updatePatternBlacklistFromStats, getBlacklistedPatterns } from './server/services/signalEngine.ts';
import { validatePaperTradeInput } from './server/tradeInputValidator.ts';
import { validateApiKey, getAuthMode, authMiddleware } from './server/middleware/auth.ts';
import { evaluateStrategySignal, evaluateEntryDecision, getApprovedExecutionSide } from './server/services/strategyEngine.ts';
import { createAiFallbackDecision, evaluateCommitteeConsensus, type AgentDecisionEnvelope } from './server/services/agentEngine.ts';
import { processIncomingStateMessage } from './server/services/stateSync.ts';
import { evaluateExitPolicy, type ExitTradeSnapshot, type ExitMarketSnapshot } from './server/services/exitPolicy.ts';
import { inferCloseReasonCode, inferDataOrigin, inferDecisionSource } from './server/services/tradeSchema.ts';
import { executeMainVirtualAutoEntry, executeMainRealAutoEntry, executeWorkerRealAutoEntry, executeWorkerVirtualAutoEntry } from './server/services/productionAutoEntryHandlers.ts';
import { createAutopilotTradeIntentFromScanner } from './server/services/autopilotIntentFactory.ts';
import { type AutoEntryExecutionPort } from './server/services/autoEntryService.ts';
import { executePaperTradeOpenTransaction, executePaperTradeCloseTransaction } from './server/services/paperTradeTransaction.ts';
import { cleanAndExtractJson, healJsonQuotesAndNewlines, repairJsonText, safeJsonParse } from './server/utils/jsonRepair.ts';
import { logStructured, queryStructuredLogs } from './server/utils/logger.ts';
import { sendTelegramMessage as serviceSendTelegramMessage, sendFormattedTelegramSignal as serviceSendFormattedTelegramSignal, getChartImageHtml, fetchTelegramChatId, sendTelegramTestMessage } from './server/services/telegramService.ts';
import { createTelegramBotService } from './server/services/telegramBotService.ts';
import { WEEX_HEADERS as serviceWEEX_HEADERS, getCcxtClient as engineGetCcxtClient, getCcxtClientConstructionCount as engineGetCcxtClientConstructionCount, getAllConfiguredExchangeAccounts as engineGetAllConfiguredExchangeAccounts, executeWithRetry as engineExecuteWithRetry, cancelAllOrdersAndTriggers as engineCancelAllOrdersAndTriggers, executeRealOpenOnExchange as engineExecuteRealOpenOnExchange, setRealTradeSlTpOnExchange as engineSetRealTradeSlTpOnExchange, executeRealPartialCloseOnExchange as engineExecuteRealPartialCloseOnExchange, executeRealCloseOnExchange as engineExecuteRealCloseOnExchange, type RealTradeEngineDependencies } from './server/services/realTradeEngine.ts';
import { calculateRSI as serviceCalculateRSI, calculateBollingerBands as serviceCalculateBollingerBands, calculateParabolicSAR as serviceCalculateParabolicSAR, calculateKDJ as serviceCalculateKDJ, calculateVWAP as serviceCalculateVWAP, detectTradingPatterns as serviceDetectTradingPatterns } from './server/services/patternScannerService.ts';
import { createKnowledgeRule as serviceCreateKnowledgeRule, toggleRuleArchive as serviceToggleRuleArchive, unarchiveAllRules as serviceUnarchiveAllRules, rebalanceKnowledgeRules as serviceRebalanceKnowledgeRules, smartAuditKnowledge as serviceSmartAuditKnowledge, formatKnowledgeBaseForPrompt as serviceFormatKnowledgeBaseForPrompt, type KnowledgeRule as ServiceKnowledgeRule } from './server/services/knowledgeService.ts';
import { createPaperTradeRouter } from './server/routes/paperTradeRoutes.ts';
import { createKnowledgeRouter, type KnowledgeRouterContext } from './server/routes/knowledgeRoutes.ts';
import { createSettingsRouter, type SettingsRouterContext } from './server/routes/settingsRoutes.ts';
import { createSystemRouter, type SystemRouterContext } from './server/routes/systemRoutes.ts';
import { createStreamRouter, type StreamRouterContext } from './server/routes/streamRoutes.ts';
import { createAiRoutes, type AiRoutesContext } from './server/routes/aiRoutes.ts';
import { createMarketRouter, type MarketRouterContext } from './server/routes/marketRoutes.ts';
import { createRealTradeRouter, type RealTradeRouterContext } from './server/routes/realTradeRoutes.ts';
import { createDebugRouter, type DebugRouterContext } from './server/routes/debugRoutes.ts';
import { createExpressApp, setupStaticAndViteMiddleware } from './server/expressAppFactory.ts';
import { createAiOptimizationWorker, getJaccardSimilarity } from './server/workers/aiOptimizationWorker.ts';
import { ScannerWorkerManager, type ScannerWorkerManagerContext } from './server/workers/scannerWorkerManager.ts';
import { SettingsManager, type GlobalSettings, createDefaultGlobalSettings } from './server/services/settingsManager.ts';
import { TradeManagerService } from './server/services/tradeManagerService.ts';
import { AutopilotEngineService } from './server/services/autoPilotEngineService.ts';
import { DatabasePersistenceManager } from './server/services/databasePersistenceManager.ts';
import { ExchangeExecutionService } from './server/services/exchangeExecutionService.ts';
import { EventStreamHub } from './server/services/eventStreamHub.ts';
import { ExchangeWsManager } from './server/services/exchangeWsManager.ts';
import { MarketDataHubService } from './server/services/marketDataHubService.ts';
import { updateTrueOHLCV as serviceUpdateTrueOHLCV, updateDerivativesData as serviceUpdateDerivativesData, checkOrderBooks as serviceCheckOrderBooks, recalculateIndicatorsForSymbol as serviceRecalculateIndicatorsForSymbol, updateLocalCandlesForSymbol as serviceUpdateLocalCandlesForSymbol, getWallAdjustedTp as serviceGetWallAdjustedTp, calculateEMA as serviceCalculateEMA, MarketDataCollectorService, type MarketDataCollectorContext } from './server/services/marketDataCollectorService.ts';
import { BackgroundSchedulerService, recordMarketHistory as serviceRecordMarketHistory, type BackgroundSchedulerContext } from './server/services/backgroundScheduler.ts';
import { getExchangeLink as serviceGetExchangeLink, buildExchangeSymbolsMap, getTradingAdvice as serviceGetTradingAdvice, syncGlobalTickers, type TickerSyncContext } from './server/services/tickerSyncService.ts';
import { generateProgrammaticCommitteeFallback as serviceGenerateProgrammaticCommitteeFallback, runDeterministicQuantCommitteeFallback as serviceRunDeterministicQuantCommitteeFallback, executeUpdateSignalsCache, type MarketSignalScannerContext } from './server/services/marketSignalScanner.ts';
import { matchesStructuredFilter as serviceMatchesStructuredFilter, calculateConfidenceProbability as serviceCalculateConfidenceProbability, executeUpdateMarketPulse as serviceExecuteUpdateMarketPulse, executeScrapeSocialSentiment as serviceExecuteScrapeSocialSentiment, type QuantRiskEngineContext } from './server/services/quantRiskEngine.ts';
import { readLocalDB as serviceReadLocalDB, writeLocalDB as serviceWriteLocalDB, getCachedDB as serviceGetCachedDB, flushDB as serviceFlushDB, requestDBSave as serviceRequestDBSave, syncToFirebase as serviceSyncToFirebase, createLocalBackup as serviceCreateLocalBackup, saveTradeToDB as serviceSaveTradeToDB, saveKnowledgeToDB as serviceSaveKnowledgeToDB, deleteKnowledgeFromDB as serviceDeleteKnowledgeFromDB, saveBalanceToDB as serviceSaveBalanceToDB, handleFirestoreError as serviceHandleFirestoreError, withFirestoreTimeout, type DbStorageContext } from './server/services/dbStorageService.ts';
import { serviceLoadStateFromDB, type DbStartupSyncContext } from './server/services/dbStartupSync.ts';
import { trainQuantModel as serviceTrainQuantModel, type QuantModelTrainerContext } from './server/services/quantModelTrainer.ts';
import { manageActiveTrades } from './server/services/virtualTradeEngine.ts';
import { aiGatewayService, AiGatewayService, pendingAiTasks, pendingWorkerAiTasks, getInternalServerGeminiClient, addAndQueueFrontendTask, getStaticServerSideAiFallback, runAiGeneration } from './server/services/aiOrchestrator.ts';
export { aiGatewayService, AiGatewayService };
import { ensureHistoricalDataSeeded, ADVANCED_RULES } from './server/db/seedData.ts';
import { runAiExpertTraderLoop as serviceRunAiExpertTraderLoop, executeRuleBasedTradeFallback as serviceExecuteRuleBasedTradeFallback } from './server/services/expertAdvisorService.ts';
import { runAutopilotAndVirtualTradeEntry as serviceRunAutopilotAndVirtualTradeEntry } from './server/services/autoPilotEngine.ts';
import { createRetrospectiveEngine } from './server/services/retrospectiveEngine.ts';
import { type KnowledgeRule, DEFAULT_KNOWLEDGE_BASE, DEFAULT_BASELINE_EXPERT_INSTRUCTIONS, WEEX_API_SUPPORTED_BASES, isWeexApiSupported, formatFuturesSymbol, enrichExchangeError } from './server/data/defaultStrategyKnowledge.ts';
import { systemMetricsCollector } from './server/services/systemMetricsCollector.ts';

// Global error handlers with Sentry integration registered at the very start of lifecycle
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});

// Periodic memory safeguard to keep process RSS well below container limits
setInterval(() => {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  if (rssMb > 900 && global.gc) {
    try { global.gc(); } catch {}
  }
}, 30000).unref();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    tracesSampleRate: 0.1,
  });
  console.log('[SENTRY] Initialized successfully');
}

// Initialize Redis with fail-soft logic
let redisDisposed = false;
let redisFailureCount = 0;
const MAX_REDIS_FAILURES = 3;

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  retryStrategy: (times) => {
    if (times > 3 || redisDisposed) return null; // Stop retrying if disposed or many failures
    return Math.min(times * 100, 2000);
  }
}) : null;

if (redis) {
  redis.on('connect', () => {
    console.log('[REDIS] Connected successfully');
    redisFailureCount = 0;
  });
  redis.on('error', (err) => {
    redisFailureCount++;
    if (redisFailureCount >= MAX_REDIS_FAILURES && !redisDisposed) {
      console.warn('[REDIS] Disabling Redis due to repeated failures.');
      redisDisposed = true;
      try { redis.disconnect(); } catch(e) {}
    }
    if (process.env.SENTRY_DSN && redisFailureCount === 1) Sentry.captureException(err);
  });
}

function safeRedisSet(key: string, value: string, mode: string, duration: number) {
  if (!redis || redisDisposed) return;
  redis.set(key, value, mode as any, duration).catch(err => {
     // Only log first few save errors
     if (redisFailureCount < MAX_REDIS_FAILURES) {
       console.error('[REDIS] Save error:', err.message);
     }
  });
}

(globalThis as any).SERVER_START_TIME = Date.now();

import { fetchMexcTickersDirect, fetchWeexTickersDirect } from './server/services/directExchangeFetchers.ts';
export { fetchMexcTickersDirect, fetchWeexTickersDirect };

import { createServer as createViteServer } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';
import ccxt, { Exchange } from 'ccxt';
import crypto from 'crypto';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';
import { RSI, MACD, BollingerBands, ATR, VWAP, KeltnerChannels, PSAR, ADX } from 'technicalindicators';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { EventEmitter } from 'events';

let firebaseConfig: any = null;
try {
  if (fs.existsSync('./firebase-applet-config.json')) {
    firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
  }
} catch (e) {
  console.error("Failed to read firebase-applet-config.json:", e);
}

const isOfflineOrTestMode = process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1';

if (!isOfflineOrTestMode) {
  try {
    let credential: any = null;
    let hasCustomCreds = false;

    // 1. Попытка загрузить сервисный аккаунт из переменной окружения
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const parsedCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        credential = admin.credential.cert(parsedCreds);
        hasCustomCreds = true;
        console.log("Firebase Admin: Инициализация через FIREBASE_SERVICE_ACCOUNT из переменной окружения.");
      } catch (parseErr: any) {
        console.error("Firebase Admin err parsing FIREBASE_SERVICE_ACCOUNT:", parseErr.message);
      }
    }

    // 2. Попытка загрузить сервисный аккаунт из локального файла
    if (!hasCustomCreds && fs.existsSync('./firebase-service-account.json')) {
      try {
        const fileCreds = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
        credential = admin.credential.cert(fileCreds);
        hasCustomCreds = true;
        console.log("Firebase Admin: Инициализация через ./firebase-service-account.json.");
      } catch (fileErr: any) {
        console.error("Firebase Admin err reading ./firebase-service-account.json:", fileErr.message);
      }
    }

    if (hasCustomCreds && credential) {
      admin.initializeApp({
        credential
      });
      console.log("Firebase Admin: Успешно инициализирована собственная база данных Firestore!");
    } else if (firebaseConfig && firebaseConfig.projectId) {
      admin.initializeApp({
        projectId: firebaseConfig.projectId
      });
      console.log(`Firebase Admin initialized successfully with active project: ${firebaseConfig.projectId}`);
    } else {
      admin.initializeApp();
      console.log("Firebase Admin initialized successfully.");
    }
  } catch (e: any) {
    console.log("Firebase Admin initialization skipped or failed: Using local database only.", e?.message || e);
  }
} else {
  console.log("[OFFLINE/TEST MODE] Firebase Admin initialization completely bypassed.");
}
const db = admin.apps.length > 0 
  ? (firebaseConfig?.firestoreDatabaseId 
      ? getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId) 
      : getFirestore(admin.app())) 
  : null;

if (db) {
  db.settings({ ignoreUndefinedProperties: true });
}
const OWNER_ID = "polyakovats3110@gmail.com";

// --- EVENT STREAM HUB (STEP 1 DECOMPOSITION) ---
const eventStreamHub = new EventStreamHub({
  getCachedDB: () => getCachedDB(),
  flushDB: () => flushDB(),
  maxLogsCount: 100
});

const streamEmitter = eventStreamHub.getEmitter();

export type { AgentExchangeLog } from './server/services/eventStreamHub.ts';

const agentExchangeLogs: any[] = new Proxy([] as any[], {
  get: (_, prop) => {
    const logs = eventStreamHub.getAgentExchangeLogs();
    const val = (logs as any)[prop];
    return typeof val === 'function' ? val.bind(logs) : val;
  }
});

export function logAgentExchange(
  fromAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER',
  toAgent: 'RETROSPECTIVE' | 'ARCHIVIST' | 'EXPERT' | 'RISK_MANAGER' | 'SCANNER' | 'ALL',
  message: string,
  details?: string,
  type: 'info' | 'success' | 'warning' = 'info'
) {
  return eventStreamHub.logAgentExchange(fromAgent, toAgent, message, details, type);
}

interface Ticker {
  exchange: string;
  pair: string;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  url: string;
  timestamp: number;
  last?: number;
}

interface CoinHistory { price: number; volume: number; timestamp: number; quoteVolume?: number; }

// --- GLOBAL STATE ---
const apiHealth: Record<string, { latency: number, status: 'online' | 'offline' | 'degraded', lastCheck: number }> = {};
const GLOBAL_CCXT_TICKERS: Record<string, Record<string, any>> = {};
const GLOBAL_DERIVATIVES: any = { fundingRates: {} };
let isFetchingGlobalTickers = false;

// Adaptive Model Weights (Logistic Regression)
let modelWeights = {
  beta0: -0.5,
  beta1: 1.2,
  beta2: -0.04,
  beta3: 0.8,
  beta4: 0.6,
  beta5: 0.3,
  beta6: 0.5,
  beta7: 0.2,
  beta8: 1.0,
  beta9: 1.5,
  beta10: 0.8,
  beta11: 1.2
};
// Status of the self-learning module
const modelStatus = {
  totalLearnedTrades: 0,
  lastRetrained: 0,
  isTrainingActive: false
};

const wsTickers: Record<string, Record<string, Ticker>> = { Binance: {}, Bybit: {}, Mexc: {}, Weex: {} };
const historyData: Record<string, CoinHistory[]> = {};
const fundingRates: Record<string, number> = {};
const openInterests: Record<string, number> = {};
const orderBookImbalance: Record<string, { bidVolume: number, askVolume: number, imbalance: number, wallDensityScore?: number, bidWallForce?: number, askWallForce?: number, walls?: { type: 'bid'|'ask', price: number, size: number, distancePct: number }[], icebergs?: any }> = {};
const GLOBAL_ORDER_BOOK_HISTORY: Record<string, { timestamp: number, bidVolume: number, askVolume: number, imbalance: number, wallDensityScore: number, walls: any[] }[]> = {};
const sentSignalsToTelegram = new Set<string>();
const symbolsUndergoingRealOpen = new Set<string>();
const configuredMarginSymbols = new Set<string>();
const configuredLeverageSymbols = new Map<string, number>();
let realPositionsCache = {
  lastUpdated: 0,
  data: [] as any[]
};
const tradeSyncAttempts = new Map<string, number>();
const lastCancelAllOrdersAndTriggers = new Map<string, number>();
const ohlcvCache: Record<string, { data: any[]; timestamp: number }> = {};
const pendingChartRequests: Record<string, Promise<any>> = {};

const GLOBAL_LIQUIDATIONS: Record<string, { shortsSq: number, longsSq: number, lastT: number }> = {};
const GLOBAL_ATR: Record<string, number> = {};
const GLOBAL_ADX: Record<string, number> = {};
const GLOBAL_WHALES: Record<string, { amount: number, time: number }> = {};
const GLOBAL_PUMPS: Set<string> = new Set();
const GLOBAL_FUNDING_HISTORY: Record<string, { rate: number, time: number }[]> = {};
const GLOBAL_TRUE_OHLCV: Record<string, any> = {};
const GLOBAL_RAW_OHLCV: Record<string, Record<string, any[][]>> = {};
const GLOBAL_CVD: Record<string, { buyVol: number, sellVol: number, cvd: number }> = {};

const GLOBAL_AI_COMMITTEE_CACHE: Record<string, { aiScore: number, liqPrice: number, consensus: string, judgeDecision: string, timestamp: number }> = {};
let lastBackgroundAiAnalysisTime = 0;

const CACHE: any = {
  signals: { data: [], marketHealth: 50 }
};

// Initial system boots log
logStructured('success', 'SYSTEM', 'Structured log manager initialized with precision millisecond epoch sorting.');

export function isRealTradingAllowed(runtimeConfig?: any): boolean {
  if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') {
    return false;
  }
  return process.env.ENABLE_REAL_TRADING === 'true';
}

function findTickerInMap(sym: string, tickers: Record<string, any>) {
  return marketDataHubService.findTickerInMap(sym, tickers);
}

if (isMainThread) {
  // Throttled price emitter (max 1 update per second to save bandwidth)
  setInterval(() => {
    streamEmitter.emit('prices_updated');
  }, 1000);

  // Set interval to send signals data (every 5 seconds instead of 1)
  setInterval(() => {
    streamEmitter.emit('signals_updated');
  }, 5000);
}
const PORT = 3000;

// Browser-like headers to bypass Cloudflare/WAF 403 Forbidden errors on WEEX
const WEEX_HEADERS = MarketDataHubService.WEEX_HEADERS;

export const marketDataHubService = new MarketDataHubService({
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getWsTickers: () => wsTickers as any,
  getApiHealth: () => apiHealth,
  getGlobalLiquidations: () => GLOBAL_LIQUIDATIONS,
  getGlobalWhales: () => GLOBAL_WHALES,
  getGlobalPumps: () => GLOBAL_PUMPS,
  getGlobalCvd: () => GLOBAL_CVD,
  getCacheSignals: () => CACHE.signals,
  getVirtualTrades: () => virtualTrades,
  updateSignalsCache: () => updateSignalsCache(),
  updateTrueOHLCV: () => updateTrueOHLCV(),
  updateLocalCandlesForSymbol: (cleanSym: string, finalPrice: number, volumeDelta: number) => updateLocalCandlesForSymbol(cleanSym, finalPrice, volumeDelta),
  emitPriceUpdate: () => streamEmitter.emit('prices_updated'),
  logStructured: (type: any, mod: string, msg: string, symbol?: string, meta?: any) => logStructured(type, mod, msg, symbol, meta),
  safeRedisSet: (key: string, val: string, mode?: string, duration?: number) => safeRedisSet(key, val, mode, duration),
  captureException: (err: any, extra?: any) => {
    if (process.env.SENTRY_DSN) Sentry.captureException(err, extra);
  }
});

// Async initialization of markets
marketDataHubService.initMarkets();

const ccxtExchanges: Record<string, Exchange> = marketDataHubService.getCcxtExchanges();
const restBlockedExchanges: Set<string> = marketDataHubService.getRestBlockedExchanges();
let isBinanceGeoblocked = marketDataHubService.getIsBinanceGeoblocked();
const PAIRS = marketDataHubService.getPairs();
const EXCHANGE_SYMBOLS: Record<string, Record<string, string>> = marketDataHubService.getExchangeSymbols();

function getExchangeLink(exchange: string, symbol: string): string {
  return marketDataHubService.getExchangeLink(exchange, symbol);
}

function cleanSymbol(sym: string): string {
  return marketDataHubService.cleanSymbol(sym);
}

function getExchangeInstance(name: string): Exchange | null {
  return marketDataHubService.getExchangeInstance(name);
}

function getTradingAdvice(signal: string, type: string): string {
  return marketDataHubService.getTradingAdvice(signal, type);
}

function normalizeSymbol(sym: string): string {
  return marketDataHubService.normalizeSymbol(sym);
}

function getTickerSyncContext(): TickerSyncContext {
  return marketDataHubService.getTickerSyncContext();
}

async function updateGlobalTickers(forceFullScan = false) {
  return marketDataHubService.updateGlobalTickers(forceFullScan);
}

function throttlePriceEmit() {
  marketDataHubService.throttlePriceEmit();
}

const exchangeWsManager = marketDataHubService.getExchangeWsManager();

function startMexcWS(retryCount = 0) {
  marketDataHubService.startMexcWS(retryCount);
}

function startBinanceWS(retryCount = 0) {
  marketDataHubService.startBinanceWS(retryCount);
}

function startBybitWS(retryCount = 0) {
  marketDataHubService.startBybitWS(retryCount);
}

// ==========================================
// АДДИТИВНЫЕ РАСШИРЕНИЯ КЛАССА TIER-1 QUANT:
// ==========================================

// 1. Измеритель задержки цикла событий (High-Resolution Event Loop Lag Monitor)
let serverEventLoopLagMs = 0;
function getEventLoopLagMs(): number {
  return systemMetricsCollector.getEventLoopLagMs();
}

// 2. Блокировщик параллельных транзакций (Symbolic Mutex Lock Manager для ордеров)
function acquireExecutionLock(symbol: string): boolean {
  return systemMetricsCollector.acquireExecutionLock(symbol);
}

function releaseExecutionLock(symbol: string) {
  systemMetricsCollector.releaseExecutionLock(symbol);
}

// 2.5. Унифицированный расчет PnL и комиссии для закрытия сделки
function getUnifiedTradeClosePnl(side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) {
  return quantGetUnifiedTradeClosePnl(side, entryPrice, closePrice, amount, leverage);
}

let aiKnowledgeBase: KnowledgeRule[] = [...DEFAULT_KNOWLEDGE_BASE];

const AGENT_1_IDENTIFIER = "Agent #1";

// --- User API Keys for Live Trading ---
interface UserApiKey {
  exchange: string;
  apiKey: string;
  secret: string;
  password?: string; // For OKX, KuCoin, etc.
}
let userApiKeys: UserApiKey[] = [];
// CCXT instances for live trading
const liveExchanges: Record<string, Exchange> = {};

function initLiveExchange(creds: UserApiKey) {
  try {
    const exClass = (ccxt as any)[creds.exchange];
    if (exClass) {
      let defaultOptions = { defaultType: creds.exchange === 'weex' ? 'swap' : 'future' };
      liveExchanges[creds.exchange] = new exClass({
        apiKey: creds.apiKey,
        secret: creds.secret,
        password: creds.password,
        enableRateLimit: true,
        options: defaultOptions,
        headers: creds.exchange === 'weex' ? WEEX_HEADERS : undefined
      });
    }
  } catch (e) {
    console.log(`Failed to init live exchange ${creds.exchange}:`, e.message || e);
  }
}

export function getCcxtClientConstructionCount(): number {
  return exchangeExecutionService.getCcxtClientConstructionCount();
}

// --- EXCHANGE EXECUTION SERVICE (STEP D DECOMPOSITION) ---
const exchangeExecutionService = new ExchangeExecutionService({
  isRealTradingAllowed: () => isRealTradingAllowed(),
  getGlobalSettings: () => globalSettings,
  saveSettings: () => saveSettings(),
  autopilotFailedSymbols: new Proxy({} as Set<string>, {
    get: (_, prop) => {
      const target = (typeof autopilotFailedSymbols !== 'undefined' && autopilotFailedSymbols) || new Set<string>();
      const val = (target as any)[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  }),
  isWeexApiSupported: (sym: string) => isWeexApiSupported(sym),
  formatFuturesSymbol: (sym: string, ex?: string) => formatFuturesSymbol(sym, ex),
  enrichExchangeError: (err: any) => enrichExchangeError(err),
  onTradePermissionDenied: async (symbolToBlacklist, errMsg) => {
    if (typeof virtualTrades !== 'undefined' && Array.isArray(virtualTrades)) {
      const activeToForceClose = virtualTrades.filter(t => 
        t.status === 'OPEN' && 
        t.isReal && 
        t.symbol.toUpperCase().split('/')[0].split(':')[0].split('-')[0].trim() === symbolToBlacklist
      );
      for (const trans of activeToForceClose) {
        console.log(`[EXEC AUTO-BLACKLIST] Force-closing trade ${trans.id} (${trans.symbol}) in database because exchange reports no API permission (Error -1058).`);
        logStructured('error', 'AUTOPILOT', `Emergency force-closing trade ${trans.id} due to API Error -1058 (No permission).`, symbolToBlacklist, { tradeId: trans.id, originalMsg: errMsg });
        trans.status = 'CLOSED';
        trans.closeTime = Date.now();
        trans.closePrice = trans.entryPrice;
        trans.closeReason = 'Permission denied by exchange (Error -1058)';
        trans.notes = 'Force-closed due to exchange API permission restriction';
        if (typeof saveTradeDB === 'function') {
          await saveTradeDB(trans);
        }
      }
    }
  }
});

function getCcxtClient(config: { exchange: string, apiKey: string, apiSecret?: string, password?: string, passphrase?: string }) {
  return exchangeExecutionService.getCcxtClient(config);
}

function getRealTradeEngineDeps(): RealTradeEngineDependencies {
  return exchangeExecutionService.getRealTradeEngineDeps();
}

// --- LOCAL EXCHANGE TELEMETRY PING MONITOR ---
function getCurrentExchangePingMs(): number {
  return exchangeExecutionService.getCurrentExchangePingMs();
}

function getExchangePingHistory(): { timestamp: number, pingMs: number }[] {
  return exchangeExecutionService.getExchangePingHistory();
}

async function pingExchangeServer() {
  return exchangeExecutionService.pingExchangeServer();
}

// Start tracking connection health and response delay
if (process.env.OFFLINE_MODE !== '1' && process.env.TEST_MODE !== '1') {
  exchangeExecutionService.startPingMonitor(15000);
}

async function executeWithRetry(fn: () => Promise<any>, desc: string, retries = 3, initialDelay = 1000): Promise<any> {
  return exchangeExecutionService.executeWithRetry(fn, desc, retries, initialDelay);
}

function getAllConfiguredExchangeAccounts() {
  return exchangeExecutionService.getAllConfiguredExchangeAccounts();
}

async function executeRealOpenOnExchange(symbol: string, side: string, amount: number, leverage: number, stopLoss?: number, takeProfit?: number) {
  return exchangeExecutionService.executeRealOpenOnExchange(symbol, side, amount, leverage, stopLoss, takeProfit);
}

async function setRealTradeSlTpOnExchange(symbol: string, side: string, stopLoss?: number | null, takeProfit?: number | null): Promise<boolean> {
  return exchangeExecutionService.setRealTradeSlTpOnExchange(symbol, side, stopLoss, takeProfit);
}

async function cancelAllOrdersAndTriggers(client: any, formattedSymbol: string, force = false) {
  return exchangeExecutionService.cancelAllOrdersAndTriggers(client, formattedSymbol, force);
}

async function executeRealPartialCloseOnExchange(symbol: string, side: string, ratio: number) {
  return exchangeExecutionService.executeRealPartialCloseOnExchange(symbol, side, ratio);
}

async function executeRealCloseOnExchange(symbol: string, side: string) {
  return exchangeExecutionService.executeRealCloseOnExchange(symbol, side);
}

interface VirtualTrade {
  id: string; symbol: string; exchange: string; entryPrice: number; amount: number; leverage: number;
  side: 'LONG' | 'SHORT'; status: 'OPEN' | 'CLOSED'; openTime: number; closeTime?: number; closePrice?: number;
  pnl?: number; pnlPercent?: number; signalAiScore: number; feedback?: 'SUCCESS' | 'FAILED' | 'BREAKEVEN';
  notes?: string; history?: { time: number; type: 'OPEN' | 'AVERAGE' | 'CLOSE' | 'ADJUST_SL_TP'; price: number; amount: number; notes?: string; oldSl?: number; newSl?: number; oldTp?: number; newTp?: number; reason?: string }[];
  mode?: 'MANUAL' | 'AUTO' | 'SEMI_AUTO' | 'EXTERNAL'; aiAdvice?: string; lastAiCheck?: number; takeProfit?: number; stopLoss?: number;
  gridOrders?: { price: number; amount: number; executed: boolean }[];
  aiEvaluation?: string;
  learnedRule?: string;
  outcome?: number;
  highestPrice?: number; lowestPrice?: number; trailingStopActive?: boolean;
  closeReason?: string; currentPrice?: number; lastAiAction?: string;
  matchedRules?: string[];
  features?: string[];
  kellyFraction?: number;
  isProtected?: boolean;
  isAveraged?: boolean;
  isReal?: boolean;
  isExternal?: boolean;
  isExchangeManual?: boolean;
  isMultiTp?: boolean;
  isClosing?: boolean;
  isExchangeSlTpSynced?: boolean;
  needsSlTpSync?: boolean;
  tpStages?: { targetPrice: number; targetPercent: number; closeRatio: number; executed: boolean }[];
  initialAmount?: number;
  isAutoLearning?: boolean;
}
const virtualTrades: VirtualTrade[] = [];
const prolivPeaks: any[] = [];

// Synchronously read initial balance from persistent database before any services or timers boot
const initialDbState = dbAtomicStore.loadState<any>({});
const initialSettingsState = settingsAtomicStore.loadState<any>({});
const initialSavedBalance = (typeof initialDbState?.settings?.main?.virtualBalance === 'number' && !isNaN(initialDbState.settings.main.virtualBalance) && initialDbState.settings.main.virtualBalance >= 0)
  ? initialDbState.settings.main.virtualBalance
  : (typeof initialDbState?.settings?.virtualBalance === 'number' && !isNaN(initialDbState.settings.virtualBalance) && initialDbState.settings.virtualBalance >= 0)
    ? initialDbState.settings.virtualBalance
    : (typeof initialSettingsState?.virtualBalance === 'number' && !isNaN(initialSettingsState.virtualBalance) && initialSettingsState.virtualBalance >= 0)
      ? initialSettingsState.virtualBalance
      : 500;

const initialSavedStartOfDay = (typeof initialDbState?.settings?.main?.startOfDayBalance === 'number' && !isNaN(initialDbState.settings.main.startOfDayBalance) && initialDbState.settings.main.startOfDayBalance >= 0)
  ? initialDbState.settings.main.startOfDayBalance
  : initialSavedBalance;

const initialSavedStartOfWeek = (typeof initialDbState?.settings?.main?.startOfWeekBalance === 'number' && !isNaN(initialDbState.settings.main.startOfWeekBalance) && initialDbState.settings.main.startOfWeekBalance >= 0)
  ? initialDbState.settings.main.startOfWeekBalance
  : initialSavedBalance;

let virtualBalance = initialSavedBalance;
let startOfDayBalance = initialSavedStartOfDay;
let startOfDayRealBalance = 0;
let lastRealDrawdownCheckTime = 0;
let isCircuitBreakerActive = false;
let committeeVetoShadowStats: { wouldHaveBlockedCount: number; totalRealEntriesChecked: number; sinceTimestamp: number } = {
  wouldHaveBlockedCount: 0,
  totalRealEntriesChecked: 0,
  sinceTimestamp: Date.now()
};
let lastBtcShockTime = 0;
let lastBtcShockAlertTime = 0;
let lastDayCheck = new Date().toISOString().split('T')[0];
let lastWebSocketActivity = Date.now();
let startOfWeekBalance = initialSavedStartOfWeek;
let lastWeekCheckTime = Date.now();

// --- TRADE MANAGER SERVICE (STEP A DECOMPOSITION) ---
const tradeManagerService = new TradeManagerService({
  getVirtualTrades: () => virtualTrades,
  getGlobalSettings: () => globalSettings,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getWsTickers: () => wsTickers,
  getGlobalTrueOhlcv: () => GLOBAL_TRUE_OHLCV,
  getGlobalMarketPulse: () => GLOBAL_MARKET_PULSE,
  getAiKnowledgeBase: () => aiKnowledgeBase,
  getCcxtClient: (config: any) => getCcxtClient(config),
  executeWithRetry: (fn, desc, retries, delay) => executeWithRetry(fn, desc, retries, delay),
  saveTradeDB: (trade, immediate) => saveTradeDB(trade, immediate),
  saveBalanceDB: () => saveBalanceDB(),
  saveKnowledgeDB: (rule) => saveKnowledgeDB(rule),
  sendTelegramMessage: (text) => sendTelegramMessage(text),
  emitSignalsUpdated: () => streamEmitter.emit('signals_updated'),
  executeRealCloseOnExchange: (sym, side) => executeRealCloseOnExchange(sym, side),
  executeRealPartialCloseOnExchange: (sym, side, ratio) => executeRealPartialCloseOnExchange(sym, side, ratio),
  executeRealOpenOnExchange: (sym, side, amount, lev) => executeRealOpenOnExchange(sym, side, amount, lev),
  setRealTradeSlTpOnExchange: (sym, side, sl, tp) => setRealTradeSlTpOnExchange(sym, side, sl, tp),
  runAiGeneration: (params) => runAiGeneration(params),
  WEEX_HEADERS: WEEX_HEADERS,
  getVirtualBalance: () => virtualBalance,
  setVirtualBalance: (val: number) => { virtualBalance = val; },
  getStartOfDayBalance: () => startOfDayBalance,
  setStartOfDayBalance: (val: number) => { startOfDayBalance = val; },
  getStartOfDayRealBalance: () => startOfDayRealBalance,
  setStartOfDayRealBalance: (val: number) => { startOfDayRealBalance = val; },
  getStartOfWeekBalance: () => startOfWeekBalance,
  setStartOfWeekBalance: (val: number) => { startOfWeekBalance = val; },
  getIsCircuitBreakerActive: () => isCircuitBreakerActive,
  setIsCircuitBreakerActive: (val: boolean) => { isCircuitBreakerActive = val; }
}, {
  virtualBalance,
  startOfDayBalance,
  startOfDayRealBalance,
  startOfWeekBalance
});

async function fetchCachedRealBalance(client: any, type: string, force = false, desc = 'fetchBalance'): Promise<any> {
  return tradeManagerService.fetchCachedRealBalance(client, type, force, desc);
}

// Help function to trigger emergency Circuit Breaker
async function triggerCircuitBreaker(reason: string) {
  isCircuitBreakerActive = true;
  return tradeManagerService.triggerCircuitBreaker(reason);
}

// Check daily balance reset
function checkDailyReset() {
  tradeManagerService.checkDailyReset();
}
if (isMainThread) {
  setInterval(checkDailyReset, 60000);
}

// Optimization: Quick access to open trades
let openTradesCache: any[] = [];

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

// --- DATABASE PERSISTENCE MANAGER (STEP C DECOMPOSITION) ---
const databasePersistenceManager = new DatabasePersistenceManager({
  dbAtomicStore,
  getIsPostgresConfigured: () => isPostgresConfigured(),
  syncTradesToPg: (trades: any[]) => syncTradesToPg(trades),
  syncKnowledgeToPg: (kb: any[]) => syncKnowledgeToPg(kb),
  loadAllFromPg: () => loadAllFromPg(),
  getVirtualTrades: () => virtualTrades,
  getAiKnowledgeBase: () => aiKnowledgeBase,
  getProlivPeaks: () => prolivPeaks,
  getAgentExchangeLogs: () => agentExchangeLogs,
  getVirtualBalance: () => virtualBalance,
  setVirtualBalance: (bal: number) => { virtualBalance = bal; },
  getStartOfDayBalance: () => startOfDayBalance,
  setStartOfDayBalance: (bal: number) => { startOfDayBalance = bal; },
  getStartOfDayRealBalance: () => startOfDayRealBalance,
  setStartOfDayRealBalance: (bal: number) => { startOfDayRealBalance = bal; },
  getStartOfWeekBalance: () => startOfWeekBalance,
  setStartOfWeekBalance: (bal: number) => { startOfWeekBalance = bal; },
  getLastWeekCheckTime: () => lastWeekCheckTime,
  setLastWeekCheckTime: (time: number) => { lastWeekCheckTime = time; },
  getGlobalSettings: () => globalSettings,
  getOwnerId: () => OWNER_ID || "default_user",
  getFirebaseDb: () => db,
  isMainThread: isMainThread,
  streamEmitter: streamEmitter,
  onTradeClosedIncremental: (trade: any) => onTradeClosedIncremental(trade),
  runRetrospectiveAnalysisBackground: (trade: any) => runRetrospectiveAnalysisBackground(trade),
  sendTelegramMessage: (msg: string) => { sendTelegramMessage(msg); },
  atomicWriteJson: (filePath: string, data: any) => atomicWriteJson(filePath, data),
  settingsFilePath: SETTINGS_FILE
});

const isFirebaseFirestoreDisabled = !isMainThread;

function getDbStorageContext(): DbStorageContext {
  return databasePersistenceManager.getDbStorageContext();
}

function readLocalDB(): any {
  return databasePersistenceManager.readLocalDB();
}

async function writeLocalDB(data: any): Promise<void> {
  return databasePersistenceManager.writeLocalDB(data);
}

function getCachedDB() {
  return databasePersistenceManager.getCachedDB();
}

async function flushDB(): Promise<void> {
  return databasePersistenceManager.flushDB();
}

export async function persistStateDirectly(data: any): Promise<any> {
  return await dbAtomicStore.saveState(data);
}

async function requestDBSave(): Promise<void> {
  return databasePersistenceManager.requestDBSave();
}

function handleFirestoreError(err: any, context: string) {
  return databasePersistenceManager.handleFirestoreError(err, context);
}

async function syncToFirebase(dbData: any) {
  return databasePersistenceManager.syncToFirebase(dbData);
}

function createLocalBackup(dbData: any) {
  return databasePersistenceManager.createLocalBackup(dbData);
}

// Scheduled auto-backup every 1 hour
if (isMainThread) {
  setInterval(() => {
    databasePersistenceManager.runScheduledBackup();
  }, 60 * 60 * 1000); // 1 hour
}

function getDbStartupSyncContext(): DbStartupSyncContext {
  return databasePersistenceManager.getDbStartupSyncContext();
}

async function loadStateFromDB() {
  return databasePersistenceManager.loadStateFromDB();
}
// loadStateFromDB is loaded inside startServer() and the worker thread IIFE to avoid top-level await in CommonJS.
const startupLoadPromise = databasePersistenceManager.getStartupLoadPromise();

async function saveTradeDB(trade: any, immediate: boolean = false) {
  return databasePersistenceManager.saveTradeDB(trade, immediate);
}

async function saveKnowledgeDB(rule: any, immediate: boolean = false) {
  return databasePersistenceManager.saveKnowledgeDB(rule, immediate);
}

function getQuantRiskEngineContext(): QuantRiskEngineContext {
  return {
    getGlobalTrueOHLCV: () => GLOBAL_TRUE_OHLCV,
    getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
    getWsTickers: () => wsTickers,
    getOrderBookImbalance: () => orderBookImbalance,
    getModelWeights: () => modelWeights,
    getAiKnowledgeBase: () => aiKnowledgeBase,
    getMarketPulse: () => GLOBAL_MARKET_PULSE,
    setMarketPulse: (pulse) => { GLOBAL_MARKET_PULSE = pulse; },
    getSocialSentimentCache: () => GLOBAL_SOCIAL_SENTIMENT,
    getSignalsCache: () => CACHE.signals,
    getGlobalLiquidations: () => GLOBAL_LIQUIDATIONS,
    runAiGeneration: (params) => runAiGeneration(params),
    getMarketPulsePrompt: (context, shortsSq, longsSq) => getMarketPulsePrompt(context, shortsSq, longsSq),
    getSocialScraperPrompt: (sym, change, vol) => getSocialScraperPrompt(sym, change, vol),
    safeJsonParse: (json, fallback) => safeJsonParse(json, fallback)
  };
}

function matchesStructuredFilter(
  rule: any, 
  trueRsi: number, 
  volumeSpike: number, 
  marketBias: number,
  volatility?: number,
  obImbalance?: number,
  fomoIndex?: number,
  change24h?: number
): { matched: boolean; isPenalty: boolean; isBlock: boolean; isBonus: boolean; reason: string } {
  return serviceMatchesStructuredFilter(
    rule,
    trueRsi,
    volumeSpike,
    marketBias,
    volatility,
    obImbalance,
    fomoIndex,
    change24h
  );
}

let GLOBAL_MARKET_PULSE = {
  sentiment: 'NEUTRAL',
  bias: 0,
  recommendation: 'Standby',
  lastUpdated: 0
};

async function updateMarketPulse() {
  return serviceExecuteUpdateMarketPulse(getQuantRiskEngineContext());
}

if (isMainThread) {
  // Update pulse every 30m
  setInterval(updateMarketPulse, 30 * 60 * 1000);
  setTimeout(updateMarketPulse, 15000); // Delayed start
}

function calculateConfidenceProbability(symbol: string, currentPrice: number, volume: number): { p: number, features: number[] } {
  return serviceCalculateConfidenceProbability(symbol, currentPrice, volume, getQuantRiskEngineContext());
}

function calculateKelly(aiScore: number, rewardToRisk: number = 2.0): number {
  return quantCalculateKelly(aiScore, rewardToRisk);
}

/**
 * Dynamic Scaling Close
 * Adapts closeRatio percentages based on orderbook imbalance and volatility.
 * Default is: [0.50, 0.25, 0.15, 0.10].
 * If volatility is high, we close more at TP1 (e.g., 0.60) to secure profits quickly.
 * If orderbook imbalance against us is high (buyer pressure), we also take profit faster at early stages.
 */
function calculateAdaptiveCloseRatios(obImbalance?: number, volatility?: number): number[] {
  return quantCalculateAdaptiveCloseRatios(obImbalance, volatility);
}

// Global Sentiment Cache to protect against API rate-limiting and keep things ultra fast
const GLOBAL_SOCIAL_SENTIMENT: Record<string, { score: number, mentions: number, lastScraped: number, trend: 'PUMP_HYPE' | 'NEUTRAL' | 'FADING', sources: string[] }> = {};

/**
 * Sentiment Twitter/Telegram AI-Scraper
 * Analyzes market metrics and triggers cognitive assessment of social hypes/mentions.
 */
async function scrapeSocialSentiment(symbol: string): Promise<{ score: number, mentions: number, lastScraped: number, trend: 'PUMP_HYPE' | 'NEUTRAL' | 'FADING', sources: string[] }> {
  return serviceExecuteScrapeSocialSentiment(symbol, getQuantRiskEngineContext());
}

const settingsManager = new SettingsManager({
  getCachedDB: () => getCachedDB(),
  flushDB: () => flushDB(),
  syncToFirebase: (dbData) => syncToFirebase(dbData),
  isFirebaseFirestoreDisabled,
  getDbInstance: () => db,
  getModelStatus: () => modelStatus,
  getModelWeights: () => modelWeights,
  setModelWeights: (weights) => { modelWeights = weights as any; },
  isMainThread
});

const globalSettings = settingsManager.getSettings();
const autopilotFailedSymbols = settingsManager.getAutopilotFailedSymbols();

function setExpertInstructions(newInstructions: string, author: 'USER' | 'RETROSPECTIVE' | 'AI_CHAT', reason?: string) {
  return settingsManager.setExpertInstructions(newInstructions, author, reason);
}

function sanitizeExpertInstructions(input: string): string {
  return quantSanitizeExpertInstructions(input);
}

async function saveSettings(): Promise<void> {
  return settingsManager.saveSettings();
}

// Retrospective and Incremental Learning Engine
const retrospectiveEngine = createRetrospectiveEngine({
  getCachedDB,
  flushDB,
  syncToFirebase,
  isFirebaseFirestoreDisabled,
  getDb: () => db,
  getModelWeights: () => modelWeights,
  setModelWeights: (weights: Record<string, number>) => {
    modelWeights = weights as any;
  },
  getModelStatus: () => modelStatus,
  saveSettings,
  getVirtualTrades: () => virtualTrades,
  getKnowledgeBase: () => aiKnowledgeBase,
  saveKnowledgeDB,
  runAiGeneration,
  safeJsonParse,
  cleanSymbol,
  runNewAIPerformanceOptimizationCircuit,
  streamEmitter,
  isMainThread
});

// Stochastic Online (Incremental) Learning on Trade Closure
async function onTradeClosedIncremental(trade: any) {
  return retrospectiveEngine.onTradeClosedIncremental(trade);
}

async function runRetrospectiveAnalysisBackground(trade: any) {
  return retrospectiveEngine.runRetrospectiveAnalysisBackground(trade);
}

function getQuantModelTrainerContext(): QuantModelTrainerContext {
  return {
    getModelStatus: () => modelStatus,
    getModelWeights: () => modelWeights,
    setModelWeights: (weights) => {
      modelWeights = weights;
    },
    getVirtualTrades: () => virtualTrades,
    getAiKnowledgeBase: () => aiKnowledgeBase,
    saveKnowledgeDB: (rule) => saveKnowledgeDB(rule),
    saveSettings: () => saveSettings(),
    deadZonePct: DEAD_ZONE_PCT
  };
}

async function retrainModel() {
  return serviceTrainQuantModel(getQuantModelTrainerContext());
}

if (isMainThread) {
  // Retraining check every 1h
  setInterval(() => {
    const closedTrades = virtualTrades.filter(t => t.status === 'CLOSED' && (t as any).outcome !== undefined);
    const tradesSinceLast = closedTrades.length - (modelStatus.totalLearnedTrades || 0);
    const timeSinceLast = Date.now() - (modelStatus.lastRetrained || 0);

    if (tradesSinceLast >= 30 || (timeSinceLast >= 86400000 && closedTrades.length >= 30)) {
       retrainModel();
    }
  }, 60 * 60 * 1000);
}

async function deleteKnowledgeDB(id: string) {
  return serviceDeleteKnowledgeFromDB(id, getDbStorageContext());
}

async function saveBalanceDB() {
  return serviceSaveBalanceToDB(getDbStorageContext());
}

async function sendTelegramMessage(text: string, photoUrl?: string) {
  return serviceSendTelegramMessage(text, photoUrl, {
    getBots: () => globalSettings.telegramBots || [],
    getDiscordWebhooks: () => globalSettings.discordWebhooks || []
  });
}

function sendFormattedTelegramSignal(params: Parameters<typeof serviceSendFormattedTelegramSignal>[0]) {
  serviceSendFormattedTelegramSignal(params, (text) => sendTelegramMessage(text));
}

function startFuturesLiquidationWS(retryCount = 0) {
  exchangeWsManager.startFuturesLiquidationWS(retryCount);
}

if (isMainThread) {
  setInterval(() => {
    const now = Date.now();
    for (const sym in GLOBAL_LIQUIDATIONS) {
      if (now - GLOBAL_LIQUIDATIONS[sym].lastT > 15 * 60 * 1000) delete GLOBAL_LIQUIDATIONS[sym];
      else { GLOBAL_LIQUIDATIONS[sym].shortsSq *= 0.5; GLOBAL_LIQUIDATIONS[sym].longsSq *= 0.5; }
    }
    for (const sym in GLOBAL_WHALES) if (now - GLOBAL_WHALES[sym].time > 5 * 60 * 1000) delete GLOBAL_WHALES[sym];
    const toDelete = Array.from(GLOBAL_PUMPS).filter((str) => {
      const ts = parseInt(str.split('-')[1]);
      return !ts || now - ts > 5 * 60 * 1000;
    });
    toDelete.forEach((x) => GLOBAL_PUMPS.delete(x));
  }, 60000);
}

let currentFilename = '';
try {
  currentFilename = fileURLToPath(import.meta.url);
} catch (e) {
  currentFilename = __filename || '';
}

let mainThreadScannerStarted = false;

function startMainThreadScannerFallback() {
  if (!mainThreadScannerStarted) {
    mainThreadScannerStarted = true;
    startFuturesLiquidationWS();
    startBinanceScannerWS();

    setInterval(updateGlobalTickers, 12000);
    updateGlobalTickers().then(() => {
      setTimeout(() => {
        updateTrueOHLCV().catch(e => console.error('[STARTUP OHLCV ERROR]', e));
      }, 4000);
      updateSignalsCache().catch(e => console.error('[STARTUP SIGNALS ERROR]', e));
    }).catch(e => console.error('[STARTUP TICKERS ERROR]', e));

    setInterval(updateTrueOHLCV, 2 * 60 * 1000);

    setTimeout(checkOrderBooks, 10000);
    setInterval(checkOrderBooks, 15000);

    setInterval(updateSignalsCache, 10000);
  }
}

const scannerWorkerManagerContext: ScannerWorkerManagerContext = {
  isMainThread,
  getGlobalSettings: () => globalSettings,
  getVirtualTrades: () => virtualTrades,
  getAiKnowledgeBase: () => aiKnowledgeBase,
  getGlobalTrueOhlcv: () => GLOBAL_TRUE_OHLCV,
  getOrderBookImbalance: () => orderBookImbalance,
  getGlobalOrderBookHistory: () => GLOBAL_ORDER_BOOK_HISTORY,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getGlobalWhales: () => GLOBAL_WHALES,
  getGlobalPumps: () => GLOBAL_PUMPS,
  getGlobalCvd: () => GLOBAL_CVD,
  getGlobalAtr: () => GLOBAL_ATR,
  getCacheSignals: () => CACHE.signals,
  setCacheSignals: (sig) => { CACHE.signals = sig; },
  getGlobalAiCommitteeCache: () => GLOBAL_AI_COMMITTEE_CACHE,
  emitSignalsUpdated: () => streamEmitter.emit('signals_updated'),
  runAiGeneration: (params: any) => runAiGeneration(params),
  startMainThreadScannerFallback
};

const scannerWorkerManager = new ScannerWorkerManager(scannerWorkerManagerContext, currentFilename);

function startScannerWorker() {
  scannerWorkerManager.startScannerWorker();
}

if (isMainThread) {
  // Start the Worker Thread to run WebSockets & indicator/depth calculations!
  startScannerWorker();
} else {
  // We are the Worker Thread!
  (async () => {
    try {
      console.log('[WORKER] Awaiting database state load...');
      await startupLoadPromise;
      console.log('[WORKER] Database state successfully loaded. Initializing background collectors...');
    } catch (e) {
      console.error('[WORKER] Failed to load state from DB:', e);
    }

    // Boot up all background WS and background intervals
    startFuturesLiquidationWS();
    startBinanceScannerWS();
    
    setInterval(updateGlobalTickers, 12000);
    updateGlobalTickers();
    
    setTimeout(updateTrueOHLCV, 10000);
    setInterval(updateTrueOHLCV, 2 * 60 * 1000);
    
    setTimeout(checkOrderBooks, 15000);
    setInterval(checkOrderBooks, 15000);
    
    // ПЕРИОДИЧЕСКИЙ ПЕРЕСЧЕТ СИГНАЛОВ ПО ЧЕКЛИСТУ AGENTS.md:
    setInterval(updateSignalsCache, 10000);
    
    // Listen for settings and main state updates from main thread:
    parentPort?.on('message', (msg) => {
      if (msg.type === 'UPDATE_SETTINGS') {
        const syncRes = processIncomingStateMessage(globalSettings as any, {
          type: 'STATE_UPDATE',
          entity: 'settings',
          revision: msg.payload?.stateRevision || (getAtomicStoreRevision() + 1),
          emittedAt: Date.now(),
          sender: 'MAIN_THREAD',
          payload: msg.payload
        });
        if (syncRes.accepted && syncRes.updatedState) {
          Object.assign(globalSettings, syncRes.updatedState);
        } else {
          console.warn(`[STATE_SYNC CONFLICT] Rejected stale/conflicted settings update in worker thread. Local rev: ${(globalSettings as any).stateRevision || 0}, Msg rev: ${msg.payload?.stateRevision || 'N/A'}. Reason: ${syncRes.reason}`);
        }
      } else if (msg.type === 'UPDATE_MAIN_STATE') {
        const p = msg.payload;
        if (p.virtualTrades) {
          virtualTrades.length = 0;
          p.virtualTrades.forEach((t: any) => virtualTrades.push(t));
        }
        if (p.aiKnowledgeBase) {
          aiKnowledgeBase.length = 0;
          p.aiKnowledgeBase.forEach((r: any) => aiKnowledgeBase.push(r));
        }
      } else if (msg.type === 'AI_GENERATION_RESPONSE') {
        const { id, result, error } = msg.payload;
        const task = pendingWorkerAiTasks.get(id);
        if (task) {
          pendingWorkerAiTasks.delete(id);
          if (error) {
            task.reject(new Error(error));
          } else {
            task.resolve(result);
          }
        }
      }
    });
    
    // Periodically send all worker indicators state back to main thread
    parentPort?.on('message', (msg) => {}); // legacy keepalive
    setInterval(() => {
      parentPort?.postMessage({
        type: 'SYNC_STATE',
        payload: {
          GLOBAL_TRUE_OHLCV,
          orderBookImbalance,
          GLOBAL_ORDER_BOOK_HISTORY,
          GLOBAL_CCXT_TICKERS,
          GLOBAL_WHALES,
          GLOBAL_PUMPS: [...GLOBAL_PUMPS],
          GLOBAL_CVD,
          GLOBAL_ATR,
          CACHE_SIGNALS: CACHE.signals,
          GLOBAL_AI_COMMITTEE_CACHE
        }
      });
    }, 4000);
  })();
}

// --- AUTOPILOT ENGINE SERVICE (STEP B DECOMPOSITION) ---
const autopilotEngineService = new AutopilotEngineService({
  getGlobalSettings: () => globalSettings,
  getCacheSignals: () => CACHE.signals,
  getVirtualTrades: () => virtualTrades,
  pushVirtualTrade: (trade: any) => {
    if (trade && trade.id) {
      if (!virtualTrades.some(t => t.id === trade.id)) {
        virtualTrades.push(trade);
      }
    } else {
      virtualTrades.push(trade);
    }
  },
  getVirtualBalance: () => virtualBalance,
  setVirtualBalance: (val: number) => { virtualBalance = val; },
  getStartOfDayBalance: () => startOfDayBalance,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getGlobalTrueOhlcv: () => GLOBAL_TRUE_OHLCV,
  getGlobalAdx: () => GLOBAL_ADX,
  getGlobalAtr: () => GLOBAL_ATR,
  getGlobalOrderBookHistory: () => GLOBAL_ORDER_BOOK_HISTORY,
  getOrderBookImbalance: () => orderBookImbalance,
  getGlobalMarketPulse: () => GLOBAL_MARKET_PULSE,
  getProlivPeaks: () => prolivPeaks,
  getAutopilotFailedSymbols: () => autopilotFailedSymbols,
  getAiKnowledgeBase: () => aiKnowledgeBase,
  readLocalDB: () => readLocalDB(),
  isCircuitBreakerActive: () => isCircuitBreakerActive,
  acquireExecutionLock: (symbol: string) => acquireExecutionLock(symbol),
  isWeexApiSupported: (symbol: string) => isWeexApiSupported(symbol),
  getCcxtClient: (config: any) => getCcxtClient(config),
  fetchCachedRealBalance: (client: any, type: string, force: boolean, context: string) => fetchCachedRealBalance(client, type, force, context),
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number) => executeRealOpenOnExchange(symbol, side, amount, leverage),
  executeRealCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT') => executeRealCloseOnExchange(symbol, side),
  executeRealPartialCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT', ratio: number) => executeRealPartialCloseOnExchange(symbol, side, ratio),
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => setRealTradeSlTpOnExchange(symbol, side, stopLoss, takeProfit),
  saveTradeDB: (trade: any, immediate?: boolean) => saveTradeDB(trade, immediate),
  saveBalanceDB: () => saveBalanceDB(),
  saveSettings: () => saveSettings(),
  sendTelegramMessage: (text: string) => sendTelegramMessage(text),
  emitSignalsUpdated: () => streamEmitter.emit('signals_updated'),
  runAiGeneration: (params: any) => runAiGeneration(params),
  getAtomicStoreRevision: () => getAtomicStoreRevision(),
  getWallAdjustedTp: (symbol: string, isSell: boolean, entry: number, target: number) => getWallAdjustedTp(symbol, isSell, entry, target)
});

async function runAutopilotAndVirtualTradeEntry() {
  await autopilotEngineService.runAutopilotAndVirtualTradeEntry();
}

// Watchdog and History (Delegated to TradeManagerService)
async function manageTradesServerSide() {
  await tradeManagerService.manageTradesServerSide();
}

async function runAiExpertTraderLoop() {
  await autopilotEngineService.runAiExpertTraderLoop();
}

const backgroundSchedulerCtx: BackgroundSchedulerContext = {
  isMainThread,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getFundingRates: () => fundingRates,
  getHistoryData: () => historyData,
  getGlobalFundingHistory: () => GLOBAL_FUNDING_HISTORY,
  manageTradesServerSide: () => manageTradesServerSide(),
  runAiExpertTraderLoop: () => runAiExpertTraderLoop(),
  runAutopilotAndVirtualTradeEntry: () => runAutopilotAndVirtualTradeEntry()
};

const backgroundSchedulerService = new BackgroundSchedulerService(backgroundSchedulerCtx);
// backgroundSchedulerService.start() is explicitly triggered in startServer() after startupLoadPromise finishes to prevent early race conditions.

function recordHistory(now?: number) {
  backgroundSchedulerService.recordHistory(now);
}

const marketDataCollectorCtx: MarketDataCollectorContext = {
  getGlobalTrueOHLCV: () => GLOBAL_TRUE_OHLCV,
  getGlobalRawOHLCV: () => GLOBAL_RAW_OHLCV,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getGlobalATR: () => GLOBAL_ATR,
  getGlobalADX: () => GLOBAL_ADX,
  getGlobalDerivatives: () => GLOBAL_DERIVATIVES,
  getFundingRates: () => fundingRates,
  getOpenInterests: () => openInterests,
  getOrderBookImbalance: () => orderBookImbalance,
  getGlobalOrderBookHistory: () => GLOBAL_ORDER_BOOK_HISTORY,
  getCacheSignals: () => CACHE.signals,
  getVirtualTrades: () => virtualTrades,
  getCcxtExchange: (name: string) => marketDataHubService.getExchangeInstance(name),
  isBinanceGeoblocked: () => marketDataHubService.getIsBinanceGeoblocked(),
  setBinanceGeoblocked: (val: boolean) => { marketDataHubService.setIsBinanceGeoblocked(val); },
  isMainThread: () => isMainThread
};

const marketDataCollectorService = new MarketDataCollectorService(marketDataCollectorCtx);
marketDataCollectorService.startBackgroundSchedules();

async function updateTrueOHLCV() {
  return marketDataCollectorService.updateTrueOHLCV();
}

async function updateDerivativesData() {
  return marketDataCollectorService.updateDerivativesData();
}

async function checkOrderBooks() {
  return marketDataCollectorService.checkOrderBooks();
}

function recalculateIndicatorsForSymbol(cleanSym: string) {
  return marketDataCollectorService.recalculateIndicatorsForSymbol(cleanSym);
}

function updateLocalCandlesForSymbol(cleanSym: string, finalPrice: number, volumeDelta: number) {
  return marketDataCollectorService.updateLocalCandlesForSymbol(cleanSym, finalPrice, volumeDelta);
}

function getWallAdjustedTp(symbol: string, isSell: boolean, currentPrice: number, targetTpPrice: number): number {
  return marketDataCollectorService.getWallAdjustedTp(symbol, isSell, currentPrice, targetTpPrice);
}

function startBinanceScannerWS(retryCount = 0) {
  exchangeWsManager.startBinanceScannerWS(retryCount);
}
// startBinanceScannerWS();
if (!isMainThread) {
  startBinanceScannerWS();
}



function getMarketSignalScannerContext(): MarketSignalScannerContext {
  return {
    getGlobalTrueOHLCV: () => GLOBAL_TRUE_OHLCV,
    getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
    getGlobalSettings: () => globalSettings,
    isBinanceCrossListed: (sym: string) => isBinanceCrossListed(sym),
    setCachedSignals: (cacheObj) => {
      CACHE.signals = cacheObj;
    },
    emitSignalsUpdated: () => streamEmitter.emit('signals_updated'),
    runAutopilotAndVirtualTradeEntry: async () => {
      await runAutopilotAndVirtualTradeEntry();
    },
    isMainThread: isMainThread
  };
}

async function updateSignalsCache() {
  await executeUpdateSignalsCache(getMarketSignalScannerContext());
}

function runDeterministicQuantCommitteeFallback(data: any[]) {
  return serviceRunDeterministicQuantCommitteeFallback(data);
}

function generateProgrammaticCommitteeFallback(resItem: any) {
  return serviceGenerateProgrammaticCommitteeFallback(resItem);
}

// --- TELEGRAM BOT SERVICE & POLLING LOOP ---
const telegramBotService = createTelegramBotService({
  getGlobalSettings: () => globalSettings,
  saveSettings: () => saveSettings(),
  getVirtualTrades: () => virtualTrades,
  getVirtualBalance: () => virtualBalance,
  getStartOfDayBalance: () => startOfDayBalance,
  getAiKnowledgeBaseCount: () => aiKnowledgeBase.length,
  getCcxtClient: (config: any) => getCcxtClient(config),
  fetchCachedRealBalance: (client: any, defaultType: string, force: boolean, context: string) => fetchCachedRealBalance(client, defaultType, force, context),
  WEEX_HEADERS: WEEX_HEADERS,
  isMainThread: isMainThread
});

if (isMainThread) {
  telegramBotService.startPollingLoop(5000);
}

const realTradeContext: RealTradeRouterContext = {
  getGlobalSettings: () => globalSettings,
  getVirtualTrades: () => virtualTrades,
  saveTradeDB: (trade: any) => saveTradeDB(trade),
  sendTelegramMessage: (msg: string) => sendTelegramMessage(msg),
  sendTelegramTestMessage: (botToken: string, chatId: string) => sendTelegramTestMessage(botToken, chatId),
  enrichExchangeError: (error: any) => enrichExchangeError(error),
  getCcxtClient: (config: any) => getCcxtClient(config),
  getUnifiedTradeClosePnl: (side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) => getUnifiedTradeClosePnl(side, entryPrice, closePrice, amount, leverage),
  findTickerInMap: (sym: string, map: any) => findTickerInMap(sym, map),
  getWsTickers: () => wsTickers,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  WEEX_HEADERS: WEEX_HEADERS,
  getTradeSyncAttempts: () => tradeSyncAttempts,
  getRealPositionsCache: () => realPositionsCache,
  setRealPositionsCache: (cache: { data: any[]; lastUpdated: number }) => { realPositionsCache = cache; },
  isRealTradingAllowed: () => isRealTradingAllowed(),
  executeRealOpenOnExchange: (symbol: string, side: string, amount: number, leverage: number, stopLoss?: number, takeProfit?: number) => executeRealOpenOnExchange(symbol, side, amount, leverage, stopLoss, takeProfit),
  executeWithRetry: <T>(fn: () => Promise<T>, opName?: string, retries?: number, delay?: number) => executeWithRetry(fn, opName, retries, delay),
  formatFuturesSymbol: (symbol: string, exchange?: string) => formatFuturesSymbol(symbol, exchange)
};

const log400 = (path: string, error: string) => {
  console.warn(`[HTTP 400] ${path}: ${error}`);
};

const marketContext: MarketRouterContext = {
  getSignalsCache: () => CACHE.signals,
  getMarketPulse: () => GLOBAL_MARKET_PULSE,
  getSocialSentiment: () => GLOBAL_SOCIAL_SENTIMENT,
  getIsCircuitBreakerActive: () => isCircuitBreakerActive,
  getLastBtcShockTime: () => lastBtcShockTime,
  getFundingRates: () => fundingRates,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getWsTickers: () => wsTickers,
  getCcxtExchanges: () => ccxtExchanges,
  getOhlcvCache: () => ohlcvCache,
  getGlobalSettings: () => globalSettings,
  getIsBinanceGeoblocked: () => marketDataHubService.getIsBinanceGeoblocked(),
  setIsBinanceGeoblocked: (val: boolean) => { marketDataHubService.setIsBinanceGeoblocked(val); },
  getRestBlockedExchanges: () => marketDataHubService.getRestBlockedExchanges(),
  log400: (path: string, error: string) => log400(path, error)
};

const streamContext: StreamRouterContext = {
  getSignalsCache: () => CACHE.signals,
  getMarketPulse: () => GLOBAL_MARKET_PULSE,
  getSocialSentiment: () => GLOBAL_SOCIAL_SENTIMENT,
  getVirtualTrades: () => virtualTrades,
  getVirtualBalance: () => virtualBalance,
  getProlivPeaks: () => prolivPeaks,
  getAgentExchangeLogs: () => agentExchangeLogs,
  getCachedDB: () => getCachedDB(),
  getWsTickers: () => wsTickers,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  findTickerInMap: (sym: string, map: any) => findTickerInMap(sym, map),
  streamEmitter: streamEmitter,
  getFundingRates: () => fundingRates,
  isFetchingGlobalTickers: () => isFetchingGlobalTickers,
  updateGlobalTickers: () => updateGlobalTickers(),
  historyData: historyData,
  globalTrueOhlcv: GLOBAL_TRUE_OHLCV,
  serverStartTime: (globalThis as any).SERVER_START_TIME,
  getStartOfDayBalance: () => startOfDayBalance,
  getStartOfDayRealBalance: () => startOfDayRealBalance,
  getStartOfWeekBalance: () => startOfWeekBalance
};

// [DEPRECATED IN SERVER.TS -> EXTRACTED TO aiOptimizationWorker.ts]
// Autonomous background task for self-cleaning and rebalancing of the knowledge base
// SMART ARCHIVIST AGENT & RETROSPECTIVE CIRCUITS EXTRACTED TO aiOptimizationWorker.ts

// ==========================================
// 🧑‍💼 AI OPTIMIZATION & SMART ARCHIVIST WORKER
// ==========================================
const aiOptimizationWorker = createAiOptimizationWorker({
  getCachedDB: () => getCachedDB(),
  flushDB: () => flushDB(),
  syncToFirebase: async (data: any) => { if (db && !isFirebaseFirestoreDisabled) await syncToFirebase(data); },
  isFirebaseFirestoreDisabled: isFirebaseFirestoreDisabled,
  getDb: () => db,
  getKnowledgeBase: () => aiKnowledgeBase,
  saveKnowledgeDB: (rule: any) => saveKnowledgeDB(rule),
  deleteKnowledgeDB: (id: string) => deleteKnowledgeDB(id),
  getVirtualTrades: () => virtualTrades,
  getGlobalSettings: () => globalSettings,
  setExpertInstructions: (inst: string, source: string, reason?: string) => setExpertInstructions(inst, source as any, reason),
  getMarketRegime: () => CACHE.signals?.marketRegime || 'FLAT',
  getMarketHealth: () => CACHE.signals?.marketHealth || 50,
  runAiGeneration: (params: any) => runAiGeneration(params),
  safeJsonParse: (json: string, fallback: any) => safeJsonParse(json, fallback),
  getSmartArchivistPrompt: (...args: any[]) => (getSmartArchivistPrompt as any)(...args),
  getArchivistPrompt: (...args: any[]) => (getArchivistPrompt as any)(...args),
  getRetrospectivePrompt: (...args: any[]) => (getRetrospectivePrompt as any)(...args),
  logAgentExchange: (from: any, to: any, msg: string, details?: string, type?: any) => logAgentExchange(from, to, msg, details, type),
  sendTelegramMessage: (msg: string) => sendTelegramMessage(msg),
  streamEmitter: streamEmitter,
  updatePatternBlacklistFromStats: (trades: any[]) => updatePatternBlacklistFromStats(trades),
  isMainThread: isMainThread
});

function runNewAIPerformanceOptimizationCircuit(manual = false): Promise<any> {
  return aiOptimizationWorker.runNewAIPerformanceOptimizationCircuit(manual);
}

aiOptimizationWorker.startBackgroundSchedules();

let cachedMarketNews: { text: string; timestamp: number } | null = null;

const aiContext: AiRoutesContext = {
  getGlobalSettings: () => globalSettings,
  getVirtualTrades: () => virtualTrades,
  getKnowledgeBase: () => aiKnowledgeBase,
  getSocialSentiment: () => GLOBAL_SOCIAL_SENTIMENT,
  getSignalsCache: () => CACHE.signals,
  runAiGeneration: (params: any) => aiGatewayService.runAiGeneration(params),
  getSentinelShieldPrompt: (btc24: string, btc15: string, regime: string, health: number, fundingLimit: number, maxVol: number, sentiment: string) => getSentinelShieldPrompt(btc24, btc15, regime, health, fundingLimit, maxVol, sentiment),
  getCommitteePrompt: (rules: string, dataStr: string) => getCommitteePrompt(rules, dataStr),
  getPositionManagerPrompt: (...args: any[]) => (getPositionManagerPrompt as any)(...args),
  getSignalAnalysisPrompt: (signalJson: string, rules: string) => getSignalAnalysisPrompt(signalJson, rules),
  getTradeEvaluationPrompt: (...args: any[]) => (getTradeEvaluationPrompt as any)(...args),
  getRuleTesterPrompt: (rule: string, symbol: string, side: string, entryPrice: number) => getRuleTesterPrompt(rule, symbol, side, entryPrice),
  safeJsonParse: (json: string, fallback: any) => safeJsonParse(json, fallback),
  runDeterministicQuantCommitteeFallback: (data: any[]) => runDeterministicQuantCommitteeFallback(data),
  getBlacklistedPatterns: () => getBlacklistedPatterns(),
  evaluateExitPolicy: (tradeSnapshot: any, marketSnapshot: any) => evaluateExitPolicy(tradeSnapshot, marketSnapshot),
  executePaperTradeCloseTransaction: async (dbStore: any, params: any) => await executePaperTradeCloseTransaction(dbStore, params),
  dbAtomicStore: dbAtomicStore,
  saveTradeDB: async (trade: any, isUpdate?: boolean) => await saveTradeDB(trade, isUpdate),
  saveBalanceDB: async () => await saveBalanceDB(),
  sendTelegramMessage: (msg: string) => sendTelegramMessage(msg),
  setRealTradeSlTpOnExchange: (symbol: string, side: string, stopLoss?: number, takeProfit?: number) => setRealTradeSlTpOnExchange(symbol, side, stopLoss, takeProfit),
  logStructured: (...args: any[]) => (logStructured as any)(...args),
  streamEmitter: streamEmitter,
  getVirtualBalance: () => virtualBalance,
  setVirtualBalance: (val: number) => { virtualBalance = val; },
  DEFAULT_BASELINE_EXPERT_INSTRUCTIONS: DEFAULT_BASELINE_EXPERT_INSTRUCTIONS,
  getPendingAiTasks: () => aiGatewayService.getPendingAiTasks(),
  getCachedMarketNews: () => aiGatewayService.getCachedMarketNews(),
  setCachedMarketNews: (news: { text: string; timestamp: number } | null) => { aiGatewayService.setCachedMarketNews(news); },
  getOhlcvCache: () => ohlcvCache,
  getPendingChartRequests: () => pendingChartRequests,
  getCcxtExchanges: () => ccxtExchanges,
  getRestBlockedExchanges: () => restBlockedExchanges,
  formatFuturesSymbol: (sym: string, ex: string) => formatFuturesSymbol(sym, ex),
  getGlobalRawOHLCV: () => GLOBAL_RAW_OHLCV,
  getGlobalTrueOHLCV: () => GLOBAL_TRUE_OHLCV
};

const paperTradeContext = {
  getVirtualTrades: () => virtualTrades,
  getVirtualBalance: () => virtualBalance,
  setVirtualBalance: (bal: number) => { virtualBalance = bal; },
  getStartOfDayBalance: () => startOfDayBalance,
  setStartOfDayBalance: (bal: number) => { startOfDayBalance = bal; },
  getStartOfDayRealBalance: () => startOfDayRealBalance,
  setStartOfDayRealBalance: (bal: number) => { startOfDayRealBalance = bal; },
  getStartOfWeekBalance: () => startOfWeekBalance,
  setStartOfWeekBalance: (bal: number) => { startOfWeekBalance = bal; },
  getIsCircuitBreakerActive: () => isCircuitBreakerActive,
  setIsCircuitBreakerActive: (active: boolean) => { isCircuitBreakerActive = active; },
  getLastBtcShockTime: () => lastBtcShockTime,
  getGlobalSettings: () => globalSettings,
  getWsTickers: () => wsTickers,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getSignalsData: () => CACHE.signals?.data || [],
  getModelWeights: () => modelWeights,
  getAtomicStoreRevision: () => getAtomicStoreRevision(),
  saveTradeDB: (trade: any) => saveTradeDB(trade),
  saveBalanceDB: () => saveBalanceDB(),
  normalizeSymbol: (sym: string) => normalizeSymbol(sym),
  findTickerInMap: (sym: string, tickersMap: any) => findTickerInMap(sym, tickersMap),
  validatePaperTradeInput: (input: any) => validatePaperTradeInput(input),
  acquireExecutionLock: (sym: string) => acquireExecutionLock(sym),
  releaseExecutionLock: (sym: string) => releaseExecutionLock(sym),
  executeRealOpenOnExchange: (symbol: string, side: string, amount: number, leverage: number, stopLoss?: number, takeProfit?: number) => executeRealOpenOnExchange(symbol, side, amount, leverage, stopLoss, takeProfit),
  getUnifiedTradeClosePnl: (side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) => getUnifiedTradeClosePnl(side, entryPrice, closePrice, amount, leverage),
  getExchangeLink: (exchange: string, symbol: string) => getExchangeLink(exchange, symbol),
  getTradingAdvice: (side: string, mode: string) => getTradingAdvice(side, mode),
  getChartImageHtml: (symbol: string) => getChartImageHtml(symbol),
  sendTelegramMessage: (msg: string) => sendTelegramMessage(msg),
  streamEmitter: streamEmitter,
  log400: (route: string, msg: string) => log400(route, msg)
};

const knowledgeContext: KnowledgeRouterContext = {
  getKnowledgeBase: () => aiKnowledgeBase,
  setKnowledgeBase: (kb: any[]) => { aiKnowledgeBase = kb; },
  saveKnowledgeDB: (rule: any) => saveKnowledgeDB(rule),
  deleteKnowledgeDB: (id: string) => deleteKnowledgeDB(id),
  getModelWeights: () => modelWeights,
  getModelStatus: () => modelStatus,
  runAiGeneration: (params: any) => runAiGeneration(params),
  getArchivistPrompt: (rules: string, minSim: number, maxClusters: number) => getArchivistPrompt(rules, minSim, maxClusters),
  getRuleTesterPrompt: (rule: string, symbol: string, side: string, entryPrice: number) => getRuleTesterPrompt(rule, symbol, side, entryPrice),
  safeJsonParse: (json: string, fallback: any) => safeJsonParse(json, fallback),
  getJaccardSimilarity: (str1: string, str2: string) => getJaccardSimilarity(str1, str2),
  runSmartArchivistCycle: (manual: boolean) => aiOptimizationWorker.runSmartArchivistCycle(manual),
  runNewAIPerformanceOptimizationCircuit: (manual: boolean) => aiOptimizationWorker.runNewAIPerformanceOptimizationCircuit(manual),
  getAgentExchangeLogs: () => agentExchangeLogs,
  getCachedDB: () => getCachedDB(),
  requestDBSave: () => requestDBSave(),
  flushDB: () => flushDB(),
  syncToFirebase: async (dbData: any) => { if (db && !isFirebaseFirestoreDisabled) await syncToFirebase(dbData); },
  getDb: () => db,
  isFirebaseFirestoreDisabled: isFirebaseFirestoreDisabled,
  OWNER_ID: OWNER_ID,
  streamEmitter: streamEmitter,
  getVirtualTrades: () => virtualTrades,
  getCommitteeVetoShadowStats: () => committeeVetoShadowStats,
  getMarketRegime: () => CACHE.signals?.marketRegime || 'FLAT',
  log400: (route: string, msg: string) => log400(route, msg)
};

const settingsContext: SettingsRouterContext = {
  getGlobalSettings: () => globalSettings,
  saveSettings: () => saveSettings(),
  getLastSanitizationStatus: () => settingsManager.getLastSanitizationStatus(),
  getCachedDB: () => getCachedDB(),
  setExpertInstructions: (instructions: string, source: string, reason?: string) => setExpertInstructions(instructions, source as any, reason),
  getAutopilotFailedSymbols: () => autopilotFailedSymbols,
  fetchTelegramChatId: (botToken: string) => fetchTelegramChatId(botToken),
  sendTelegramTestMessage: (botToken: string, chatId: string) => sendTelegramTestMessage(botToken, chatId),
  enrichExchangeError: (error: any) => enrichExchangeError(error),
  WEEX_HEADERS: WEEX_HEADERS,
  getSettingsOptimizerPrompt: (currentSettings: string, message: string) => getSettingsOptimizerPrompt(currentSettings, message),
  runAiGeneration: (params: any) => runAiGeneration(params)
};

const systemContext: SystemRouterContext = {
  getVirtualTrades: () => virtualTrades,
  getKnowledgeBase: () => aiKnowledgeBase,
  getGlobalSettings: () => globalSettings,
  getCachedDB: () => getCachedDB(),
  requestDBSave: () => requestDBSave(),
  streamEmitter: streamEmitter,
  queryStructuredLogs: (params: { limit: number; offset: number; component?: string; level?: string }) => queryStructuredLogs(params),
  getCurrentExchangePingMs: () => getCurrentExchangePingMs(),
  getExchangePingHistory: () => getExchangePingHistory(),
  getProlivPeaks: () => prolivPeaks,
  getAiCommitteeCache: () => GLOBAL_AI_COMMITTEE_CACHE,
  getSignalsCache: () => CACHE.signals,
  getPendingFrontendAiTasks: () => Array.from(pendingAiTasks.values()).map(t => t.params),
  setPendingFrontendAiTasks: () => {},
  resolvePendingAiTask: (id: string, result: any, error?: string) => {
    const task = pendingAiTasks.get(id);
    if (task) {
      if (error) task.reject(new Error(error));
      else task.resolve(result);
      pendingAiTasks.delete(id);
      return true;
    }
    return false;
  },
  getDatabaseRevision: () => (typeof getAtomicStoreRevision === 'function' ? getAtomicStoreRevision() : 0),
  getEventLoopLagMs: () => (typeof serverEventLoopLagMs !== 'undefined' ? serverEventLoopLagMs : 0),
  getWatchdogStatus: () => exchangeWsManager.getWatchdogStatus(),
  getServerStartTime: () => ((globalThis as any).SERVER_START_TIME || Date.now()),
  getLatencyInfo: () => ({
    weexLatencyMs: (globalThis as any).weexLatencyMs || 38,
    binanceLatencyMs: (globalThis as any).binanceLatencyMs || 24
  })
};

const debugContext: DebugRouterContext = {
  getGlobalTrueOhlcv: () => GLOBAL_TRUE_OHLCV,
  getGlobalCcxtTickers: () => GLOBAL_CCXT_TICKERS,
  getGlobalSettings: () => globalSettings,
  getAiKnowledgeBase: () => aiKnowledgeBase,
  getVirtualTrades: () => virtualTrades,
  getSignalsCache: () => CACHE.signals,
  updateTrueOHLCV: () => updateTrueOHLCV(),
  updateSignalsCache: () => updateSignalsCache(),
  isWeexApiSupported: (symbol: string) => isWeexApiSupported(symbol),
  runAiGeneration: (params: any) => runAiGeneration(params),
  safeJsonParse: (str: string, fallback: any) => safeJsonParse(str, fallback),
  generateProgrammaticCommitteeFallback: (item: any) => generateProgrammaticCommitteeFallback(item)
};

export const app = createExpressApp({
  realTradeContext,
  marketContext,
  streamContext,
  aiContext,
  paperTradeContext,
  knowledgeContext,
  settingsContext,
  systemContext,
  debugContext
});

async function startServer() {
  if (isMainThread) {
    const PORT = 3000;

    // Immediately setup Vite / static files middleware so the app frontend responds instantly
    await setupStaticAndViteMiddleware(app);

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log("[SERVER] Quantum Scalping Server running on http://localhost:" + PORT);
    });

    server.on('error', (err: any) => {
      console.error(`[SERVER] Error on port ${PORT}:`, err);
    });

    // Restore state from local DB and remote cloud with resilience against slow or failing networks
    try {
      console.log('[SERVER] ⏳ Awaiting database state and balance restoration...');
      await Promise.race([
        startupLoadPromise,
        new Promise((resolve) => setTimeout(resolve, 3500))
      ]);
      console.log(`[SERVER] 🚀 State load completed. Virtual balance active: $${virtualBalance}. Initializing background tasks...`);
    } catch (e) {
      console.error('[SERVER] Failed during startupLoadPromise (continuing offline-first):', e);
    }
    backgroundSchedulerService.start();

    const gracefulShutdown = async (signal: string) => {
      console.log(`[SERVER] 🛑 Received ${signal}. Executing graceful state flush before shutdown...`);
      try {
        await databasePersistenceManager.flushDB();
        await dbAtomicStore.flush();
        await settingsAtomicStore.flush();
        console.log('[SERVER] 🛡️ Graceful shutdown flush completed cleanly.');
      } catch (err) {
        console.error('[SERVER] Error during shutdown flush:', err);
      }
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 4000).unref();
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }
}

startServer();
