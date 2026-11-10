import { GoogleGenAI } from '@google/genai';
import { isMainThread, parentPort } from 'worker_threads';

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

export interface AiGatewayOptions {
  geminiApiKey?: string;
  deepseekApiKey?: string;
  frontendTimeoutMs?: number;
  workerTimeoutMs?: number;
}

export class AiGatewayService {
  private pendingAiTasks: Map<string, PendingAiTask> = new Map();
  private pendingWorkerAiTasks: Map<string, PendingWorkerAiTask> = new Map();
  private globalRefGenAi: GoogleGenAI | null = null;
  private serverGeminiCooldownUntil: number = 0;
  private currentAiQueue: Promise<any> = Promise.resolve();
  private cachedMarketNews: { text: string; timestamp: number } | null = null;
  private _aiFallbackCount: number = 0;
  private fallbackTimestamps: number[] = [];
  private lastSuccessAt: number | null = null;
  private options: AiGatewayOptions;

  constructor(options: AiGatewayOptions = {}) {
    this.options = options;
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

  public resetAiFallbackCount(): void {
    this._aiFallbackCount = 0;
    this.fallbackTimestamps = [];
    this.lastSuccessAt = null;
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
          resolve({ text: defaultFallback });
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

  public getStaticServerSideAiFallback(params: any, errorMsg: string): { text: string } {
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
        text = `ИИ недоступен: ${errorMsg}`;
      }
    }

    return { text };
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
      const dsKey = this.options.deepseekApiKey || process.env.DEEPSEEK_API_KEY;

      if (dsKey) {
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
            this.recordSuccessEvent();
            return { text };
          } else {
            const errBody = await resp.text();
            console.warn("[DEEPSEEK] Request failed (" + resp.status + "): " + errBody + ". Falling back to Gemini...");
          }
        } catch (e: any) {
          console.warn("[DEEPSEEK] Exception during request: " + (e?.message || e) + ". Falling back to Gemini...");
        }
      }

      if (this.serverGeminiCooldownUntil > Date.now()) {
        return this.getStaticServerSideAiFallback(params, "Gemini API in cooldown due to access/quota status. Using local fallback.");
      }

      const ai = this.getInternalServerGeminiClient();
      if (ai) {
        try {
          // ЛЕГАСИ-МОДЕЛЬ: 'gemini-3.7-flash' обновлена на актуальную 'gemini-3.8-flash'
          const model = (params.model && !params.model.includes('gemini-3.7') && !params.model.includes('gemini-1.5') && !params.model.includes('gemini-2.0'))
            ? params.model
            : "gemini-3.8-flash";
          let response: any;
          try {
            response = await ai.models.generateContent({
              model,
              contents: params.contents,
              config: params.config
            });
          } catch (primaryErr: any) {
            const primaryMsg = primaryErr?.message || String(primaryErr);
            const is503OrOverloaded = primaryMsg.includes('503') || primaryMsg.includes('overloaded') || primaryMsg.includes('UNAVAILABLE');
            if (is503OrOverloaded && model !== 'gemini-flash-latest') {
              try {
                response = await ai.models.generateContent({
                  model: 'gemini-flash-latest',
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
          this.recordSuccessEvent();
          return { text: response?.text || "" };
        } catch (geminiErr: any) {
          const errMsg = geminiErr?.message || String(geminiErr);
          const isTransportOrNetwork = errMsg.includes('fetch failed') ||
            errMsg.includes('ETIMEDOUT') ||
            errMsg.includes('ENOTFOUND') ||
            errMsg.includes('ECONNREFUSED') ||
            errMsg.includes('ECONNRESET') ||
            errMsg.includes('timeout');

          const isOverloadedOrUnavailable = errMsg.includes('503') ||
            errMsg.includes('UNAVAILABLE') ||
            errMsg.includes('overloaded') ||
            errMsg.includes('temporarily unavailable');

          let statusSummary = "unavailable";
          if (errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED') || errMsg.includes('denied access')) {
            statusSummary = "cloud project access restricted (403)";
          } else if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
            statusSummary = "rate limit cooldown (429)";
          } else if (isOverloadedOrUnavailable) {
            statusSummary = "model temporarily overloaded (503)";
          } else if (errMsg.includes('404')) {
            statusSummary = "model deprecated / not found (404)";
          } else if (isTransportOrNetwork) {
            statusSummary = "network connection temporarily unavailable";
          } else {
            statusSummary = errMsg.length > 50 ? errMsg.slice(0, 50) + "..." : errMsg;
          }

          const shouldCooldown = errMsg.includes('403') ||
            errMsg.includes('PERMISSION_DENIED') ||
            errMsg.includes('denied access') ||
            errMsg.includes('429') ||
            errMsg.includes('RESOURCE_EXHAUSTED') ||
            isOverloadedOrUnavailable ||
            isTransportOrNetwork;

          if (shouldCooldown) {
            const cooldownDurationMs = (isTransportOrNetwork || isOverloadedOrUnavailable) ? 2 * 60 * 1000 : 10 * 60 * 1000;
            this.serverGeminiCooldownUntil = Date.now() + cooldownDurationMs;
            console.log(`[AI ENGINE] Switched to local quantum engine (cloud AI status: ${statusSummary}). Normal operation continues.`);
          } else {
            console.log("[AI ENGINE] Notice: " + statusSummary + ". Using local fallback.");
          }
          return this.getStaticServerSideAiFallback(params, statusSummary);
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
