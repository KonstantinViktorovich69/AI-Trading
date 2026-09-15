import express from 'express';
import type { Request, Response, Router } from 'express';
import { Type } from '@google/genai';

export interface KnowledgeRouterContext {
  getKnowledgeBase: () => any[];
  setKnowledgeBase: (kb: any[]) => void;
  saveKnowledgeDB: (rule: any) => Promise<void>;
  deleteKnowledgeDB: (id: string) => Promise<void>;
  getModelWeights: () => any;
  getModelStatus: () => any;
  runAiGeneration: (params: any) => Promise<any>;
  getArchivistPrompt: (rules: string, minSim: number, maxClusters: number) => string;
  getRuleTesterPrompt: (rule: string, symbol: string, side: string, entryPrice: number) => string;
  safeJsonParse: (json: string, fallback: any) => any;
  getJaccardSimilarity: (str1: string, str2: string) => number;
  runSmartArchivistCycle: (manual: boolean) => Promise<any>;
  runNewAIPerformanceOptimizationCircuit: (manual: boolean) => Promise<any>;
  getAgentExchangeLogs: () => any[];
  getCachedDB: () => any;
  requestDBSave: () => void;
  flushDB: () => void;
  syncToFirebase?: (db: any) => Promise<void>;
  getDb: () => any;
  isFirebaseFirestoreDisabled: boolean;
  OWNER_ID: string;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  getVirtualTrades: () => any[];
  getCommitteeVetoShadowStats: () => any;
  getMarketRegime: () => string;
  log400: (route: string, msg: string) => void;
}

export function createKnowledgeRouter(ctx: KnowledgeRouterContext): Router {
  const router = express.Router();

  // GET /api/knowledge
  router.get('/knowledge', (req: Request, res: Response) => {
    const kb = ctx.getKnowledgeBase();
    const learningInfo = {
      method: "SAR Peak Reversal & Volume Decay Analysis",
      base: "Historical comparison of successful short-scalps (Pump Fading)",
      active_rules: kb.length,
      status: "Online",
      last_update: Date.now()
    };
    res.json({
      success: true,
      data: kb,
      learning: learningInfo,
      signal_route: "Market Data -> CCXT/WS -> Patterns (SAR/VWAP/Shadow) -> Signal Engine -> SSE/Telegram",
      model: {
        weights: ctx.getModelWeights(),
        status: ctx.getModelStatus()
      }
    });
  });

  // POST /api/knowledge
  router.post('/knowledge', (req: Request, res: Response) => {
    const { rule, agent, image, filterIndicator, filterCondition, filterValue, filterAction, impact, successRate, usageCount } = req.body;
    if (rule && typeof rule === 'string') {
      const newRule: any = {
        id: `rule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        agent: agent || 'GENERAL',
        text: rule,
        image: image || undefined,
        filterIndicator: filterIndicator || undefined,
        filterCondition: filterCondition || undefined,
        filterValue: typeof filterValue === 'number' ? filterValue : undefined,
        filterAction: filterAction || undefined,
        impact: typeof impact === 'number' ? impact : undefined,
        successRate: typeof successRate === 'number' ? successRate : undefined,
        usageCount: typeof usageCount === 'number' ? usageCount : undefined
      };
      const kb = ctx.getKnowledgeBase();
      kb.push(newRule);
      ctx.saveKnowledgeDB(newRule);
      res.json({ success: true, data: kb });
    } else {
      ctx.log400('/api/knowledge', `Invalid rule format: ${typeof rule}`);
      res.status(400).json({ success: false, error: 'Invalid rule' });
    }
  });

  // DELETE /api/knowledge/:id
  router.delete('/knowledge/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const kb = ctx.getKnowledgeBase();
    const idx = kb.findIndex(r => r.id === id);
    if (idx >= 0) {
      kb.splice(idx, 1);
      ctx.deleteKnowledgeDB(id);
      res.json({ success: true, data: kb });
    } else {
      res.status(404).json({ success: false, error: 'Rule not found' });
    }
  });

  // POST /api/knowledge/rebalance
  router.post('/knowledge/rebalance', async (req: Request, res: Response) => {
    try {
      const kb = ctx.getKnowledgeBase();
      const currentRules = kb.map(r => `Agent: ${r.agent} | Impact: ${r.impact || 0} | SuccessRate: ${(r.successRate ?? 0.5).toFixed(2)} | Usage: ${r.usageCount || 0} | Rule: ${r.text}`).join('\n');

      if (kb.length === 0) {
        return res.json({ success: true, data: kb, msg: 'База знаний пуста, ребалансировка не требуется' });
      }

      const prompt = ctx.getArchivistPrompt(currentRules, 0.3, 5);

      const response = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                agent: { type: Type.STRING },
                text: { type: Type.STRING },
                impact: { type: Type.NUMBER }
              },
              required: ["agent", "text", "impact"]
            }
          }
        }
      });

      if (response.text) {
        const newRules = ctx.safeJsonParse(response.text, {});
        const activeRules = kb.filter(old => !old.isArchived);
        const activeRulesCopy = [...activeRules];

        for (const old of activeRules) {
          await ctx.deleteKnowledgeDB(old.id);
        }
        const remainingArchived = kb.filter(old => old.isArchived);
        ctx.setKnowledgeBase(remainingArchived);

        newRules.forEach((r: any) => {
          let totalWeights = 0;
          let weightedSRSum = 0;
          let totalUsage = 0;
          let matchedCount = 0;

          for (const old of activeRulesCopy) {
            const sim = ctx.getJaccardSimilarity(r.text, old.text);
            if (sim > 0.3) {
              const uc = old.usageCount || 0;
              const sr = old.successRate ?? 0.5;
              const weight = sim * (uc + 1);
              weightedSRSum += sr * weight;
              totalWeights += weight;
              totalUsage += uc;
              matchedCount++;
            }
          }

          const inheritedSR = matchedCount > 0 ? (weightedSRSum / totalWeights) : 0.6;
          const inheritedUC = matchedCount > 0 ? totalUsage : 1;

          const newRule: any = {
            id: `rule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}-${Math.floor(Math.random() * 1000)}`,
            agent: ['SCANNER', 'MANAGER', 'LONG_MANAGER', 'GENERAL'].includes(r.agent) ? r.agent : 'GENERAL',
            text: r.text,
            impact: Number(r.impact) || 0,
            successRate: Number(inheritedSR.toFixed(4)),
            usageCount: inheritedUC
          };
          ctx.getKnowledgeBase().push(newRule);
          ctx.saveKnowledgeDB(newRule);
        });
        res.json({ success: true, data: ctx.getKnowledgeBase() });
      } else {
        res.status(500).json({ success: false, error: 'Empty AI response' });
      }
    } catch (e: any) {
      const isQuota = e?.message?.includes("429") || e?.message?.includes("quota") || e?.message?.includes("Too Many");
      if (!isQuota) {
        console.warn("AI Rebalance Error:", e?.message || e);
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/knowledge/archive/:id
  router.post('/knowledge/archive/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const kb = ctx.getKnowledgeBase();
      const rule = kb.find(r => r.id === id);
      if (rule) {
        rule.isArchived = true;
        rule.archivedAt = new Date().toISOString();
        rule.archiveReason = reason || 'Ручная архивация пользователем';
        rule.marketRegimeAtArchive = ctx.getMarketRegime();
        await ctx.saveKnowledgeDB(rule);
        res.json({ success: true, data: kb });
      } else {
        res.status(404).json({ success: false, error: 'Rule not found' });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/knowledge/unarchive/:id
  router.post('/knowledge/unarchive/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const kb = ctx.getKnowledgeBase();
      const rule = kb.find(r => r.id === id);
      if (rule) {
        rule.isArchived = false;
        delete rule.archivedAt;
        delete rule.archiveReason;
        delete rule.marketRegimeAtArchive;
        await ctx.saveKnowledgeDB(rule);
        res.json({ success: true, data: kb });
      } else {
        res.status(404).json({ success: false, error: 'Rule not found' });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/knowledge/unarchive-all
  router.post('/knowledge/unarchive-all', async (req: Request, res: Response) => {
    try {
      let unarchivedCount = 0;
      const dbData = ctx.getCachedDB();
      const kb = ctx.getKnowledgeBase();
      for (const rule of kb) {
        if (rule.isArchived) {
          rule.isArchived = false;
          delete rule.archivedAt;
          delete rule.archiveReason;
          delete rule.marketRegimeAtArchive;

          const existingIndex = dbData.knowledge ? dbData.knowledge.findIndex((r: any) => r.id === rule.id) : -1;
          if (existingIndex !== -1 && dbData.knowledge) {
            dbData.knowledge[existingIndex] = { ...rule, userId: ctx.OWNER_ID };
          }
          unarchivedCount++;
        }
      }
      ctx.requestDBSave();
      res.json({ success: true, unarchivedCount, data: kb });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/knowledge/smart-audit
  router.post('/knowledge/smart-audit', async (req: Request, res: Response) => {
    try {
      const result = await ctx.runSmartArchivistCycle(true);
      res.json({ success: true, ...result, data: ctx.getKnowledgeBase() });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/knowledge/backtest
  router.post('/knowledge/backtest', async (req: Request, res: Response) => {
    const { rule } = req.body;
    if (!rule) return res.status(400).json({ success: false, error: 'Rule is required' });

    try {
      const virtualTrades = ctx.getVirtualTrades();
      const recentTrades = virtualTrades.filter(t => t.status === 'CLOSED').sort((a, b) => (b.closeTime || 0) - (a.openTime || 0)).slice(0, 5);

      if (recentTrades.length === 0) {
        return res.json({ success: true, message: 'Нет закрытых сделок для тестирования. Попробуйте поторговать в Симуляторе.' });
      }

      let avoidedLosses = 0;
      let missedProfits = 0;
      let analysisMsg = '';

      for (const trade of recentTrades) {
        const isProfitable = (trade.pnl || 0) > 0;
        const prompt = ctx.getRuleTesterPrompt(rule, trade.symbol, trade.side, trade.entryPrice);

        try {
          const response = await ctx.runAiGeneration({
            model: 'gemini-3.7-flash',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  wouldBlock: { type: Type.BOOLEAN },
                  reason: { type: Type.STRING }
                },
                required: ["wouldBlock", "reason"]
              }
            }
          });
          const ans = ctx.safeJsonParse(response.text, {});
          if (ans.wouldBlock) {
            if (isProfitable) missedProfits++;
            else avoidedLosses++;
            analysisMsg += `[${trade.symbol}]: Блокировка - ${ans.reason}\n`;
          } else {
            analysisMsg += `[${trade.symbol}]: Пропущено\n`;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }

      const report = `Влияние правила на последние 5 сделок:\nУбытков предотвращено: ${avoidedLosses}\nПрибылей упущено: ${missedProfits}\n\nЛог:\n${analysisMsg}`;
      res.json({ success: true, report });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/agent-exchange/logs
  router.get('/agent-exchange/logs', (req: Request, res: Response) => {
    res.json({ success: true, data: ctx.getAgentExchangeLogs() });
  });

  // GET /api/agent-exchange/reports
  router.get('/agent-exchange/reports', (req: Request, res: Response) => {
    const dbData = ctx.getCachedDB();
    res.json({ success: true, data: dbData.aiPerformanceReports || [] });
  });

  // GET /api/committee-veto-shadow-stats
  router.get('/committee-veto-shadow-stats', (req: Request, res: Response) => {
    res.json({ success: true, data: ctx.getCommitteeVetoShadowStats() });
  });

  // GET /api/ai-committee/stats
  router.get('/ai-committee/stats', (req: Request, res: Response) => {
    try {
      const dbData = ctx.getCachedDB();
      const history = dbData.aiCommitteeHistory || [];
      const now = Date.now();
      const last24h = history.filter((h: any) => now - h.timestamp <= 24 * 3600 * 1000);

      const stats = {
        totalRuns: last24h.length,
        bull: { LONG: 0, SHORT: 0, NEUTRAL: 0 } as Record<string, number>,
        bear: { LONG: 0, SHORT: 0, NEUTRAL: 0 } as Record<string, number>,
        judge: { LONG: 0, SHORT: 0, NEUTRAL: 0 } as Record<string, number>
      };

      last24h.forEach((h: any) => {
        const bullDec = (h.bullDecision || 'NEUTRAL').toUpperCase();
        const bearDec = (h.bearDecision || 'NEUTRAL').toUpperCase();
        const judgeDec = (h.judgeDecision || 'NEUTRAL').toUpperCase();

        if (stats.bull[bullDec] !== undefined) stats.bull[bullDec]++;
        else stats.bull.NEUTRAL++;

        if (stats.bear[bearDec] !== undefined) stats.bear[bearDec]++;
        else stats.bear.NEUTRAL++;

        if (stats.judge[judgeDec] !== undefined) stats.judge[judgeDec]++;
        else stats.judge.NEUTRAL++;
      });

      const hourlyHist = [];
      for (let i = 23; i >= 0; i--) {
        const startMs = now - (i + 1) * 3600 * 1000;
        const endMs = now - i * 3600 * 1000;

        const date = new Date(endMs);
        const label = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        const inHour = last24h.filter((h: any) => h.timestamp > startMs && h.timestamp <= endMs);
        const hStats: Record<string, number> = { LONG: 0, SHORT: 0, NEUTRAL: 0 };

        inHour.forEach((h: any) => {
          const jd = (h.judgeDecision || 'NEUTRAL').toUpperCase();
          if (hStats[jd] !== undefined) hStats[jd]++;
          else hStats.NEUTRAL++;
        });

        hourlyHist.push({
          time: label,
          LONG: hStats.LONG,
          SHORT: hStats.SHORT,
          NEUTRAL: hStats.NEUTRAL
        });
      }

      res.json({
        success: true,
        data: {
          stats,
          hourlyHist,
          recent: last24h.slice(-30).reverse()
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/agent-exchange/optimize
  router.post('/agent-exchange/optimize', async (req: Request, res: Response) => {
    try {
      const result = await ctx.runNewAIPerformanceOptimizationCircuit(true);
      res.json({ success: true, ...result, logs: ctx.getAgentExchangeLogs() });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/agent-exchange/clear
  router.post('/agent-exchange/clear', (req: Request, res: Response) => {
    const logs = ctx.getAgentExchangeLogs();
    logs.length = 0;
    const systemTimeNow = Date.now();
    logs.push({
      id: `seed_${Date.now()}`,
      timestamp: systemTimeNow,
      fromAgent: 'RETROSPECTIVE',
      toAgent: 'ALL',
      message: 'Логи обмена данными очищены',
      details: 'Очистка буфера выполнена пользователем. Начинается запись нового цикла совещаний.',
      type: 'info'
    });

    const dbData = ctx.getCachedDB();
    dbData.agentExchangeLogs = logs;
    ctx.flushDB();
    if (ctx.getDb() && !ctx.isFirebaseFirestoreDisabled && ctx.syncToFirebase) {
      ctx.syncToFirebase(dbData).catch(() => {});
    }

    ctx.streamEmitter.emit('signals_updated');
    res.json({ success: true, data: logs });
  });

  return router;
}
