import express from 'express';
import type { Request, Response, Router } from 'express';
import { Type } from '@google/genai';
import { RSI } from 'technicalindicators';
import ccxt, { Exchange } from 'ccxt';
import { MarketDataHubService, ensureExchangeMarket } from '../services/marketDataHubService.ts';
import { isWeexApiSupported } from '../data/defaultStrategyKnowledge.ts';

export interface AiRoutesContext {
  getGlobalSettings: () => any;
  getVirtualTrades: () => any[];
  getKnowledgeBase: () => any[];
  getSocialSentiment: () => any;
  getSignalsCache: () => any;
  runAiGeneration: (params: any) => Promise<any>;
  getSentinelShieldPrompt: (btc24: string, btc15: string, regime: string, health: number, fundingLimit: number, maxVol: number, sentiment: string) => string;
  getCommitteePrompt: (rules: string, dataStr: string) => string;
  getPositionManagerPrompt: (...args: any[]) => string;
  getSignalAnalysisPrompt: (signalJson: string, rules: string) => string;
  getTradeEvaluationPrompt: (...args: any[]) => string;
  getRuleTesterPrompt: (rule: string, symbol: string, side: string, entryPrice: number) => string;
  safeJsonParse: (json: string, fallback: any) => any;
  runDeterministicQuantCommitteeFallback: (data: any[]) => any;
  getBlacklistedPatterns: () => any;
  evaluateExitPolicy: (tradeSnapshot: any, marketSnapshot: any) => any;
  executePaperTradeCloseTransaction: (dbStore: any, params: any) => Promise<any>;
  dbAtomicStore: any;
  saveTradeDB: (trade: any, isUpdate?: boolean) => void;
  saveBalanceDB: () => void;
  sendTelegramMessage: (msg: string) => void;
  setRealTradeSlTpOnExchange: (symbol: string, side: string, stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  logStructured: (...args: any[]) => void;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  getVirtualBalance: () => number;
  setVirtualBalance: (val: number) => void;
  DEFAULT_BASELINE_EXPERT_INSTRUCTIONS: string;
  getPendingAiTasks: () => Map<string, any>;
  getCachedMarketNews: () => { text: string; timestamp: number } | null;
  setCachedMarketNews: (news: { text: string; timestamp: number } | null) => void;
  getOhlcvCache: () => Record<string, { data: any[]; timestamp: number }>;
  getPendingChartRequests: () => Record<string, Promise<any>>;
  getCcxtExchanges: () => Record<string, any>;
  getRestBlockedExchanges: () => Set<string>;
  formatFuturesSymbol: (sym: string, ex: string) => string;
  isWeexApiSupported?: (sym: string) => boolean;
  getGlobalRawOHLCV?: () => Record<string, Record<string, any[][]>>;
  getGlobalTrueOHLCV?: () => Record<string, any>;
}

export function createAiRoutes(ctx: AiRoutesContext): Router {
  const router = express.Router();

  // High-performance isolated CCXT clients for chart requests
  // WEEX is the exclusive execution exchange; Binance is used exclusively as a benchmark
  const chartCcxtClients: Record<string, Exchange> = {
    weex: new ccxt.weex({ enableRateLimit: false, timeout: 5000, headers: MarketDataHubService.WEEX_HEADERS }),
    binance: new ccxt.binance({ enableRateLimit: false, timeout: 5000 })
  };

  // GET /api/settings/default-instructions
  router.get('/settings/default-instructions', (req: Request, res: Response) => {
    res.json({ success: true, instructions: ctx.DEFAULT_BASELINE_EXPERT_INSTRUCTIONS });
  });

  // GET /api/debug-env
  router.get('/debug-env', (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.json({
      success: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      nextGeminiConfigured: Boolean(process.env.NEXT_PUBLIC_GEMINI_API_KEY)
    });
  });

  // GET /api/market/news
  router.get('/market/news', async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();
    const cached = ctx.getCachedMarketNews();

    if (cached && (now - cached.timestamp < 15 * 60 * 1000) && !forceRefresh) {
      return res.json({ success: true, text: cached.text, timestamp: cached.timestamp, fromCache: true });
    }

    try {
      const sentimentSnapshot = ctx.getSocialSentiment() || {};
      const signalsCache = ctx.getSignalsCache();
      const btc24 = signalsCache?.btcTrend24h || 0.0;
      const btc15 = signalsCache?.btcTrend15m || 0.0;
      const regime = signalsCache?.marketRegime || 'FLAT';
      const health = signalsCache?.marketHealth || 50;
      const globalSettings = ctx.getGlobalSettings();

      const sentimentDetails = Object.entries(sentimentSnapshot)
        .map(([sym, data]: [string, any]) => {
          return `- **${sym}**: Сентимент: ${data.score}/100, Упоминаний: ${data.mentions}, Тренд: ${data.trend || 'NEUTRAL'}`;
        })
        .slice(0, 15)
        .join('\n');

      const btc24Formatted = btc24.toFixed(2);
      const btc15Formatted = btc15.toFixed(2);
      const sentimentDetailsFormatted = sentimentDetails || "Данные сентимента отсутствуют";

      const systemPrompt = ctx.getSentinelShieldPrompt(
        btc24Formatted,
        btc15Formatted,
        regime,
        health,
        globalSettings.fundingShieldLimit,
        globalSettings.maxVolatilityLimit,
        sentimentDetailsFormatted
      );

      const response = await ctx.runAiGeneration({
        contents: [
          { role: 'system', parts: [{ text: systemPrompt }] },
          { role: 'user', parts: [{ text: "Сгенерируй актуальный крипто-бюллетень Sentinel Shield в формате Markdown на русском языке." }] }
        ],
        config: {
          temperature: 0.7
        }
      });

      const newsText = response?.text || "Ошибка генерации бюллетеня Sentinel Shield. Попробуйте обновить позже.";
      ctx.setCachedMarketNews({
        text: newsText,
        timestamp: now
      });

      res.json({ success: true, text: newsText, timestamp: now, fromCache: false });
    } catch (err: any) {
      console.error(`[NEWS] Error generating market bulletin:`, err);
      res.status(500).json({ success: false, error: err.message, fallbackText: "Не удалось получить свежие новости от Sentinel Shield. Попробуйте обновить." });
    }
  });

  // GET /api/ai-tasks/pending
  router.get('/ai-tasks/pending', (req: Request, res: Response) => {
    const now = Date.now();
    const tasksToSend: any[] = [];
    const pendingAiTasks = ctx.getPendingAiTasks();

    for (const [id, task] of pendingAiTasks.entries()) {
      if (task.status === 'pending' || (task.status === 'processing' && task.processedAt && (now - task.processedAt > 60000))) {
        task.status = 'processing';
        task.processedAt = now;
        tasksToSend.push({ id, params: task.params });

        if (tasksToSend.length >= 2) break;
      }
    }

    res.json({ success: true, tasks: tasksToSend });
  });

  // POST /api/ai-tasks/complete
  router.post('/ai-tasks/complete', (req: Request, res: Response) => {
    const { id, result, error } = req.body;
    const pendingAiTasks = ctx.getPendingAiTasks();
    const task = pendingAiTasks.get(id);
    if (task) {
      if (error) {
        task.reject(new Error(error));
      } else {
        task.resolve(result);
      }
      pendingAiTasks.delete(id);
    }
    res.json({ success: true });
  });

  // GET /api/patterns/blacklist
  router.get('/patterns/blacklist', (req: Request, res: Response) => {
    try {
      const blacklist = ctx.getBlacklistedPatterns();
      res.json({ success: true, blacklist, patterns: Object.keys(blacklist) });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'Failed to retrieve pattern blacklist' });
    }
  });

  // POST /api/ai-run-scanner
  router.post('/ai-run-scanner', async (req: Request, res: Response) => {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.json({ success: true, result: [] });
    }

    try {
      if (process.env.OFFLINE_MODE === '1' || !process.env.GEMINI_API_KEY) {
        const fallbackResults = ctx.runDeterministicQuantCommitteeFallback(data);
        return res.json({ success: true, result: fallbackResults, fallback: true });
      }

      const kb = ctx.getKnowledgeBase();
      const rules = kb.filter(r => !r.isArchived).map(r => r.text).join('\n');
      const prompt = ctx.getCommitteePrompt(rules, JSON.stringify(data));
      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      });

      const parsed = ctx.safeJsonParse(response.text, null);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return res.json({ success: true, result: parsed, fallback: false });
      }

      const fallbackResults = ctx.runDeterministicQuantCommitteeFallback(data);
      res.json({ success: true, result: fallbackResults, fallback: true });
    } catch (err: any) {
      const fallbackResults = ctx.runDeterministicQuantCommitteeFallback(data);
      res.json({ success: true, result: fallbackResults, fallback: true });
    }
  });

  // POST /api/paper-trade/ai-analyze
  router.post('/paper-trade/ai-analyze', async (req: Request, res: Response) => {
    const { id, currentPrice, pnlPct, pnlUsd } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing trade id' });
    }

    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) {
      return res.status(404).json({ success: false, error: 'Paper trade not found' });
    }

    const safePrice = Number(currentPrice) || Number(trade.currentPrice) || Number(trade.entryPrice);
    const safePnlPct = pnlPct !== undefined ? Number(pnlPct) : 0;
    const safePnlUsd = pnlUsd !== undefined ? Number(pnlUsd) : 0;

    try {
      let decisionAction: 'HOLD' | 'CLOSE' | 'DCA' | 'UPDATE_SL' = 'HOLD';
      let decisionAdvice = 'Позиция удерживается в рамках расчетного диапазона волатильности.';
      let newSl: number | undefined;

      if (process.env.OFFLINE_MODE !== '1' && process.env.GEMINI_API_KEY) {
        try {
          const kb = ctx.getKnowledgeBase();
          const rules = kb.filter(r => !r.isArchived).map(r => r.text).join('\n');
          const historyJson = JSON.stringify({
            highestPnlPct: (trade as any).highestPnlPct || 0,
            lowestPnlPct: (trade as any).lowestPnlPct || 0,
            dcaCount: (trade as any).dcaCount || 0,
            strategy: (trade as any).strategyId || 'QUANT_SCALP'
          });
          const prompt = ctx.getPositionManagerPrompt(
            trade.side,
            trade.symbol,
            rules,
            trade.entryPrice,
            safePrice,
            trade.leverage,
            trade.amount,
            safePnlUsd.toFixed(2),
            safePnlPct.toFixed(2),
            trade.mode || 'SEMI_AUTO',
            historyJson
          );

          const response = await ctx.runAiGeneration({
            model: 'gemini-3.7-flash',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              responseMimeType: 'application/json',
              temperature: 0.2
            }
          });

          const parsed = ctx.safeJsonParse(response.text, null);
          if (parsed && parsed.action) {
            decisionAction = parsed.action;
            decisionAdvice = parsed.advice || decisionAdvice;
            newSl = parsed.newSl;
          }
        } catch {
          // Fallback to deterministic exit policy below
        }
      }

      const tradeSnapshot = {
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        amount: trade.amount,
        leverage: trade.leverage || 10,
        createdAt: trade.openTime || Date.now(),
        highestPrice: (trade as any).highestPrice || trade.entryPrice,
        lowestPrice: (trade as any).lowestPrice || trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        pnl: safePnlUsd,
        pnlPercent: safePnlPct
      };
      const marketSnapshot = {
        currentPrice: safePrice,
        bid: safePrice,
        ask: safePrice
      };

      if (decisionAction === 'HOLD') {
        const exitEvaluation = ctx.evaluateExitPolicy(tradeSnapshot, marketSnapshot);
        if (exitEvaluation.kind === 'FULL_CLOSE' || exitEvaluation.kind === 'EMERGENCY_FULL_CLOSE') {
          decisionAction = 'CLOSE';
          decisionAdvice = `Срабатывание защитного протокола: ${exitEvaluation.reasonText || exitEvaluation.reasonCode}`;
        } else if (exitEvaluation.kind === 'MOVE_STOP') {
          decisionAction = 'UPDATE_SL';
          decisionAdvice = `Подтягивание стоп-лосса для защиты позиции (+${safePnlPct.toFixed(2)}%)`;
          newSl = exitEvaluation.newStopLoss;
        }
      }

      let isClosed = false;
      if (decisionAction === 'CLOSE') {
        const closeEventId = `close_ai_${Date.now()}_${trade.id}`;
        const closeResult = await ctx.executePaperTradeCloseTransaction(ctx.dbAtomicStore, {
          tradeId: trade.id,
          closeEventId,
          closeRatio: 1.0,
          pnl: safePnlUsd,
          isFullClose: true
        });
        if (closeResult && closeResult.success) {
          isClosed = true;
        }
      }

      trade.lastAiCheck = Date.now();
      ctx.saveTradeDB(trade, true);

      res.json({
        success: true,
        tradeClosed: isClosed,
        result: {
          action: decisionAction,
          advice: decisionAdvice,
          newSl
        },
        trade
      });
    } catch (err: any) {
      res.json({
        success: true,
        tradeClosed: false,
        result: {
          action: 'HOLD',
          advice: 'Позиция в безопасной зоне (квант-контроль).'
        },
        trade
      });
    }
  });

  // POST /api/ai-analyze-signal
  router.post('/ai-analyze-signal', async (req: Request, res: Response) => {
    const { signal } = req.body;

    try {
      const kb = ctx.getKnowledgeBase();
      const rules = kb.filter(r => !r.isArchived).map(r => r.text).join('\n');
      const signalJson = JSON.stringify(signal);
      const prompt = ctx.getSignalAnalysisPrompt(signalJson, rules);

      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      });

      const parsed = ctx.safeJsonParse(response.text, {
        techAnalyst: "Ошибка парсинга",
        riskManager: "Ошибка парсинга",
        consensus: "АВТО-HOLD",
        judgeDecision: "NEUTRAL",
        consensusReason: "Сбой ИИ анализа",
        aiScore: 0,
        approved: false
      });

      res.json({ success: true, result: parsed });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/ai-evaluate-closed-trade
  router.post('/ai-evaluate-closed-trade', async (req: Request, res: Response) => {
    const { trade, currentPrice, pnlPct, pnlUsd, reason } = req.body;
    try {
      const safePnlUsd = pnlUsd !== undefined && pnlUsd !== null ? pnlUsd : 0;
      const safePnlPct = pnlPct !== undefined && pnlPct !== null ? pnlPct : 0;

      const evalPrompt = ctx.getTradeEvaluationPrompt(
        trade.symbol,
        trade.side,
        trade.entryPrice,
        currentPrice,
        safePnlPct,
        safePnlUsd,
        reason
      );

      let responseText = "";
      try {
        const response = await ctx.runAiGeneration({
          model: "gemini-3.7-flash",
          contents: [{ role: 'user', parts: [{ text: evalPrompt }] }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.7
          }
        });
        if (response && response.text) responseText = response.text;
      } catch (err: any) {
        console.warn("[/api/ai-evaluate-closed-trade] Gemini API quota limited. Generating Quantitative Trade Evaluation.");
      }

      const result = ctx.safeJsonParse(responseText, {});

      if (!result.evaluation || result.evaluation.includes("AI недоступен") || result.evaluation.includes("кулдаун")) {
        const isWin = safePnlPct > 0;
        const isBreakeven = Math.abs(safePnlPct) < 0.2;
        const sideStr = trade.side === 'SHORT' ? 'ШОРТ' : 'ЛОНГ';

        if (isBreakeven) {
          result.evaluation = `Позиция ${sideStr} по ${trade.symbol} закрыта в безубыток. Активирована динамическая защита капитала при откатном движении.`;
          result.learnedRule = `При затухании импульса переводить стоп-лосс в безубыток без риска для баланса.`;
        } else if (isWin) {
          result.evaluation = `Сделка ${sideStr} по ${trade.symbol} закрыта с прибылью (+${safePnlPct.toFixed(2)}%). Использована фиксация профита на импульсе по сигналу ${reason || 'квант-алгоритма'}.`;
          result.learnedRule = `Фиксировать прибыль на локальных экстремумах при ослаблении объемов торгов.`;
        } else {
          result.evaluation = `Сделка ${sideStr} по ${trade.symbol} закрыта с ограничением убытка (${safePnlPct.toFixed(2)}%). Риск-менеджер купировал просадку согласно лимиту защиты депозита.`;
          result.learnedRule = `При выходе цены за локальный уровень поддержки закрывать позицию для сохранения маржи.`;
        }
      }

      res.json({ success: true, result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/paper-trade/ai-update
  router.post('/paper-trade/ai-update', (req: Request, res: Response) => {
    const { id, advice, action, currentPrice, pnlPct, pnlUsd, newSl } = req.body;
    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    trade.aiAdvice = advice;
    trade.lastAiCheck = Date.now();

    if (trade.mode === 'AUTO' && action === 'CLOSE') {
      if (pnlPct > 0 && pnlPct < 7.5) {
        console.log(`[AI GUARD] AI requested CLOSE on profit of only ${pnlPct.toFixed(2)}% for ${trade.symbol}. Overridden to HOLD.`);
        trade.aiAdvice = `Запрет на микро-закрытия (${pnlPct.toFixed(2)}%): ИИ рекомендовал закрыть сделку, но система удержала ее, ожидая более сильный профит.`;
      } else {
        trade.status = 'CLOSED';
        trade.closeTime = Date.now();
        trade.closePrice = currentPrice;
        trade.feedback = pnlPct > 0 ? 'SUCCESS' : (pnlPct < 0 ? 'FAILED' : 'BREAKEVEN');
        trade.notes = `Auto-closed by AI (${trade.mode}). Reason: ${advice}`;
        if (!trade.history) trade.history = [];
        trade.history.push({ time: Date.now(), type: 'CLOSE', price: currentPrice, amount: trade.amount });
        trade.pnlPercent = pnlPct;
        trade.pnl = pnlUsd;
        if (!(trade as any).isAutoLearning && !trade.isReal) {
          const tradeMargin = (trade as any).margin || (trade as any).initialMargin || (trade.amount ? trade.amount / (trade.leverage || 1) : 0);
          ctx.setVirtualBalance(Number((ctx.getVirtualBalance() + tradeMargin + trade.pnl).toFixed(2)));
          ctx.saveBalanceDB();
        }
        if (trade.isReal) {
          ctx.sendTelegramMessage(`🤖 <b>AI Manager: Closed Trade (${trade.mode})</b>\n\nSymbol: ${trade.symbol}\nSide: ${trade.side}\nExit: $${currentPrice}\nPnL: ${trade.pnl > 0 ? '+' : ''}${trade.pnl?.toFixed(2)} USDT\nReason: ${advice}`);
        }
      }
    } else if (trade.mode === 'AUTO' && action === 'DCA') {
      const dcaAmount = trade.amount * 0.5;
      const tradeLeverage = Math.max(1, Number(trade.leverage || 1));
      const dcaMargin = Number((dcaAmount / tradeLeverage).toFixed(2));
      const oldEntry = trade.entryPrice;
      const currentCoins = trade.amount / oldEntry;
      const newCoins = dcaAmount / currentPrice;
      const totalMargin = trade.amount + dcaAmount;
      const totalCoins = currentCoins + newCoins;
      const newEntryPrice = totalMargin / totalCoins;

      if (trade.takeProfit) {
        trade.takeProfit = Number((newEntryPrice * (trade.takeProfit / oldEntry)).toFixed(5));
      }
      if (trade.stopLoss) {
        trade.stopLoss = Number((newEntryPrice * (trade.stopLoss / oldEntry)).toFixed(5));
      }
      if (trade.tpStages) {
        trade.tpStages.forEach((stage: any) => {
          stage.targetPrice = Number((newEntryPrice * (stage.targetPrice / oldEntry)).toFixed(5));
        });
      }

      trade.entryPrice = newEntryPrice;
      trade.amount = totalMargin;
      trade.margin = Number(((trade.margin || (trade.amount / tradeLeverage)) + dcaMargin).toFixed(2));
      trade.initialMargin = trade.margin;
      if (!trade.history) trade.history = [];
      trade.history.push({ time: Date.now(), type: 'AVERAGE', price: currentPrice, amount: dcaAmount, margin: dcaMargin });
      if (!(trade as any).isAutoLearning) {
        ctx.setVirtualBalance(Number((ctx.getVirtualBalance() - dcaMargin).toFixed(2)));
        ctx.saveBalanceDB();
      }

      const isRealLabel = trade.isReal ? "REAL" : "VIRTUAL";
      ctx.logStructured(
        'info',
        'AUTOPILOT',
        `AI Manager executed DCA (${isRealLabel}) for ${trade.symbol}. Added Margin: $${dcaAmount.toFixed(2)} USDT at price $${currentPrice.toFixed(5)}. New average entry: $${trade.entryPrice.toFixed(5)}.`,
        trade.symbol,
        { tradeId: trade.id, amount: dcaAmount, price: currentPrice, newEntry: trade.entryPrice, isReal: trade.isReal }
      );
      if (trade.isReal) {
        ctx.sendTelegramMessage(`🤖 <b>AI Manager: Executed DCA (${trade.mode})</b>\n\nSymbol: ${trade.symbol}\nPrice: $${currentPrice}\nNew Entry: $${trade.entryPrice.toFixed(5)}\nNew TP: $${trade.takeProfit?.toFixed(5)}`);
        trade.isExchangeSlTpSynced = false;
        trade.needsSlTpSync = true;
        ctx.saveTradeDB(trade);
        ctx.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit)
          .then(success => {
            if (success) {
              trade.isExchangeSlTpSynced = true;
              trade.needsSlTpSync = false;
              ctx.saveTradeDB(trade);
              console.log(`[AI UPDATE DCA REAL SL/TP SYNC] Inline sync succeeded for ${trade.symbol}`);
            }
          })
          .catch(err => {
            console.log(`[AI UPDATE DCA REAL SL/TP SYNC ERR]:`, err.message);
          });
      }
    } else if (trade.mode === 'AUTO' && action === 'UPDATE_SL' && newSl) {
      const oldSl = trade.stopLoss;
      trade.stopLoss = newSl;

      if (!trade.history) trade.history = [];
      trade.history.push({
        time: Date.now(),
        type: 'ADJUST_SL_TP',
        price: newSl,
        amount: trade.takeProfit || 0,
        notes: advice || `ИИ-Менеджер скорректировал Stop Loss`
      });

      const isRealLabel = trade.isReal ? "REAL" : "VIRTUAL";
      ctx.logStructured(
        'info',
        'AUTOPILOT',
        `AI Manager adjusted SL (${isRealLabel}) for ${trade.symbol}: SL $${oldSl || 'N/A'} ➡️ $${newSl}. Reason: ${advice}`,
        trade.symbol,
        { tradeId: trade.id, stopLoss: newSl, oldSl, isReal: trade.isReal }
      );

      if (trade.isReal) {
        ctx.sendTelegramMessage(`🤖 <b>AI Manager: Adjusted Stop Loss</b>\n\nSymbol: ${trade.symbol}\nStop Loss: $${oldSl || 'N/A'} ➡️ <b>$${newSl}</b>\nTake Profit: <b>$${trade.takeProfit}</b>\n\n💬 ${advice}`);
      }
    } else if (trade.mode === 'SEMI_AUTO' && trade.lastAiAction !== action && (action === 'CLOSE' || action === 'DCA' || action === 'UPDATE_SL')) {
      trade.lastAiAction = action;
      const typeStr = action === 'CLOSE' ? 'ЗАКРЫТЬ' : action === 'DCA' ? 'УСРЕДНИТЬ' : 'СТОП ЛОСС';
      if (trade.isReal) {
        ctx.sendTelegramMessage(`🤖 <b>AI Manager: РЕКОМЕНДАЦИЯ (ПОЛУАВТО)</b>\n\nМонета: ${trade.symbol}\nДействие: <b>${typeStr}</b>\nЦена: $${currentPrice}\n\n📝 ${advice}`);
      }
    }
    ctx.saveTradeDB(trade);
    ctx.streamEmitter.emit('signals_updated');
    res.json({ success: true, data: trade, balance: ctx.getVirtualBalance() });
  });

  // POST /api/paper-trade/update-state
  router.post('/paper-trade/update-state', (req: Request, res: Response) => {
    const { id, highestPrice, lowestPrice, trailingStopActive, stopLoss, takeProfit, tpStages, aiEvaluation, feedback, notes, closePrice, pnl, pnlPercent, outcome } = req.body;
    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });

    if (highestPrice !== undefined) trade.highestPrice = highestPrice;
    if (lowestPrice !== undefined) trade.lowestPrice = lowestPrice;
    if (trailingStopActive !== undefined) trade.trailingStopActive = trailingStopActive;
    if (stopLoss !== undefined) trade.stopLoss = stopLoss;
    if (takeProfit !== undefined) trade.takeProfit = takeProfit;
    if (tpStages !== undefined) trade.tpStages = tpStages;
    if (aiEvaluation !== undefined) trade.aiEvaluation = aiEvaluation;
    if (feedback !== undefined) trade.feedback = feedback;
    if (notes !== undefined) trade.notes = notes;
    if (closePrice !== undefined) trade.closePrice = closePrice;
    if (pnl !== undefined) trade.pnl = pnl;
    if (pnlPercent !== undefined) trade.pnlPercent = pnlPercent;
    if (outcome !== undefined) trade.outcome = outcome;

    ctx.saveTradeDB(trade);
    if (trade.isReal && (stopLoss !== undefined || takeProfit !== undefined)) {
      trade.isExchangeSlTpSynced = false;
      trade.needsSlTpSync = true;
      ctx.saveTradeDB(trade);
      ctx.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit)
        .then(success => {
          if (success) {
            trade.isExchangeSlTpSynced = true;
            trade.needsSlTpSync = false;
            ctx.saveTradeDB(trade);
          }
        })
        .catch(err => {
          console.log('[REAL SL/TP SYS SYNC ERR]:', err.message);
        });
    }
    ctx.streamEmitter.emit('signals_updated');
    res.json({ success: true, data: trade });
  });

  // POST /api/backtest
  router.post('/backtest', async (req: Request, res: Response) => {
    const { targets } = req.body;

    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ success: false, error: 'Нет монет для бэктеста' });
    }

    try {
      let totalTrades = 0;
      let totalWins = 0;
      let totalPnLPercent = 0;
      let minPnL = 0;
      let currentPnLPercent = 0;

      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const activeExchanges: Record<string, Exchange> = {};

      for (const target of targets) {
        let symbol = target.symbol;
        const exchangeName = (target.exchange || 'binance').toLowerCase();

        if (!symbol.includes('/')) symbol = symbol.replace('USDT', '/USDT');

        try {
          if (!activeExchanges[exchangeName]) {
            const exClass = (ccxt as any)[exchangeName];
            if (exClass) {
              activeExchanges[exchangeName] = new exClass({ enableRateLimit: true });
            } else {
              console.error(`Backtest: Exchange ${exchangeName} not found in CCXT`);
              continue;
            }
          }

          const currentExchange = activeExchanges[exchangeName];
          const ohlcv = await currentExchange.fetchOHLCV(symbol, '1h', since, 200);
          if (ohlcv.length < 20) continue;

          const closes = ohlcv.map(candle => candle[4] as number);
          const rsiValues = RSI.calculate({ values: closes, period: 14 });

          let inPosition = false;
          let entryPrice = 0;

          for (let i = 14; i < closes.length; i++) {
            const currentRSI = rsiValues[i - 14];
            const price = closes[i];

            if (!inPosition) {
              const prevClose10 = closes[Math.max(0, i - 10)];
              const pump = prevClose10 > 0 ? ((price - prevClose10) / prevClose10) * 100 : 0;

              if (currentRSI > 75 && pump > 5) {
                inPosition = true;
                entryPrice = price;
              }
            } else {
              const currentDrop = ((entryPrice - price) / entryPrice) * 100;
              const currentPumpFromEntry = ((price - entryPrice) / entryPrice) * 100;

              if (currentDrop >= 3) {
                totalTrades++;
                totalWins++;
                totalPnLPercent += 3;
                currentPnLPercent += 3;
                inPosition = false;
              } else if (currentPumpFromEntry >= 2) {
                totalTrades++;
                totalPnLPercent -= 2;
                currentPnLPercent -= 2;
                inPosition = false;
              }
              if (currentPnLPercent < minPnL) minPnL = currentPnLPercent;
            }
          }
        } catch (e) {
          console.error('Backtest fetch error for symbol:', symbol, e);
        }
      }

      const leverage = 5;
      totalPnLPercent *= leverage;
      minPnL *= leverage;

      res.json({
        success: true,
        results: {
          pnl: parseFloat(totalPnLPercent.toFixed(2)),
          winRate: totalTrades > 0 ? parseFloat(((totalWins / totalTrades) * 100).toFixed(2)) : 0,
          totalTrades,
          maxDrawdown: parseFloat(Math.abs(minPnL).toFixed(2))
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: 'Ошибка расчетов: ' + error.message });
    }
  });

  // GET /api/chart/:exchange/:symbol*
  router.get('/chart/:exchange/:symbol*', async (req: Request, res: Response) => {
    let { exchange } = req.params;
    const globalSettings = ctx.getGlobalSettings();
    if (exchange && exchange.toLowerCase() === 'real') {
      const config = globalSettings.exchangeApiConfig;
      exchange = (config && config.isEnabled && config.exchange) ? config.exchange : 'weex';
    }

    const p = req.params as any;
    const rawSymbol = (p.symbol || '') + (p[0] || '');
    const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
    const tf = timeframes.includes(req.query.tf as string) ? (req.query.tf as string) : '15m';

    let realSymbol = decodeURIComponent(rawSymbol).trim();
    if (!realSymbol.includes('/')) {
      const matches = realSymbol.match(/^([A-Z0-9]+)(USDT)$/i);
      if (matches) realSymbol = `${matches[1].toUpperCase()}/${matches[2].toUpperCase()}`;
      else if (!realSymbol.includes(':')) realSymbol = realSymbol + '/USDT';
    }

    const baseToken = realSymbol.split(/[\/:-]/)[0].toUpperCase();
    const cleanSym = `${baseToken}USDT`;
    const reqEx = (exchange || 'weex').toLowerCase();

    const cacheKey = `${reqEx}_${realSymbol}_${tf}`;
    const now = Date.now();
    const ohlcvCache = ctx.getOhlcvCache();
    const pendingChartRequests = ctx.getPendingChartRequests();

    // 1. Direct memory cache hit (TTL 60s for live chart freshness)
    if (ohlcvCache[cacheKey] && (now - ohlcvCache[cacheKey].timestamp < 60000)) {
      return res.json({ success: true, data: ohlcvCache[cacheKey].data });
    }

    // 2. Instant memory hit from background scanner (0ms latency!)
    const globalRaw = ctx.getGlobalRawOHLCV?.();
    if (globalRaw) {
      const candArray = globalRaw[cleanSym]?.[tf] || globalRaw[baseToken]?.[tf];
      if (Array.isArray(candArray) && candArray.length >= 10) {
        const formatted = candArray.map((c: any) => ({
          time: Math.floor(c[0] / 1000),
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5]
        }));
        ohlcvCache[cacheKey] = { data: formatted, timestamp: now };
        return res.json({ success: true, data: formatted });
      }
    }

    // 3. In-flight request deduplication
    if (pendingChartRequests[cacheKey]) {
      try {
        const data = await pendingChartRequests[cacheKey];
        return res.json({ success: true, data });
      } catch (e) {
        // Fallback to fetchTask
      }
    }

    const fetchTask = async () => {
      const restBlockedExchanges = ctx.getRestBlockedExchanges();

      // WEEX is the exclusive execution exchange; Binance is used solely as liquidity/candle benchmark
      const candidateExchanges = ['weex', 'binance']
        .filter((val) => !restBlockedExchanges.has(val));

      let lastError: any = null;
      for (const exName of candidateExchanges) {
        const curEx = chartCcxtClients[exName] || (ctx.getCcxtExchanges() && ctx.getCcxtExchanges()[exName]);
        if (!curEx) continue;

        // Resolve symbol specifically for this exchange
        let curSymbol = realSymbol;
        if (exName === 'weex') {
          curSymbol = ctx.formatFuturesSymbol(realSymbol, 'weex');
        } else {
          // Binance benchmark format: BTC/USDT
          curSymbol = realSymbol.split(':')[0];
          if (!curSymbol.includes('/')) curSymbol = `${curSymbol}/USDT`;
        }

        // CRITICAL: Pre-seed market on CCXT instance to prevent slow loadMarkets() network downloads
        ensureExchangeMarket(curEx, curSymbol);

        try {
          // Strict 3800ms timeout per exchange so chart never hangs
          const fetchPromise = curEx.fetchOHLCV(curSymbol, tf, undefined, 100);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Fetch timed out after 3800ms on ${exName}`)), 3800));
          const ohlcv: any = await Promise.race([fetchPromise, timeoutPromise]);

          if (Array.isArray(ohlcv) && ohlcv.length > 0) {
            const formatted = ohlcv.map((c: any) => ({
              time: Math.floor(c[0] / 1000),
              open: c[1],
              high: c[2],
              low: c[3],
              close: c[4],
              volume: c[5]
            }));

            // Multi-key caching for instant subsequent hits
            ohlcvCache[cacheKey] = { data: formatted, timestamp: Date.now() };
            ohlcvCache[`${exName}_${curSymbol}_${tf}`] = { data: formatted, timestamp: Date.now() };
            ohlcvCache[`${reqEx}_${baseToken}USDT_${tf}`] = { data: formatted, timestamp: Date.now() };
            ohlcvCache[`${reqEx}_${baseToken}/USDT_${tf}`] = { data: formatted, timestamp: Date.now() };

            // Persist into memory store
            if (globalRaw) {
              if (!globalRaw[cleanSym]) (globalRaw as any)[cleanSym] = {};
              (globalRaw as any)[cleanSym][tf] = ohlcv;
            }

            console.log(`[CHART] Successfully fetched ${ohlcv.length} candles for ${curSymbol} (${tf}) via ${exName}`);
            return formatted;
          }
        } catch (err: any) {
          lastError = err;
          const msg = err.message || '';
          if (msg.includes('-1142') || msg.includes("Parameter 'symbol' is invalid") || msg.includes('does not have market symbol') || msg.includes('symbol not found')) {
            console.debug(`[CHART] Symbol ${curSymbol} not available on ${exName} (${msg.slice(0, 80)}), trying fallback exchange...`);
          } else {
            console.warn(`[CHART] Attempt on ${exName} for ${curSymbol} failed: ${msg.slice(0, 100)}`);
          }
          if (msg.includes('451') || msg.includes('Unavailable For Legal Reasons') || msg.includes('restricted') || msg.includes('Cloudflare') || msg.includes('403')) {
            restBlockedExchanges.add(exName);
          }
        }
      }

      throw lastError || new Error(`Could not fetch candles for ${realSymbol} (${tf}) from any available exchange.`);
    };

    try {
      pendingChartRequests[cacheKey] = fetchTask();
      const data = await pendingChartRequests[cacheKey];
      delete pendingChartRequests[cacheKey];
      res.json({ success: true, data });
    } catch (e: any) {
      delete pendingChartRequests[cacheKey];
      console.error(`[CHART ERROR] Failed to fetch chart data for ${rawSymbol} (${tf}):`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}
