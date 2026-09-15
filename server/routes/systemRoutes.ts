import express from 'express';
import type { Request, Response, Router } from 'express';
import { getAuthMode, validateApiKey } from '../middleware/auth.ts';
import { DirectionalMemoryAnalyticsService } from '../services/directionalMemoryAnalyticsService.ts';

export interface SystemRouterContext {
  getVirtualTrades: () => any[];
  getKnowledgeBase: () => any[];
  getGlobalSettings: () => any;
  getCachedDB: () => any;
  requestDBSave: () => void;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  queryStructuredLogs: (params: { limit: number; offset: number; component?: string; level?: string }) => any;
  getCurrentExchangePingMs: () => number;
  getExchangePingHistory: () => any[];
  getProlivPeaks: () => any[];
  getAiCommitteeCache: () => Record<string, any>;
  getSignalsCache: () => any;
  getPendingFrontendAiTasks: () => any[];
  setPendingFrontendAiTasks: (tasks: any[]) => void;
  resolvePendingAiTask?: (id: string, result: any, error?: string) => boolean;
  onInjectTestSignal?: (signal: any) => void;
  getDatabaseRevision?: () => number;
  getEventLoopLagMs?: () => number;
  getWatchdogStatus?: () => any;
  getServerStartTime?: () => number;
  getLatencyInfo?: () => { weexLatencyMs: number; binanceLatencyMs: number };
}

export function createSystemRouter(ctx: SystemRouterContext): Router {
  const router = express.Router();

  // GET /api/health
  router.get('/health', (req: Request, res: Response) => {
    res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/ping (Ultra-lightweight ping for RTT latency measurement)
  router.get('/ping', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).send('pong');
  });

  // GET /api/pipeline-audit (Automated Pipeline Self-Diagnostics)
  router.get('/pipeline-audit', (req: Request, res: Response) => {
    try {
      const signalsCache = ctx.getSignalsCache();
      const allSignals = signalsCache?.data || [];
      const activeSignals = allSignals.filter((s: any) => s.signal && s.signal !== 'NEUTRAL');
      const shorts = allSignals.filter((s: any) => s.signal === 'SHORT');
      const longs = allSignals.filter((s: any) => s.signal === 'LONG');
      const withTrace = activeSignals.filter((s: any) => s.decisionTrace);

      const virtualTrades = ctx.getVirtualTrades();
      const directionalStats = DirectionalMemoryAnalyticsService.generateSplitMemoryReport(virtualTrades);
      const latencies = ctx.getLatencyInfo ? ctx.getLatencyInfo() : {
        weexLatencyMs: (globalThis as any).weexLatencyMs || 38,
        binanceLatencyMs: (globalThis as any).binanceLatencyMs || 24
      };

      const audit = {
        timestamp: new Date().toISOString(),
        pipelineStatus: activeSignals.length > 0 ? 'HEALTHY' : 'STANDBY',
        connectivity: {
          status: 'ONLINE',
          weexLatencyMs: latencies.weexLatencyMs,
          binanceLatencyMs: latencies.binanceLatencyMs,
          currentPingMs: ctx.getCurrentExchangePingMs()
        },
        marketScanner: {
          totalTrackedSymbols: allSignals.length,
          activeSignalsCount: activeSignals.length,
          shortSignalsCount: shorts.length,
          longSignalsCount: longs.length,
          marketRegime: signalsCache?.marketRegime || 'NEUTRAL',
          signalsWithTraceCount: withTrace.length
        },
        consensusEngine: {
          cachedVerdictsCount: Object.keys(ctx.getAiCommitteeCache() || {}).length,
          agentDynamicWeights: Object.keys(directionalStats.agentStats || {}).reduce((acc: any, k) => {
            acc[k] = directionalStats.agentStats[k].dynamicWeight;
            return acc;
          }, {})
        },
        directionalMemory: {
          shortFutures: {
            totalTrades: directionalStats.shortFutures.totalTrades,
            winRate: directionalStats.shortFutures.winRate,
            pnlUsd: directionalStats.shortFutures.totalPnlUsd,
            profitFactor: directionalStats.shortFutures.profitFactor
          },
          longFutures: {
            totalTrades: directionalStats.longFutures.totalTrades,
            winRate: directionalStats.longFutures.winRate,
            pnlUsd: directionalStats.longFutures.totalPnlUsd,
            profitFactor: directionalStats.longFutures.profitFactor
          }
        },
        knowledgeBase: {
          activeRules: ctx.getKnowledgeBase().filter(r => !r.isArchived).length,
          totalRules: ctx.getKnowledgeBase().length
        }
      };

      res.json({ success: true, audit });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/ping
  router.get('/ping', (req: Request, res: Response) => {
    const t0 = Date.now();
    const latencies = ctx.getLatencyInfo ? ctx.getLatencyInfo() : {
      weexLatencyMs: (globalThis as any).weexLatencyMs || 38,
      binanceLatencyMs: (globalThis as any).binanceLatencyMs || 24
    };
    res.json({
      success: true,
      serverTime: t0,
      weexLatency: latencies.weexLatencyMs,
      binanceLatency: latencies.binanceLatencyMs
    });
  });

  // GET /api/auth-audit-stats
  router.get('/auth-audit-stats', (req: Request, res: Response) => {
    res.json({ success: true, data: { authMode: getAuthMode(), apiAccessKeyConfigured: !!process.env.API_ACCESS_KEY } });
  });

  // GET /api/system/status
  router.get('/system/status', (req: Request, res: Response) => {
    const headerKey = (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string)?.replace('Bearer ', '');
    const cookieKey = (req as any).cookies?.auth_token;
    const keyToValidate = headerKey || cookieKey;
    const isAuthenticated = keyToValidate && validateApiKey(keyToValidate);

    if (!isAuthenticated && getAuthMode() !== 'disabled') {
      return res.json({
        success: true,
        status: 'ONLINE',
        timestamp: new Date().toISOString()
      });
    }

    const virtualTrades = ctx.getVirtualTrades();
    const activeCount = Array.isArray((globalThis as any).paperTrades)
      ? (globalThis as any).paperTrades.filter((t: any) => t.status === 'OPEN').length
      : (Array.isArray(virtualTrades) ? virtualTrades.filter(t => t.status === 'OPEN').length : 0);

    const signalsCache = ctx.getSignalsCache();
    const serverStartTime = ctx.getServerStartTime ? ctx.getServerStartTime() : ((globalThis as any).SERVER_START_TIME || Date.now());
    const latencies = ctx.getLatencyInfo ? ctx.getLatencyInfo() : {
      weexLatencyMs: (globalThis as any).weexLatencyMs || 38,
      binanceLatencyMs: (globalThis as any).binanceLatencyMs || 24
    };

    res.json({
      success: true,
      status: 'ONLINE',
      timestamp: new Date().toISOString(),
      serverUptime: (Date.now() - serverStartTime) / 1000,
      uptimeSec: Math.floor(process.uptime()),
      authMode: getAuthMode(),
      databaseRevision: ctx.getDatabaseRevision ? ctx.getDatabaseRevision() : 0,
      eventLoopLagMs: ctx.getEventLoopLagMs ? ctx.getEventLoopLagMs() : 0,
      aiFallbackActive: !Boolean(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY),
      realTradingEnabled: process.env.ENABLE_REAL_TRADING === 'true',
      activePositionsCount: activeCount,
      signalsCount: signalsCache?.data?.length || 0,
      weexLatencyMs: latencies.weexLatencyMs,
      binanceLatencyMs: latencies.binanceLatencyMs,
      wsLatenciesMs: {
        weex: latencies.weexLatencyMs,
        binance: latencies.binanceLatencyMs
      }
    });
  });

  // GET /api/system/quant-metrics
  router.get('/system/quant-metrics', (req: Request, res: Response) => {
    res.json({
      success: true,
      eventLoopLagMs: ctx.getEventLoopLagMs ? ctx.getEventLoopLagMs() : 0,
      watchdogStatus: ctx.getWatchdogStatus ? ctx.getWatchdogStatus() : {}
    });
  });

  // GET /api/telemetry/ping
  router.get('/telemetry/ping', (req: Request, res: Response) => {
    const virtualTrades = ctx.getVirtualTrades();
    const aiKnowledgeBase = ctx.getKnowledgeBase();
    const globalSettings = ctx.getGlobalSettings();
    const signalsCache = ctx.getSignalsCache();
    const aiCommitteeCache = ctx.getAiCommitteeCache();

    const activeVirtualCount = virtualTrades.filter(t => t.status === 'OPEN').length;
    const activeRulesCount = aiKnowledgeBase.filter(r => !r.isArchived).length;
    const archivedRulesCount = aiKnowledgeBase.filter(r => r.isArchived).length;
    const totalCachedVerdicts = Object.keys(aiCommitteeCache || {}).length;
    const totalSignalsCount = signalsCache?.data?.length || 0;
    const nonNeutralSignalsCount = signalsCache?.data ? signalsCache.data.filter((s: any) => s.signal !== 'NEUTRAL').length : 0;

    res.json({
      success: true,
      currentPingMs: ctx.getCurrentExchangePingMs(),
      history: ctx.getExchangePingHistory(),
      agents: [
        {
          id: "scanner",
          name: "ИИ-Сканер (Scanner Agent)",
          description: "Охотник за Пампами: мониторит WebSocket-фиды бирж, выявляет шпилеобразные сквизы и параболический рост.",
          status: "АКТИВЕН",
          details: `Потоковое сканирование. Найдено активных сигналов: ${totalSignalsCount} (в фильтре: ${nonNeutralSignalsCount})`
        },
        {
          id: "risk_manager",
          name: "Риск-менеджер (Risk Manager)",
          description: "Контроль позиций, адаптивный расчет ATR для сеток ордеров, управление DCA шагами и плечами.",
          status: activeVirtualCount > 0 ? "КООРДИНИРУЕТ" : "НАБЛЮДЕНИЕ",
          details: `Активных сделок в наблюдении: ${activeVirtualCount} (Всего в истории: ${virtualTrades.length})`
        },
        {
          id: "committee",
          name: "ИИ-Консенсус (Consensus Committee)",
          description: "Трехсторонний консенсус ИИ (Бык, Медведь и Судья) для скоринга и одобрения заявок перед входом.",
          status: "АКТИВЕН",
          details: `Скоррелировано вердиктов ИИ в кэше: ${totalCachedVerdicts}. Готов к валидации сигналов.`
        },
        {
          id: "archiver",
          name: "ИИ-Архивариус (Archiver)",
          description: "Дистиллятор базы знаний. Анализирует PnL сигналов и отправляет малоэффективные правила в архив.",
          status: "АКТИВЕН",
          details: `Активных правил на рынке: ${activeRulesCount} (В архиве на ретесте: ${archivedRulesCount})`
        },
        {
          id: "ai_expert",
          name: "ИИ-Эксперт (AI Expert Adviser)",
          description: "Автопилот корректировок: оценивает рыночный контекст для подтяжки TakeProfit/StopLoss на лету.",
          status: globalSettings.isAiExpertTraderEnabled ? "АКТИВЕН" : "ОЖИДАНИЕ",
          details: globalSettings.isAiExpertTraderEnabled ? "Включен автоматический экспертный трейдинг." : "Режим ручного подтверждения рекомендаций."
        }
      ]
    });
  });

  // GET /api/logs/structured
  router.get('/logs/structured', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const component = req.query.component as string;
      const level = req.query.level as string;

      const result = ctx.queryStructuredLogs({ limit, offset, component, level });
      res.json({
        success: true,
        ...result
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/database/export
  router.get('/database/export', (req: Request, res: Response) => {
    try {
      const data = ctx.getCachedDB();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=crypto-ai-agent-db-backup.json');
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/proliv-peaks
  router.get('/proliv-peaks', (req: Request, res: Response) => {
    res.json({ success: true, data: ctx.getProlivPeaks() });
  });

  // DELETE /api/proliv-peaks/:id
  router.delete('/proliv-peaks/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const peaks = ctx.getProlivPeaks();
    const index = peaks.findIndex(p => p.id === id);
    if (index !== -1) {
      peaks.splice(index, 1);
      const dbData = ctx.getCachedDB();
      dbData.prolivPeaks = peaks;
      ctx.requestDBSave();
      ctx.streamEmitter.emit('signals_updated');
      return res.json({ success: true, message: 'Peak removed successfully', data: peaks });
    }
    res.status(404).json({ success: false, error: 'Peak not found' });
  });

  // DELETE /api/peaks/:id (alias)
  router.delete('/peaks/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const peaks = ctx.getProlivPeaks();
    const index = peaks.findIndex(p => p.id === id);
    if (index !== -1) {
      peaks.splice(index, 1);
      const dbData = ctx.getCachedDB();
      dbData.prolivPeaks = peaks;
      ctx.requestDBSave();
      ctx.streamEmitter.emit('signals_updated');
      return res.json({ success: true, message: 'Peak removed successfully', data: peaks });
    }
    res.status(404).json({ success: false, error: 'Peak not found' });
  });

  // GET /api/retrospective
  router.get('/retrospective', (req: Request, res: Response) => {
    try {
      const dbData = ctx.getCachedDB();
      res.json({ success: true, data: dbData.retrospectiveMemory || [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/retrospective/:id
  router.delete('/retrospective/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const dbData = ctx.getCachedDB();
      if (dbData.retrospectiveMemory) {
        const idx = dbData.retrospectiveMemory.findIndex((m: any) => m.id === id);
        if (idx !== -1) {
          dbData.retrospectiveMemory.splice(idx, 1);
          ctx.requestDBSave();
          ctx.streamEmitter.emit('signals_updated');
          return res.json({ success: true, data: dbData.retrospectiveMemory });
        }
      }
      res.status(404).json({ success: false, error: 'Разбор сделки не найден' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/debug-env
  router.get('/debug-env', (req: Request, res: Response) => {
    const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY);
    const hasDeepseek = !!process.env.DEEPSEEK_API_KEY;
    const offlineMode = process.env.OFFLINE_MODE === '1';
    res.json({
      success: true,
      hasGemini,
      hasDeepseek,
      offlineMode,
      nodeEnv: process.env.NODE_ENV
    });
  });

  // GET /api/ai-tasks/pending
  router.get('/ai-tasks/pending', (req: Request, res: Response) => {
    const tasks = ctx.getPendingFrontendAiTasks();
    const now = Date.now();
    // Filter out expired tasks older than 45 seconds
    const validTasks = tasks.filter(t => (now - t.createdAt) < 45000);
    ctx.setPendingFrontendAiTasks(validTasks);
    res.json({ success: true, tasks: validTasks });
  });

  // POST /api/ai-tasks/complete
  router.post('/ai-tasks/complete', (req: Request, res: Response) => {
    const { id, result, error } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing task id' });
    }
    if (ctx.resolvePendingAiTask) {
      const resolved = ctx.resolvePendingAiTask(id, result, error);
      return res.json({ success: resolved });
    }
    res.json({ success: false, error: 'Resolver not configured' });
  });

  // POST /api/debug/inject-test-signal
  router.post('/debug/inject-test-signal', (req: Request, res: Response) => {
    try {
      const { signal } = req.body;
      if (!signal || !signal.symbol) {
        return res.status(400).json({ success: false, error: 'Missing signal symbol' });
      }
      if (ctx.onInjectTestSignal) {
        ctx.onInjectTestSignal(signal);
      }
      ctx.streamEmitter.emit('signals_updated');
      res.json({ success: true, message: `Test signal injected for ${signal.symbol}` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
