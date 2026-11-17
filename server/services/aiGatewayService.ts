import { GoogleGenAI } from '@google/genai';
import { isMainThread, parentPort } from 'worker_threads';
import { DEFAULT_AI_MODEL, FALLBACK_AI_MODEL, getDefaultAiModel } from '../config/aiModels.ts';

export interface PendingAiTask {
  params: any;
  resolve: (res: any) => void;
  reject: (err: any) => void;
  createdAt: number;
  status: 'pending' | 'processing';
  processedAt?: number;
}

export interface PendingWorkerAiTask {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  createdAt: number;
}

export type AiCallPriority = 1 | 2 | 3;

export interface AiBudgetConfig {
  enabled: boolean;
  dailyLimit: number;
}

export interface AiGatewayOptions {
  geminiApiKey?: string;
  deepseekApiKey?: string;
  frontendTimeoutMs?: number;
  workerTimeoutMs?: number;
  getBudgetSettings?: () => Partial<AiBudgetConfig> | { aiDailyBudgetEnabled?: boolean; aiDailyBudgetCalls?: number } | null | undefined;
  nowProvider?: () => number;
}

export interface AiGatewayErrorInfo {
  status: number | null;
  code: string;
  message: string;
  model: string;
  at: number;
}

export interface AiDailyBudgetStatus {
  enabled: boolean;
  utcDate: string;
  limit: number;
  usedTotal: number;
  usedByPriority: { 1: number; 2: number; 3: number };
  blockedTotal: number;
  thresholds: {
    priority1Max: number;
    priority2Max: number;
    priority3Max: number;
  };
}

export interface AiGatewayHealth {
  model: string;
  geminiKeyConfigured: boolean;
  deepseekKeyConfigured: boolean;
  serverKeyConfigured: boolean;
  lastSuccessAt: number | null;
  aiFallbackCountTotal: number;
  aiFallbackCountLastHour: number;
  cooldownUntil: number | null;
  cooldownActive: boolean;
  lastError: AiGatewayErrorInfo | null;
  errorCounts24h: Record<string, number>;
  dailyBudget: AiDailyBudgetStatus;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class AiGatewayService {
  private pendingAiTasks: Map<string, PendingAiTask> = new Map();
  private pendingWorkerAiTasks: Map<string, PendingWorkerAiTask> = new Map();
  private globalRefGenAi: GoogleGenAI | null = null;
  private serverGeminiCooldownUntil: number = 0;
  private lastCooldownReason: string = '';
  private currentAiQueue: Promise<any> = Promise.resolve();
  private cachedMarketNews: { text: string; timestamp: number } | null = null;
  private _aiFallbackCount: number = 0;
  private fallbackTimestamps: number[] = [];
  private lastSuccessAt: number | null = null;
  private lastError: AiGatewayErrorInfo | null = null;
  private errorEvents24h: Array<{ bucket: string; at: number }> = [];
  private options: AiGatewayOptions;
  private budgetSettingsProvider?: AiGatewayOptions['getBudgetSettings'];
  private budgetUtcDate: string = '';
  private budgetUsedTotal: number = 0;
  private budgetUsedByPriority: { 1: number; 2: number; 3: number } = { 1: 0, 2: 0, 3: 0 };
  private budgetBlockedTotal: number = 0;

  constructor(options: AiGatewayOptions = {}) {
    this.options = options;
    this.budgetSettingsProvider = options.getBudgetSettings;
  }

  public setBudgetSettingsProvider(provider: AiGatewayOptions['getBudgetSettings']): void {
    this.budgetSettingsProvider = provider;
  }

  private now(): number {
    return typeof this.options.nowProvider === 'function' ? this.options.nowProvider() : Date.now();
  }

  private getResolvedBudgetConfig(): AiBudgetConfig {
    const raw: any = typeof this.budgetSettingsProvider === 'function' ? this.budgetSettingsProvider() : undefined;
    const enabled = raw?.enabled !== undefined ? Boolean(raw.enabled) : Boolean(raw?.aiDailyBudgetEnabled);
    const rawLimit = Number(raw?.dailyLimit ?? raw?.aiDailyBudgetCalls ?? 20);
    const dailyLimit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 20;
    return { enabled, dailyLimit };
  }

  private ensureCurrentUtcDay(nowTs = this.now()): void {
    const utcDay = new Date(nowTs).toISOString().slice(0, 10);
    if (this.budgetUtcDate !== utcDay) {
      this.budgetUtcDate = utcDay;
      this.budgetUsedTotal = 0;
      this.budgetUsedByPriority = { 1: 0, 2: 0, 3: 0 };
      this.budgetBlockedTotal = 0;
    }
  }

  private getPriorityThresholds(limit: number): { priority1Max: number; priority2Max: number; priority3Max: number } {
    const safeLimit = Math.max(1, Math.floor(limit));
    const reserveForP1 = safeLimit >= 2 ? Math.max(1, Math.floor(safeLimit * 0.2)) : 1;
    const reserveForP1AndP2 = safeLimit >= 3 ? Math.max(2, Math.ceil(safeLimit * 0.5)) : safeLimit;
    return {
      priority1Max: safeLimit,
      priority2Max: Math.max(0, safeLimit - reserveForP1),
      priority3Max: Math.max(0, safeLimit - reserveForP1AndP2)
    };
  }

  private normalizePriority(rawPriority: any): AiCallPriority {
    if (rawPriority === 1 || rawPriority === 2 || rawPriority === 3) return rawPriority;
    return 3;
  }

  private pruneErrorEvents(nowTs = Date.now()): void {
    const cutoff = nowTs - ONE_DAY_MS;
    while (this.errorEvents24h.length > 0 && this.errorEvents24h[0].at < cutoff) {
      this.errorEvents24h.shift();
    }
  }

  private classifyGeminiError(err: any, model: string, nowTs = Date.now()): {
    info: AiGatewayErrorInfo;
    bucket: string;
    isTransportOrNetwork: boolean;
    isOverloadedOrUnavailable: boolean;
    statusSummary: string;
    shouldCooldown: boolean;
  } {
    const rawMsg = err?.message || String(err || 'Unknown AI error');
    let parsedErrObj: any = null;
    try {
      const jsonStart = rawMsg.indexOf('{');
      if (jsonStart !== -1) {
        parsedErrObj = JSON.parse(rawMsg.slice(jsonStart));
      }
    } catch {}

    const errPayload = parsedErrObj?.error || err?.error || {};
    const explicitStatus = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? errPayload?.code);
    let status: number | null = Number.isFinite(explicitStatus) && explicitStatus > 0 ? explicitStatus : null;

    const isTransportOrNetwork =
      rawMsg.includes('fetch failed') ||
      rawMsg.includes('ETIMEDOUT') ||
      rawMsg.includes('ENOTFOUND') ||
      rawMsg.includes('ECONNREFUSED') ||
      rawMsg.includes('ECONNRESET') ||
      rawMsg.includes('timeout') ||
      err?.code === 'ETIMEDOUT' ||
      err?.code === 'ENOTFOUND' ||
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ECONNRESET';

    if (status === null) {
      if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) status = 429;
      else if (rawMsg.includes('404') || rawMsg.includes('NOT_FOUND')) status = 404;
      else if (rawMsg.includes('403') || rawMsg.includes('PERMISSION_DENIED') || rawMsg.includes('denied access')) status = 403;
      else if (rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE') || rawMsg.includes('overloaded')) status = 503;
      else if (rawMsg.includes('401') || rawMsg.includes('UNAUTHENTICATED')) status = 401;
      else if (rawMsg.includes('400') || rawMsg.includes('INVALID_ARGUMENT')) status = 400;
      else if (rawMsg.includes('500') || rawMsg.includes('INTERNAL')) status = 500;
    }

    let code = String(errPayload?.status || err?.code || '').trim();
    if (!code) {
      if (status === 429) code = 'RESOURCE_EXHAUSTED';
      else if (status === 404) code = 'NOT_FOUND';
      else if (status === 403) code = 'PERMISSION_DENIED';
      else if (status === 503) code = 'UNAVAILABLE';
      else if (status === 401) code = 'UNAUTHENTICATED';
      else if (isTransportOrNetwork) code = 'NETWORK_ERROR';
      else code = 'UNKNOWN';
    }

    const isOverloadedOrUnavailable =
      status === 503 ||
      rawMsg.includes('503') ||
      rawMsg.includes('UNAVAILABLE') ||
      rawMsg.includes('overloaded') ||
      rawMsg.includes('temporarily unavailable');

    let bucket = 'OTHER';
    if (status === 429) bucket = '429';
    else if (status === 404) bucket = '404';
    else if (status === 403) bucket = '403';
    else if (status === 503 || isOverloadedOrUnavailable) bucket = '503';
    else if (isTransportOrNetwork) bucket = 'NETWORK';
    else if (status !== null) bucket = String(status);

    let statusSummary = 'unavailable';
    if (status === 429) {
      statusSummary = 'QUOTA';
    } else if (status === 403) {
      statusSummary = 'cloud project access restricted (403)';
    } else if (status === 404) {
      statusSummary = 'model deprecated / not found (404)';
    } else if (isOverloadedOrUnavailable) {
      statusSummary = 'model temporarily overloaded (503)';
    } else if (isTransportOrNetwork) {
      statusSummary = 'network connection temporarily unavailable';
    } else {
      statusSummary = rawMsg.length > 80 ? rawMsg.slice(0, 80) + '...' : rawMsg;
    }

    const shouldCooldown =
      status === 403 ||
      status === 404 ||
      status === 429 ||
      isOverloadedOrUnavailable ||
      isTransportOrNetwork;

    const cleanMessage = String(errPayload?.message || rawMsg).slice(0, 300);

    return {
      info: {
        status,
        code,
        message: cleanMessage,
        model,
        at: nowTs
      },
      bucket,
      isTransportOrNetwork,
      isOverloadedOrUnavailable,
      statusSummary,
      shouldCooldown
    };
  }

  private recordErrorEvent(err: any, model: string, nowTs = Date.now()) {
    const classified = this.classifyGeminiError(err, model, nowTs);
    this.lastError = classified.info;
    this.pruneErrorEvents(nowTs);
    this.errorEvents24h.push({ bucket: classified.bucket, at: nowTs });
    return classified;
  }

  private recordFallbackEvent(nowTs = Date.now()): void {
    this._aiFallbackCount++;
    this.fallbackTimestamps.push(nowTs);
    const cutoff = nowTs - 3600 * 1000;
    while (this.fallbackTimestamps.length > 0 && this.fallbackTimestamps[0] < cutoff) {
      this.fallbackTimestamps.shift();
    }
  }

  public recordSuccessEvent(nowTs = Date.now()): void {
    this.lastSuccessAt = nowTs;
  }

  public getLastSuccessAt(): number | null {
    return this.lastSuccessAt;
  }

  public getAiFallbackCountLastHour(nowTs = Date.now()): number {
    const cutoff = nowTs - 3600 * 1000;
    while (this.fallbackTimestamps.length > 0 && this.fallbackTimestamps[0] < cutoff) {
      this.fallbackTimestamps.shift();
    }
    return this.fallbackTimestamps.length;
  }

  public get aiFallbackCount(): number {
    return this._aiFallbackCount;
  }

  public getAiFallbackCount(): number {
    return this._aiFallbackCount;
  }

  public getHealth(nowTs = this.now()): AiGatewayHealth {
    this.pruneErrorEvents(nowTs);
    this.ensureCurrentUtcDay(nowTs);
    const budgetCfg = this.getResolvedBudgetConfig();
    const thresholds = this.getPriorityThresholds(budgetCfg.dailyLimit);
    const errorCounts24h: Record<string, number> = {
      '429': 0,
      '404': 0,
      '403': 0,
      '503': 0,
      'NETWORK': 0,
      'OTHER': 0
    };
    for (const ev of this.errorEvents24h) {
      errorCounts24h[ev.bucket] = (errorCounts24h[ev.bucket] || 0) + 1;
    }

    const geminiKeyConfigured = Boolean(this.options.geminiApiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY);
    const deepseekKeyConfigured = Boolean(this.options.deepseekApiKey || process.env.DEEPSEEK_API_KEY);

    return {
      model: getDefaultAiModel(),
      geminiKeyConfigured,
      deepseekKeyConfigured,
      serverKeyConfigured: geminiKeyConfigured || deepseekKeyConfigured,
      lastSuccessAt: this.lastSuccessAt,
      aiFallbackCountTotal: this._aiFallbackCount,
      aiFallbackCountLastHour: this.getAiFallbackCountLastHour(nowTs),
      cooldownUntil: this.serverGeminiCooldownUntil > nowTs ? this.serverGeminiCooldownUntil : null,
      cooldownActive: this.serverGeminiCooldownUntil > nowTs,
      lastError: this.lastError ? { ...this.lastError } : null,
      errorCounts24h,
      dailyBudget: {
        enabled: budgetCfg.enabled,
        utcDate: this.budgetUtcDate,
        limit: budgetCfg.dailyLimit,
        usedTotal: this.budgetUsedTotal,
        usedByPriority: { ...this.budgetUsedByPriority },
        blockedTotal: this.budgetBlockedTotal,
        thresholds
      }
    };
  }

  public resetAiFallbackCount(): void {
    this._aiFallbackCount = 0;
    this.fallbackTimestamps = [];
    this.lastSuccessAt = null;
    this.lastError = null;
    this.errorEvents24h = [];
    this.serverGeminiCooldownUntil = 0;
    this.lastCooldownReason = '';
    this.budgetUtcDate = '';
    this.budgetUsedTotal = 0;
    this.budgetUsedByPriority = { 1: 0, 2: 0, 3: 0 };
    this.budgetBlockedTotal = 0;
  }

  public getPendingAiTasks(): Map<string, PendingAiTask> {
    return this.pendingAiTasks;
  }

  public getPendingWorkerAiTasks(): Map<string, PendingWorkerAiTask> {
    return this.pendingWorkerAiTasks;
  }

  public getCachedMarketNews(): { text: string; timestamp: number } | null {
    return this.cachedMarketNews;
  }

  public setCachedMarketNews(news: { text: string; timestamp: number } | null): void {
    this.cachedMarketNews = news;
  }

  public getInternalServerGeminiClient(): GoogleGenAI | null {
    if (!this.globalRefGenAi) {
      const key = this.options.geminiApiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
      if (key) {
        this.globalRefGenAi = new GoogleGenAI({
          apiKey: key,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });
      }
    }
    return this.globalRefGenAi;
  }

  public resetInternalServerGeminiClient(): void {
    this.globalRefGenAi = null;
  }

  public setInternalServerGeminiClient(client: GoogleGenAI | null): void {
    this.globalRefGenAi = client;
  }

  public addAndQueueFrontendTask(params: any, modeReason: string): Promise<any> {
    console.log(`[AI Router] Routing AI request via Frontend Client. (Reason: ${modeReason})`);
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 15);
      this.pendingAiTasks.set(id, { params, resolve, reject, createdAt: Date.now(), status: 'pending', processedAt: 0 });

      const timeoutMs = this.options.frontendTimeoutMs || 60000;
      setTimeout(() => {
        if (this.pendingAiTasks.has(id)) {
          this.pendingAiTasks.delete(id);
          this.recordFallbackEvent();
          console.log(`[AI Router] Task ${id} timed out on frontend. Returning static fallback JSON.`);
          let defaultFallback = JSON.stringify({
            rationale: "Бот запрашивал AI, но вкладка браузера закрыта или не отвечает.",
            evaluation: "Ожидание фронтенда истекло.",
            consensus: "АВТО-HOLD",
            judgeDecision: "NEUTRAL",
            aiScore: 0,
            approved: false,
            wouldBlock: true,
            action: "HOLD",
            isFallback: true,
            fallbackReason: "Frontend task timeout"
          });
          if (
            params.config?.responseSchema?.type === 'ARRAY' ||
            params.config?.responseSchema?.type === 2 ||
            (params.contents && JSON.stringify(params.contents).includes('Return ONLY a JSON array'))
          ) {
            defaultFallback = '[]';
          }
          resolve({ text: defaultFallback, isFallback: true, fallbackReason: 'Frontend task timeout' });
        }
      }, timeoutMs);
    });
  }

  public getPendingTasksToSend(limit = 2): { id: string; params: any }[] {
    const now = Date.now();
    const tasksToSend: { id: string; params: any }[] = [];

    for (const [id, task] of this.pendingAiTasks.entries()) {
      if (task.status === 'pending' || (task.status === 'processing' && task.processedAt && (now - task.processedAt > 60000))) {
        task.status = 'processing';
        task.processedAt = now;
        tasksToSend.push({ id, params: task.params });

        if (tasksToSend.length >= limit) break;
      }
    }
    return tasksToSend;
  }

  public completeFrontendTask(id: string, result: any, error?: string): boolean {
    const task = this.pendingAiTasks.get(id);
    if (!task) return false;

    if (error) {
      task.reject(new Error(error));
    } else {
      task.resolve(result);
    }
    this.pendingAiTasks.delete(id);
    return true;
  }

  public getStaticServerSideAiFallback(params: any, errorMsg: string): { text: string; isFallback: true; fallbackReason: string } {
    this.recordFallbackEvent();
    const promptString = JSON.stringify(params.contents || "");
    let text = "[]";

    // Check if it expects a JSON array
    const isArrayExpected = params.config?.responseSchema?.type === 'ARRAY' ||
                            params.config?.responseSchema?.type === 2 ||
                            promptString.includes('Return ONLY a JSON array') ||
                            promptString.includes('JSON array of');

    if (isArrayExpected) {
      text = "[]";
    } else if (promptString.includes('retrospectiveSummary') || promptString.includes('ИИ-Контур') || promptString.includes('Ретроспективная Оптимизация') || promptString.includes('getRetrospectivePrompt')) {
      text = JSON.stringify({
        retrospectiveSummary: "ИИ недоступен, ретроспектива пропущена",
        agentExchangeConversations: [],
        rulesToArchive: [],
        expertModifications: "",
        optimizedLogicSummary: "Оптимизация пропущена из-за недоступности ИИ",
        impactAssessment: "Нейтрально",
        historicalSelfReview: "Пропущено",
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else if (promptString.includes('expertPrompt') || promptString.includes('ИИ-Ведущий Трейдер') || promptString.includes('dcaMultiplier') || promptString.includes('partialCloseRatio')) {
      text = JSON.stringify({
        action: "HOLD",
        advice: "ИИ-эксперт недоступен. Сохранение текущих уровней позиции без изменений.",
        newSl: null,
        newTp: null,
        reasonCategory: "HOLD_CURRENT",
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else if (promptString.includes('getTradeEvaluationPrompt') || promptString.includes('learnedRule') || promptString.includes('evaluate-closed-trade') || promptString.includes('EVALUATE_CLOSED_TRADE')) {
      text = JSON.stringify({
        evaluation: "ИИ недоступен для разбора сделки.",
        learnedRule: "",
        agent: "MANAGER",
        rationale: "Оценка пропущена: ИИ недоступен.",
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else if (promptString.includes('updatedSettings') || promptString.includes('globalSettings') || promptString.includes('SettingsOptimizer')) {
      text = JSON.stringify({
        updatedSettings: {},
        explanation: `ИИ недоступен (${errorMsg}). Настройки оставлены без изменений.`,
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else if (promptString.includes('techAnalyst') || promptString.includes('riskManager') || promptString.includes('judgeDecision') || promptString.includes('getSignalAnalysisPrompt')) {
      text = JSON.stringify({
        techAnalyst: `ИИ недоступен (${errorMsg}). Технический вердикт не сформирован.`,
        riskManager: `ИИ недоступен (${errorMsg}). Риск-оценка нейтральна.`,
        consensus: "НЕТ ДАННЫХ",
        judgeDecision: "NEUTRAL",
        consensusReason: `ИИ недоступен: ${errorMsg}`,
        aiScore: 0,
        approved: false,
        action: "HOLD",
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else if (promptString.includes('rationale') || promptString.includes('evaluation') || promptString.includes('wouldBlock')) {
      text = JSON.stringify({
        rationale: `ИИ недоступен (${errorMsg}). Действие заблокировано.`,
        evaluation: "Оценка недоступна.",
        consensus: "НЕТ ДАННЫХ",
        judgeDecision: "NEUTRAL",
        aiScore: 0,
        approved: false,
        wouldBlock: true,
        action: "HOLD",
        isFallback: true,
        fallbackReason: errorMsg
      });
    } else {
      if (params.config?.responseMimeType === "application/json") {
        text = JSON.stringify({
          isFallback: true,
          fallbackReason: errorMsg,
          judgeDecision: "NEUTRAL",
          aiScore: 0,
          approved: false,
          action: "HOLD",
          consensus: "НЕТ ДАННЫХ"
        });
      } else {
        text = JSON.stringify({
          isFallback: true,
          fallbackReason: errorMsg,
          message: `ИИ недоступен: ${errorMsg}`
        });
      }
    }

    return { text, isFallback: true, fallbackReason: errorMsg };
  }

  public async runAiGeneration(params: any): Promise<any> {
    const deepseekKey = this.options.deepseekApiKey || process.env.DEEPSEEK_API_KEY;
    const hasDirectGemini = !!this.getInternalServerGeminiClient();

    if (!isMainThread && !deepseekKey && !hasDirectGemini) {
      console.log(`[WORKER AI] No direct server-side key available. Routing AI request to main thread...`);
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).substring(2, 15);
        this.pendingWorkerAiTasks.set(id, { resolve, reject, createdAt: Date.now() });
        parentPort?.postMessage({
          type: 'RUN_AI_GENERATION',
          payload: { id, params }
        });

        const workerTimeoutMs = this.options.workerTimeoutMs || 65000;
        setTimeout(() => {
          if (this.pendingWorkerAiTasks.has(id)) {
            this.pendingWorkerAiTasks.delete(id);
            console.log(`[WORKER AI] Task ${id} timed out waiting for main thread response. Using static fallback.`);
            resolve(this.getStaticServerSideAiFallback(params, "Таймаут ожидания главного потока"));
          }
        }, workerTimeoutMs);
      });
    }

    const task = async () => {
      const nowTs = this.now();
      this.ensureCurrentUtcDay(nowTs);
      const priority = this.normalizePriority(params?.priority);
      const budgetCfg = this.getResolvedBudgetConfig();
      if (budgetCfg.enabled) {
        const thresholds = this.getPriorityThresholds(budgetCfg.dailyLimit);
        const capForPriority = priority === 1
          ? thresholds.priority1Max
          : (priority === 2 ? thresholds.priority2Max : thresholds.priority3Max);
        if (this.budgetUsedTotal >= capForPriority) {
          this.budgetBlockedTotal++;
          return this.getStaticServerSideAiFallback(params, 'BUDGET');
        }
      }

      const dsKey = this.options.deepseekApiKey || process.env.DEEPSEEK_API_KEY;

      if (dsKey) {
        this.budgetUsedTotal++;
        this.budgetUsedByPriority[priority]++;
        try {
          let promptText = "";
          const systemPrompts: string[] = [];

          if (params.contents && Array.isArray(params.contents)) {
            for (const c of params.contents) {
              if (c.parts && Array.isArray(c.parts)) {
                for (const p of c.parts) {
                  if (p.text) {
                    if (c.role === 'system') systemPrompts.push(p.text);
                    else promptText += p.text + "\n";
                  }
                }
              }
            }
          }

          const temp = params.config?.temperature ?? 0.2;
          const messages = [];
          if (systemPrompts.length > 0) {
            messages.push({ role: "system", content: systemPrompts.join("\n") });
          } else {
            messages.push({ role: "system", content: "You are a helpful trading AI assistant. Use JSON format." });
          }
          messages.push({ role: "user", content: promptText });

          const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${dsKey}`
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages,
              response_format: params.config?.responseMimeType === "application/json" ? { type: "json_object" } : undefined,
              temperature: temp
            })
          });
          if (resp.ok) {
            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content || "";
            this.recordSuccessEvent(nowTs);
            return { text };
          } else {
            const errBody = await resp.text();
            console.warn("[DEEPSEEK] Request failed (" + resp.status + "): " + errBody + ". Falling back to Gemini...");
          }
        } catch (e: any) {
          console.warn("[DEEPSEEK] Exception during request: " + (e?.message || e) + ". Falling back to Gemini...");
        }
      }

      if (this.serverGeminiCooldownUntil > nowTs) {
        const cooldownReason = this.lastCooldownReason === 'QUOTA'
          ? 'QUOTA'
          : 'Gemini API in cooldown due to access/quota status. Using local fallback.';
        return this.getStaticServerSideAiFallback(params, cooldownReason);
      }

      const ai = this.getInternalServerGeminiClient();
      if (ai) {
        if (!dsKey) {
          this.budgetUsedTotal++;
          this.budgetUsedByPriority[priority]++;
        }
        const requestedModel = String(params.model || '');
        const isLegacyModel = !requestedModel ||
          requestedModel.includes('gemini-3.') ||
          requestedModel.includes('gemini-1.5') ||
          requestedModel.includes('gemini-2.0');
        const defaultModel = getDefaultAiModel();
        const model = isLegacyModel || requestedModel === DEFAULT_AI_MODEL ? defaultModel : requestedModel;

        try {
          const sanitizeConfigForModel = (rawConfig: any, targetModel: string) => {
            if (!rawConfig || typeof rawConfig !== 'object') return rawConfig;
            if (!targetModel.startsWith('gemini-4')) return rawConfig;
            const cloned = { ...rawConfig };
            delete cloned.temperature;
            delete cloned.topP;
            delete cloned.topK;
            delete cloned.candidateCount;
            return Object.keys(cloned).length > 0 ? cloned : undefined;
          };

          const primaryConfig = sanitizeConfigForModel(params.config, model);
          let response: any;
          try {
            response = await ai.models.generateContent({
              model,
              contents: params.contents,
              config: primaryConfig
            });
          } catch (primaryErr: any) {
            const primaryMsg = primaryErr?.message || String(primaryErr);
            const is503OrOverloaded = primaryMsg.includes('503') || primaryMsg.includes('overloaded') || primaryMsg.includes('UNAVAILABLE');
            // Automatic model fallback is strictly restricted to transient 503 overload; 429 QUOTA must never switch models.
            if (is503OrOverloaded && model !== FALLBACK_AI_MODEL) {
              try {
                response = await ai.models.generateContent({
                  model: FALLBACK_AI_MODEL,
                  contents: params.contents,
                  config: params.config
                });
              } catch {
                throw primaryErr;
              }
            } else {
              throw primaryErr;
            }
          }
          this.recordSuccessEvent(nowTs);
          return { text: response?.text || "" };
        } catch (geminiErr: any) {
          const classified = this.recordErrorEvent(geminiErr, model, nowTs);

          if (classified.info.status === 429) {
            console.warn(`[AI ENGINE] QUOTA exceeded (429 ${classified.info.code}) on model ${model}: ${classified.info.message.slice(0, 140)}`);
          }

          if (classified.shouldCooldown) {
            const cooldownDurationMs = (classified.isTransportOrNetwork || classified.isOverloadedOrUnavailable)
              ? 2 * 60 * 1000
              : 10 * 60 * 1000;
            this.serverGeminiCooldownUntil = nowTs + cooldownDurationMs;
            this.lastCooldownReason = classified.info.status === 429 ? 'QUOTA' : classified.statusSummary;
            console.log(`[AI ENGINE] Switched to local quantum engine (cloud AI status: ${classified.statusSummary}). Normal operation continues.`);
          } else {
            console.log('[AI ENGINE] Notice: ' + classified.statusSummary + '. Using local fallback.');
          }

          return this.getStaticServerSideAiFallback(params, classified.statusSummary);
        }
      } else {
        return this.getStaticServerSideAiFallback(params, "AI keys not configured");
      }
    };

    this.currentAiQueue = this.currentAiQueue.then(task, task);
    return this.currentAiQueue;
  }
}

export const aiGatewayService = new AiGatewayService();
