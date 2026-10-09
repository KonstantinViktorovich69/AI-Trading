import express from 'express';
import type { Request, Response, Router } from 'express';
import { getConfigVersion, getBuildId, PROCESS_STARTED_AT, TRADING_SETTINGS_WHITELIST } from '../services/buildInfo.ts';
import { getDowntimeSummary } from '../services/heartbeatService.ts';
import { getFunnelData } from '../services/funnelCounters.ts';
import { isEntryPaused } from '../services/entryGate.ts';
import { getAllLearningCells, getCellVerdict } from '../services/learningCellService.ts';
import { walkForwardEvaluate, isCleanLearningTrade, netReturnPct } from '../services/learningCells.ts';
import { getQuantModelV2Status, getQuantModelV2ShadowReport } from '../services/quantModelV2.ts';

export interface TelemetryRouterContext {
  getGlobalSettings: () => any;
  getVirtualTrades?: () => any[];
}

export function createTelemetryRouter(ctx: TelemetryRouterContext): Router {
  const router = express.Router();

  // GET /api/system/config-version
  router.get('/system/config-version', (_req: Request, res: Response) => {
    try {
      const settings = ctx.getGlobalSettings ? ctx.getGlobalSettings() : {};
      const configVersion = getConfigVersion(settings);
      const buildId = getBuildId();

      res.json({
        success: true,
        configVersion,
        buildId,
        processStartedAt: PROCESS_STARTED_AT,
        settingsKeys: [...TRADING_SETTINGS_WHITELIST]
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting config version' });
    }
  });

  // GET /api/system/downtime
  router.get('/system/downtime', (_req: Request, res: Response) => {
    try {
      const summary = getDowntimeSummary();
      const entryGate = isEntryPaused(undefined, { getGlobalSettings: ctx.getGlobalSettings });
      res.json({
        success: true,
        entryGate,
        ...summary
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting downtime summary' });
    }
  });

  // GET /api/system/funnel?hours=24
  router.get('/system/funnel', (req: Request, res: Response) => {
    try {
      const hoursParam = req.query.hours ? parseInt(String(req.query.hours), 10) : 24;
      const hours = isNaN(hoursParam) || hoursParam <= 0 ? 24 : hoursParam;
      const funnel = getFunnelData(hours);

      res.json({
        success: true,
        hours: funnel.hoursRequested,
        aggregated: funnel.aggregated,
        recentEvents: funnel.events
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting funnel data' });
    }
  });

  // GET /api/learning/cells?minN=10
  router.get('/learning/cells', (req: Request, res: Response) => {
    try {
      const minNParam = req.query.minN ? parseInt(String(req.query.minN), 10) : 10;
      const minN = isNaN(minNParam) || minNParam < 0 ? 10 : minNParam;
      const allCells = getAllLearningCells();
      const settings = ctx.getGlobalSettings ? ctx.getGlobalSettings() : {};

      const filteredCells: Record<string, any> = {};
      for (const [key, stats] of Object.entries(allCells)) {
        if (stats.n >= minN) {
          const parts = key.split('|');
          const pattern = parts[0] || '';
          const side = parts[1] || 'LONG';
          const regime = parts[2] || 'NEUTRAL';
          const verdictRes = getCellVerdict({ pattern, side, regime, settings });
          filteredCells[key] = {
            ...stats,
            verdict: verdictRes.verdict,
            adjustment: verdictRes.adjustment,
            reason: verdictRes.reason,
            wouldBlockIfFullPolicy: verdictRes.wouldBlockIfFullPolicy
          };
        }
      }

      res.json({
        success: true,
        totalCells: Object.keys(allCells).length,
        matchedCells: Object.keys(filteredCells).length,
        minN,
        cells: filteredCells
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting learning cells' });
    }
  });

  // GET /api/learning/walk-forward
  router.get('/learning/walk-forward', (req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades ? ctx.getVirtualTrades() : [];
      const settings = ctx.getGlobalSettings ? ctx.getGlobalSettings() : {};
      const maxTradesParam = req.query.maxTrades ? parseInt(String(req.query.maxTrades), 10) : 1500;
      const maxTrades = isNaN(maxTradesParam) || maxTradesParam <= 0 ? 1500 : maxTradesParam;

      const result = walkForwardEvaluate(trades, {
        policy: (settings as any).learningProtectedPatternsPolicy ?? 'PENALIZE_ONLY',
        halfLifeTrades: (settings as any).learningHalfLifeTrades ?? 150,
        maxTrades
      });

      res.json({
        success: true,
        ...result
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed evaluating walk-forward' });
    }
  });

  // GET /api/learning/shadow-report
  router.get('/learning/shadow-report', (_req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades ? ctx.getVirtualTrades() : [];
      const cleanTrades = trades.filter(t => {
        return isCleanLearningTrade(t) && t.entryDiagnostics?.cellVerdict;
      });

      const groupAccum: Record<string, { n: number; wins: number; sumNet: number; grossProfit: number; grossLoss: number }> = {
        BOOST: { n: 0, wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
        NEUTRAL: { n: 0, wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
        PENALIZE: { n: 0, wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 },
        BLOCK: { n: 0, wins: 0, sumNet: 0, grossProfit: 0, grossLoss: 0 }
      };

      for (const t of cleanTrades) {
        const vKind = t.entryDiagnostics?.cellVerdict?.verdict || 'NEUTRAL';
        const group = groupAccum[vKind] || groupAccum['NEUTRAL'];
        const ret = netReturnPct(t);
        const isWin = ret > 0 || t.outcome === 1 || t.outcome === 'WIN';

        group.n++;
        group.sumNet += ret;
        if (isWin) group.wins++;
        if (ret > 0) group.grossProfit += ret;
        else if (ret < 0) group.grossLoss += Math.abs(ret);
      }

      const formatGroup = (g: { n: number; wins: number; sumNet: number; grossProfit: number; grossLoss: number }) => {
        const winRate = g.n > 0 ? Number((g.wins / g.n).toFixed(4)) : 0;
        const avgNetPct = g.n > 0 ? Number((g.sumNet / g.n).toFixed(4)) : 0;
        const sumNetPct = Number(g.sumNet.toFixed(2));
        let profitFactor: number | null = null;
        if (g.grossLoss === 0) {
          profitFactor = g.grossProfit > 0 ? 10.0 : null;
        } else {
          profitFactor = Number(Math.min(10.0, g.grossProfit / g.grossLoss).toFixed(3));
        }
        return { n: g.n, wins: g.wins, winRate, avgNetPct, profitFactor, sumNetPct };
      };

      res.json({
        success: true,
        tradesEvaluated: cleanTrades.length,
        groups: {
          BOOST: formatGroup(groupAccum.BOOST),
          NEUTRAL: formatGroup(groupAccum.NEUTRAL),
          PENALIZE: formatGroup(groupAccum.PENALIZE),
          BLOCK: formatGroup(groupAccum.BLOCK)
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting shadow report' });
    }
  });

  // GET /api/quant/v2/status
  router.get('/quant/v2/status', (_req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades ? ctx.getVirtualTrades() : [];
      const status = getQuantModelV2Status(trades);
      res.json({
        success: true,
        ...status
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting quant model v2 status' });
    }
  });

  // GET /api/quant/v2/shadow-report
  router.get('/quant/v2/shadow-report', (_req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades ? ctx.getVirtualTrades() : [];
      const report = getQuantModelV2ShadowReport(trades);
      res.json({
        success: true,
        ...report
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed getting quant model v2 shadow report' });
    }
  });

  return router;
}
