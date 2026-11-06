/**
 * @file timeMachineRoutes.ts
 * API маршруты для сервиса «Машина времени», бэктестинга и ретроспективного проигрывания сделок.
 */

import express, { Request, Response, Router } from 'express';
import { runTimeMachineBatch, simulateTradeAlternatives, type TimeMachineBatchSummary } from '../services/timeMachineService.ts';

export interface TimeMachineRouterContext {
  getVirtualTrades: () => any[];
  getGlobalTrueOhlcv: () => Record<string, any>;
  getAiKnowledgeBase: () => any[];
  saveKnowledgeDB: (rule: any, immediate?: boolean) => void;
  emitSignalsUpdated?: () => void;
}

export function createTimeMachineRouter(ctx: TimeMachineRouterContext): Router {
  const router = express.Router();
  let cachedSummary: TimeMachineBatchSummary | null = null;
  let lastSimulatedTime = 0;

  // GET /api/time-machine/summary
  router.get('/time-machine/summary', (req: Request, res: Response) => {
    try {
      const now = Date.now();
      const trades = ctx.getVirtualTrades();
      const ohlcvMap = ctx.getGlobalTrueOhlcv();

      // Кэшируем вычисления на 30 секунд для предотвращения нагрузки на процессор
      if (cachedSummary && now - lastSimulatedTime < 30000) {
        return res.json({
          success: true,
          data: cachedSummary,
          cached: true
        });
      }

      const { analyses, summary } = runTimeMachineBatch(trades, ohlcvMap);
      cachedSummary = summary;
      lastSimulatedTime = now;

      res.json({
        success: true,
        data: summary,
        analysesSample: analyses.slice(0, 20),
        cached: false
      });
    } catch (err: any) {
      console.error('[TIME_MACHINE_API_ERROR]', err?.message || err);
      res.status(500).json({ success: false, error: err?.message || 'Failed to run Time Machine summary' });
    }
  });

  // GET /api/time-machine/trade/:id
  router.get('/time-machine/trade/:id', (req: Request, res: Response) => {
    try {
      const tradeId = req.params.id;
      const trades = ctx.getVirtualTrades();
      const targetTrade = trades.find(t => t.id === tradeId);

      if (!targetTrade) {
        return res.status(404).json({ success: false, error: `Trade ${tradeId} not found` });
      }

      const ohlcvMap = ctx.getGlobalTrueOhlcv();
      const cleanSym = (targetTrade.symbol || '').replace(/[\/:]/g, '').toUpperCase();
      const candles = ohlcvMap[cleanSym] || ohlcvMap[targetTrade.symbol] || [];

      const analysis = simulateTradeAlternatives(targetTrade, candles);

      res.json({
        success: true,
        data: analysis
      });
    } catch (err: any) {
      console.error('[TIME_MACHINE_TRADE_ERROR]', err?.message || err);
      res.status(500).json({ success: false, error: err?.message || 'Failed to simulate trade' });
    }
  });

  // POST /api/time-machine/apply-learnings
  router.post('/time-machine/apply-learnings', (req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades();
      const ohlcvMap = ctx.getGlobalTrueOhlcv();
      const { summary } = runTimeMachineBatch(trades, ohlcvMap);

      const appliedLessons: any[] = [];
      const currentKb = ctx.getAiKnowledgeBase();

      for (const lesson of summary.topAdaptiveLessons) {
        // Проверяем, нет ли уже такого правила в базе
        const ruleKey = `tm_rule_${lesson.patternName.substring(0, 15).replace(/[^a-zA-Z0-9]/g, '')}_${lesson.bestScenario}`;
        const alreadyExists = currentKb.some(k => k.id === ruleKey || (k.ruleText && k.ruleText.includes(lesson.patternName) && k.ruleText.includes(lesson.bestScenario)));

        if (!alreadyExists && lesson.advantagePct > 1.0) {
          const newRule = {
            id: ruleKey,
            ruleText: `[Машина Времени]: ${lesson.recommendation} (преимущество +${lesson.advantagePct}% PnL на выборке из ${lesson.sampleSize} сделок).`,
            agent: 'Scout & Exit Coordinator',
            impactScore: Math.min(10, Math.round(lesson.advantagePct)),
            patternName: lesson.patternName,
            recommendedScenario: lesson.bestScenario,
            confidence: 0.92,
            winRate: 0.78,
            usageCount: 1,
            successRate: 0.85,
            isArchived: false,
            createdAt: Date.now()
          };

          currentKb.push(newRule);
          ctx.saveKnowledgeDB(newRule, true);
          appliedLessons.push(newRule);
        }
      }

      if (ctx.emitSignalsUpdated) {
        ctx.emitSignalsUpdated();
      }

      res.json({
        success: true,
        message: `Успешно применено ${appliedLessons.length} новых адаптивных правил из симуляций Машины Времени`,
        data: appliedLessons
      });
    } catch (err: any) {
      console.error('[TIME_MACHINE_APPLY_ERROR]', err?.message || err);
      res.status(500).json({ success: false, error: err?.message || 'Failed to apply time machine learnings' });
    }
  });

  return router;
}
