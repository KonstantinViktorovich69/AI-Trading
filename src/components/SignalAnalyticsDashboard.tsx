import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  BarChart3, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Activity, 
  Filter, 
  Download, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Bot, 
  Layers, 
  Search, 
  Clock, 
  DollarSign, 
  Scale, 
  ChevronRight, 
  ChevronDown,
  Percent,
  Sliders,
  Sparkles,
  Info
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { 
  SignalPerformanceReport, 
  GranularBreakdownMetric, 
  DirectionalGranularStats,
  AnalyticalQuestionsReport 
} from '../../server/services/signalPerformanceAnalyticsService.ts';

interface SignalAnalyticsDashboardProps {
  onRefresh?: () => void;
  trades?: any[];
}

export function SignalAnalyticsDashboard({ onRefresh, trades }: SignalAnalyticsDashboardProps) {
  const [report, setReport] = useState<SignalPerformanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSideView, setActiveSideView] = useState<'COMBINED' | 'LONG' | 'SHORT'>('COMBINED');
  const [activeOriginFilter, setActiveOriginFilter] = useState<'OUT_OF_SAMPLE' | 'ALL' | 'LIVE_WEEX' | 'PAPER_SIM' | 'HISTORICAL_SEED'>('ALL');
  const [activeSubTab, setActiveSubTab] = useState<'insights' | 'directional' | 'patterns' | 'regimes' | 'agents' | 'factors' | 'audit_log'>('insights');
  const [selectedTraceTrade, setSelectedTraceTrade] = useState<any | null>(null);
  const [searchAuditTerm, setSearchAuditTerm] = useState('');

  const searchAuditTermRef = useRef('');
  searchAuditTermRef.current = searchAuditTerm;

  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort('unmounted');
      }
    };
  }, []);

  const fetchReport = useCallback(async (originInput?: any, retryCount = 0) => {
    const validOrigins = ['OUT_OF_SAMPLE', 'ALL', 'LIVE_WEEX', 'PAPER_SIM', 'HISTORICAL_SEED'];
    const origin = (typeof originInput === 'string' && validOrigins.includes(originInput))
      ? originInput
      : activeOriginFilter;

    // Abort previous in-flight request if any to avoid racing requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort('superseded');
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => {
      controller.abort('timeout');
    }, 30000);

    if (isMountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const res = await fetch(`/api/analytics/signal-performance?origin=${encodeURIComponent(origin)}`, {
        headers: {
          'Accept': 'application/json'
        },
        signal: controller.signal
      }).catch((fetchErr: any) => {
        clearTimeout(timeoutId);
        throw fetchErr;
      });
      clearTimeout(timeoutId);

      if (!isMountedRef.current || controller.signal.aborted) return;

      const contentType = res.headers.get('content-type') || '';

      if (!res.ok) {
        if (contentType.includes('application/json')) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || `Сервер вернул статус HTTP ${res.status}`);
        }
        if (isMountedRef.current && retryCount < 3) {
          await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
          if (!isMountedRef.current || controller.signal.aborted) return;
          return fetchReport(origin, retryCount + 1);
        }
        throw new Error(`Сервер вернул статус HTTP ${res.status}`);
      }

      if (!contentType.includes('application/json')) {
        // Non-JSON response (e.g. gateway reload, index.html fallback, or 502/504)
        if (isMountedRef.current && retryCount < 3) {
          await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
          if (!isMountedRef.current || controller.signal.aborted) return;
          return fetchReport(origin, retryCount + 1);
        }
        throw new Error('Сервер временно недоступен или обновляется. Повторите запрос через несколько секунд.');
      }

      const text = await res.text();
      if (!isMountedRef.current || controller.signal.aborted) return;

      let data: any;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        if (isMountedRef.current && retryCount < 3) {
          await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
          if (!isMountedRef.current || controller.signal.aborted) return;
          return fetchReport(origin, retryCount + 1);
        }
        throw new Error('Ошибка формата данных от сервера при получении аналитики.');
      }

      if (!isMountedRef.current || controller.signal.aborted) return;

      if (data && data.success && data.report) {
        setReport(data.report);
      } else {
        throw new Error(data?.error || 'Не удалось загрузить отчёт');
      }
    } catch (e: any) {
      const isAborted = e?.name === 'AbortError' || 
        controller.signal.aborted || 
        e?.message?.toLowerCase().includes('aborted') || 
        e?.message?.toLowerCase().includes('abort') ||
        !isMountedRef.current;

      if (isAborted) {
        // Request was intentionally cancelled or component unmounted; cleanly exit
        return;
      }

      if (isMountedRef.current && retryCount < 3 && (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError'))) {
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        if (!isMountedRef.current || controller.signal.aborted) return;
        return fetchReport(origin, retryCount + 1);
      }

      if (isMountedRef.current) {
        console.error('Failed to fetch signal performance analytics:', e);
        setError(e.message || 'Ошибка загрузки данных');
      }
    } finally {
      if (isMountedRef.current && abortControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [activeOriginFilter]);

  // Avoid spamming requests on rapid sub-second intra-trade price ticks
  const tradesSignature = useMemo(() => {
    if (!trades) return '0_0';
    const closedCount = trades.filter((t: any) => t.status === 'CLOSED').length;
    return `${trades.length}_${closedCount}`;
  }, [trades]);

  useEffect(() => {
    fetchReport(activeOriginFilter);
  }, [tradesSignature, activeOriginFilter, fetchReport]);

  const currentDirectionStats: DirectionalGranularStats | undefined = useMemo(() => {
    if (!report) return undefined;
    if (activeSideView === 'LONG') return report.longFutures;
    if (activeSideView === 'SHORT') return report.shortFutures;
    return report.combined;
  }, [report, activeSideView]);

  const filteredAuditedTrades = useMemo(() => {
    if (!report?.rawAuditedTrades) return [];
    let list = report.rawAuditedTrades;
    if (activeSideView === 'LONG') list = list.filter(t => t.side === 'LONG');
    if (activeSideView === 'SHORT') list = list.filter(t => t.side === 'SHORT');

    if (searchAuditTerm.trim()) {
      const s = searchAuditTerm.toLowerCase().trim();
      list = list.filter(t => 
        t.symbol.toLowerCase().includes(s) || 
        t.pattern.toLowerCase().includes(s) ||
        t.marketRegime.toLowerCase().includes(s)
      );
    }
    return list;
  }, [report, activeSideView, searchAuditTerm]);

  const handleExportCSV = () => {
    if (!report?.rawAuditedTrades || report.rawAuditedTrades.length === 0) return;
    const headers = [
      'ID', 'Symbol', 'Side', 'Status', 'MarketRegime', 'Pattern', 'EntryPrice', 'ClosePrice',
      'StopLoss', 'TakeProfit', 'Amount', 'Leverage', 'PnL_USD', 'PnL_Percent', 'R_Multiple',
      'MAE_Percent', 'MFE_Percent', 'Slippage_Percent', 'Fee_USD', 'HoldDuration_Sec',
      'ConfidenceScore', 'ConsensusScore', 'RiskSentinelDecision', 'OpenTime', 'CloseTime'
    ];
    const rows = report.rawAuditedTrades.map(t => [
      t.id, t.symbol, t.side, t.status, t.marketRegime, `"${t.pattern}"`, t.entryPrice, t.closePrice || '',
      t.stopLoss || '', t.takeProfit || '', t.amount, t.leverage, t.pnl, t.pnlPercent, t.rMultiple,
      t.maePct, t.mfePct, t.slippagePct, t.feeUsd, Math.round(t.holdDurationMs / 1000),
      t.confidenceScore, t.consensusScore, t.riskSentinelDecision,
      new Date(t.openTime).toISOString(), t.closeTime ? new Date(t.closeTime).toISOString() : ''
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `signal_performance_audit_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportJSON = () => {
    if (!report) return;
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2));
    const link = document.createElement('a');
    link.setAttribute('href', dataStr);
    link.setAttribute('download', `signal_performance_full_report_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading && !report) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center flex flex-col items-center justify-center space-y-4">
        <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
        <p className="text-zinc-400 text-sm font-medium">Агрегация статистических данных и Decision Trace...</p>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="bg-rose-950/20 border border-rose-900/40 rounded-xl p-8 text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto" />
        <h3 className="text-rose-300 font-bold">Ошибка получения аналитики сигналов</h3>
        <p className="text-zinc-400 text-xs">{error}</p>
        <button onClick={() => fetchReport(activeOriginFilter)} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-semibold">
          Повторить запрос
        </button>
      </div>
    );
  }

  const summary = currentDirectionStats?.summary;
  const insights = report?.analyticalReport;

  const forwardAudit = report?.strictForwardTestAudit;

  return (
    <div className="space-y-6">
      {/* Top Header & Global Actions */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
              <BarChart3 className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
                Аналитика торговых сигналов
                <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-full">
                  STRICT FORWARD TEST (OUT-OF-SAMPLE)
                </span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Независимый аудит текущего пайплайна, 100% изоляция исторических seed-данных и Decision Trace
              </p>
            </div>
          </div>
        </div>

        {/* Direction Selector & Export Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Direction Toggle */}
          <div className="bg-zinc-950 p-1 rounded-lg border border-zinc-800 flex items-center">
            <button
              onClick={() => setActiveSideView('COMBINED')}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-bold transition-colors",
                activeSideView === 'COMBINED' ? "bg-indigo-600 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              Все (Combined)
            </button>
            <button
              onClick={() => setActiveSideView('LONG')}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-bold transition-colors flex items-center gap-1",
                activeSideView === 'LONG' ? "bg-emerald-600 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <TrendingUp className="w-3.5 h-3.5" /> LONG FUTURES
            </button>
            <button
              onClick={() => setActiveSideView('SHORT')}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-bold transition-colors flex items-center gap-1",
                activeSideView === 'SHORT' ? "bg-rose-600 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <TrendingDown className="w-3.5 h-3.5" /> SHORT FUTURES
            </button>
          </div>

          <button
            onClick={() => { fetchReport(); if (onRefresh) onRefresh(); }}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors border border-zinc-700/50"
            title="Обновить аналитику"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin text-indigo-400")} />
          </button>

          <button
            onClick={handleExportCSV}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-bold flex items-center gap-1.5 border border-zinc-700/50 transition-colors"
            title="Экспорт аудита в CSV"
          >
            <Download className="w-3.5 h-3.5 text-zinc-400" /> CSV
          </button>

          <button
            onClick={handleExportJSON}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-bold flex items-center gap-1.5 border border-zinc-700/50 transition-colors"
            title="Экспорт полного отчёта в JSON"
          >
            <Download className="w-3.5 h-3.5 text-indigo-400" /> JSON
          </button>
        </div>
      </div>

      {/* STRICT OUT-OF-SAMPLE FORWARD TEST AUDIT BANNER */}
      {forwardAudit && (
        <div className="bg-gradient-to-r from-amber-950/30 via-zinc-900 to-indigo-950/30 border border-amber-500/30 rounded-xl p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <ShieldAlert className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-black text-amber-200 uppercase tracking-tight">
                    Strict Out-of-Sample Forward Test
                  </h3>
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                    Zero Contamination (100% Изоляция Seed)
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Статус подтверждения правил (CONFIRMED) строго заблокирован до выборки N &ge; 30 независимых исходов текущего пайплайна.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className={cn(
                "px-2.5 py-1 text-[11px] font-black rounded-lg border",
                forwardAudit.isSampleSufficientForReview 
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/30"
              )}>
                {forwardAudit.isSampleSufficientForReview 
                  ? `ВЫБОРКА ГОТОВА ДЛЯ REVIEW (${forwardAudit.outOfSampleClosed}/30)`
                  : `НАКОПЛЕНИЕ ВЫБОРКИ (${forwardAudit.outOfSampleClosed} / ${forwardAudit.targetSampleSize})`}
              </span>
            </div>
          </div>

          {/* Progress Bar towards N=30 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>Прогресс до 1-го официального Out-of-Sample Performance Review (N = 30):</span>
              <span className="font-mono font-bold text-amber-300">{forwardAudit.progressPct}% ({forwardAudit.outOfSampleClosed}/{forwardAudit.targetSampleSize})</span>
            </div>
            <div className="w-full bg-zinc-950 h-2.5 rounded-full overflow-hidden border border-zinc-800">
              <div 
                className="h-full bg-gradient-to-r from-amber-500 to-indigo-500 rounded-full transition-all duration-500" 
                style={{ width: `${Math.max(3, forwardAudit.progressPct)}%` }}
              />
            </div>
          </div>

          {/* Dataset Origin Filter Tabs */}
          <div className="pt-2 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold text-zinc-400 uppercase mr-1 flex items-center gap-1">
                <Filter className="w-3.5 h-3.5" /> Срез данных:
              </span>

              <button
                onClick={() => setActiveOriginFilter('OUT_OF_SAMPLE')}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-bold transition-all border",
                  activeOriginFilter === 'OUT_OF_SAMPLE'
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm"
                    : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                )}
              >
                🧪 OUT-OF-SAMPLE ({forwardAudit.outOfSampleTotal})
              </button>

              <button
                onClick={() => setActiveOriginFilter('LIVE_WEEX')}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-bold transition-all border",
                  activeOriginFilter === 'LIVE_WEEX'
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
                    : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                )}
              >
                ⚡ LIVE_WEEX
              </button>

              <button
                onClick={() => setActiveOriginFilter('PAPER_SIM')}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-bold transition-all border",
                  activeOriginFilter === 'PAPER_SIM'
                    ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                    : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                )}
              >
                🎮 PAPER_SIM
              </button>

              <button
                onClick={() => setActiveOriginFilter('HISTORICAL_SEED')}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-bold transition-all border",
                  activeOriginFilter === 'HISTORICAL_SEED'
                    ? "bg-zinc-800 text-zinc-200 border-zinc-600"
                    : "bg-zinc-950 text-zinc-500 border-zinc-800 hover:text-zinc-300"
                )}
              >
                📜 HISTORICAL_SEED ({forwardAudit.historicalSeedCount})
              </button>

              <button
                onClick={() => setActiveOriginFilter('ALL')}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-bold transition-all border",
                  activeOriginFilter === 'ALL'
                    ? "bg-indigo-600/30 text-indigo-300 border-indigo-500/50"
                    : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                )}
              >
                📁 ВСЕ ({forwardAudit.totalTradesInDb})
              </button>
            </div>

            <div className="text-[11px] text-zinc-500">
              {activeOriginFilter === 'OUT_OF_SAMPLE' && (
                <span className="text-amber-400 font-medium">Только новые независимые сделки (0% Seed Contamination)</span>
              )}
              {activeOriginFilter === 'HISTORICAL_SEED' && (
                <span className="text-zinc-400 font-medium">Изолированный исторический датасет (заморожен)</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* KPI Metric Summary Cards */}
      {summary && summary.totalTrades === 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 text-amber-300">
            <Info className="w-5 h-5 shrink-0 text-amber-400" />
            <span>
              {activeOriginFilter === 'LIVE_WEEX' 
                ? 'Реальные боевые сделки на бирже WEEX пока не открывались (активен Paper Trading / виртуальная симуляция). Переключите фильтр на "ALL" или "OUT-OF-SAMPLE", чтобы увидеть статистику.'
                : 'По выбранному срезу данных пока нет закрытых сделок.'}
            </span>
          </div>
          <button
            onClick={() => setActiveOriginFilter('ALL')}
            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 rounded-lg font-bold shrink-0 transition-colors"
          >
            Показать все (123+)
          </button>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Всего сделок</div>
            <div className="text-xl font-black text-zinc-100 mt-1">{summary.totalTrades}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Вин: <span className="text-emerald-400 font-bold">{summary.winningTrades}</span> | Лосс: <span className="text-rose-400 font-bold">{summary.losingTrades}</span>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Win Rate</div>
            <div className={cn("text-xl font-black mt-1", summary.winRate >= 50 ? "text-emerald-400" : "text-rose-400")}>
              {summary.winRate.toFixed(1)}%
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              PF: <span className="text-zinc-300 font-bold">{summary.profitFactor.toFixed(2)}</span>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Чистый PnL ($)</div>
            <div className={cn("text-xl font-black font-mono mt-1", summary.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {summary.totalPnlUsd >= 0 ? '+' : ''}{summary.totalPnlUsd.toFixed(2)} $
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Ср. PnL: <span className={summary.avgPnlUsd >= 0 ? "text-emerald-400 font-mono" : "text-rose-400 font-mono"}>
                {summary.avgPnlUsd >= 0 ? '+' : ''}{summary.avgPnlUsd.toFixed(2)}$
              </span>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Expectancy ($ & R)</div>
            <div className={cn("text-xl font-black font-mono mt-1", summary.expectancyUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {summary.expectancyUsd >= 0 ? '+' : ''}{summary.expectancyUsd.toFixed(2)} $
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Ср. R: <span className="text-indigo-300 font-bold">{summary.avgRMultiple > 0 ? '+' : ''}{summary.avgRMultiple.toFixed(2)}R</span>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">MAE / MFE</div>
            <div className="text-base font-black text-zinc-200 mt-1 flex items-center gap-1.5 font-mono">
              <span className="text-rose-400">-{summary.avgMaePct.toFixed(1)}%</span>
              <span className="text-zinc-600">/</span>
              <span className="text-emerald-400">+{summary.avgMfePct.toFixed(1)}%</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Просадка vs Пик
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-3.5 rounded-xl">
            <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Удержание & Комиссии</div>
            <div className="text-base font-black text-zinc-200 mt-1 font-mono">
              {Math.round(summary.avgHoldDurationMs / 60000)} мин
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Сборы: <span className="text-zinc-300 font-mono">-${summary.totalFeesUsd.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tabs Navigation */}
      <div className="border-b border-zinc-800 flex items-center gap-1 overflow-x-auto pb-1">
        <button
          onClick={() => setActiveSubTab('insights')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'insights'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Sparkles className="w-4 h-4" /> 10 Аналитических выводов
        </button>

        <button
          onClick={() => setActiveSubTab('directional')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'directional'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Scale className="w-4 h-4" /> Сравнение LONG vs SHORT
        </button>

        <button
          onClick={() => setActiveSubTab('patterns')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'patterns'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Layers className="w-4 h-4" /> Срезы по паттернам
        </button>

        <button
          onClick={() => setActiveSubTab('regimes')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'regimes'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Activity className="w-4 h-4" /> Срезы по Market Regimes
        </button>

        <button
          onClick={() => setActiveSubTab('agents')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'agents'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Bot className="w-4 h-4" /> Агенты и Confidence
        </button>

        <button
          onClick={() => setActiveSubTab('factors')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'factors'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Sliders className="w-4 h-4" /> Комбинации факторов
        </button>

        <button
          onClick={() => setActiveSubTab('audit_log')}
          className={cn(
            "px-4 py-2 text-xs font-bold rounded-t-lg transition-colors border-b-2 flex items-center gap-2 whitespace-nowrap",
            activeSubTab === 'audit_log'
              ? "bg-zinc-900 text-indigo-400 border-indigo-500"
              : "text-zinc-400 hover:text-zinc-200 border-transparent"
          )}
        >
          <Search className="w-4 h-4" /> Журнал Decision Trace ({filteredAuditedTrades.length})
        </button>
      </div>

      {/* SUB-TAB 1: 10 KEY ANALYTICAL QUESTIONS */}
      {activeSubTab === 'insights' && insights && (
        <div className="space-y-4">
          <div className="p-4 bg-indigo-500/5 border border-indigo-500/20 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-sm font-black text-indigo-300 uppercase tracking-tight">
                  Аналитический отчёт: 10 ключевых вопросов
                </h3>
                <p className="text-xs text-zinc-400">
                  Строго на основе накопленной статистики без автоматических изменений весов и логики
                </p>
              </div>
            </div>
            <span className="text-[10px] font-bold px-2.5 py-1 bg-zinc-800 text-zinc-300 rounded-lg">
              Обновлено: {new Date(report?.generatedAt || Date.now()).toLocaleTimeString()}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 1. Какие паттерны реально прибыльны */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" /> 1. Реально прибыльные паттерны
                </h4>
                <span className="text-[10px] text-zinc-500">{insights.question1_profitablePatterns.length} паттернов</span>
              </div>
              <div className="space-y-2">
                {insights.question1_profitablePatterns.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-3 text-center">Недостаточно данных для выборки</p>
                ) : (
                  insights.question1_profitablePatterns.map((p, idx) => (
                    <div key={idx} className="p-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-bold text-zinc-200">{p.pattern}</div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">{p.tradesCount} сделок • Ср. R: +{p.avgR.toFixed(2)}R</div>
                      </div>
                      <div className="text-right">
                        <div className="font-black text-emerald-400 font-mono">+{p.totalPnl.toFixed(2)}$</div>
                        <div className="text-[10px] font-bold text-emerald-500">{p.winRate.toFixed(1)}% WR</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 2. Какие паттерны дают убытки */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                  <XCircle className="w-4 h-4 text-rose-400" /> 2. Убыточные паттерны
                </h4>
                <span className="text-[10px] text-zinc-500">{insights.question2_unprofitablePatterns.length} паттернов</span>
              </div>
              <div className="space-y-2">
                {insights.question2_unprofitablePatterns.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-3 text-center">Нет паттернов с систематическим отрицательным исходом</p>
                ) : (
                  insights.question2_unprofitablePatterns.map((p, idx) => (
                    <div key={idx} className="p-2.5 bg-zinc-950/60 rounded-lg border border-rose-950/30 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-bold text-zinc-200">{p.pattern}</div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">{p.tradesCount} сделок • Ср. R: {p.avgR.toFixed(2)}R</div>
                      </div>
                      <div className="text-right">
                        <div className="font-black text-rose-400 font-mono">{p.totalPnl.toFixed(2)}$</div>
                        <div className="text-[10px] font-bold text-rose-500">{p.winRate.toFixed(1)}% WR</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 3. В каких market regimes система лучше всего работает */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-indigo-400" /> 3. Оптимальные режимы рынка (Market Regimes)
              </h4>
              <div className="space-y-2">
                {insights.question3_bestMarketRegimes.map((r, idx) => (
                  <div key={idx} className="p-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-bold text-zinc-200 px-2 py-0.5 bg-indigo-500/10 text-indigo-300 rounded border border-indigo-500/20 text-[10px]">
                        {r.regime}
                      </span>
                      <div className="text-[10px] text-zinc-500 mt-1">{r.tradesCount} сделок • PF: {r.profitFactor.toFixed(2)}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-black text-emerald-400 font-mono">+{r.totalPnl.toFixed(2)}$</div>
                      <div className="text-[10px] font-bold text-emerald-500">{r.winRate.toFixed(1)}% WR</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 4. В каких режимах она теряет деньги */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-400" /> 4. Зоны повышенного риска (Drawdown Regimes)
              </h4>
              <div className="space-y-2">
                {insights.question4_worstMarketRegimes.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-3 text-center">Критических просадок по режимам не зафиксировано</p>
                ) : (
                  insights.question4_worstMarketRegimes.map((r, idx) => (
                    <div key={idx} className="p-2.5 bg-zinc-950/60 rounded-lg border border-amber-950/30 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold text-zinc-200 px-2 py-0.5 bg-amber-500/10 text-amber-300 rounded border border-amber-500/20 text-[10px]">
                          {r.regime}
                        </span>
                        <div className="text-[10px] text-zinc-500 mt-1">{r.tradesCount} сделок • Max DD: -{r.maxDd.toFixed(2)}$</div>
                      </div>
                      <div className="text-right">
                        <div className="font-black text-amber-400 font-mono">{r.totalPnl.toFixed(2)}$</div>
                        <div className="text-[10px] font-bold text-zinc-400">{r.winRate.toFixed(1)}% WR</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 5. Какова реальная эффективность LONG и SHORT */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
            <h4 className="text-xs font-black text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
              <Scale className="w-4 h-4 text-indigo-400" /> 5. Реальная сравнительная эффективность LONG vs SHORT
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-1"><TrendingUp className="w-4 h-4" /> LONG FUTURES</span>
                  <span className="text-xs font-mono font-black text-emerald-400">{insights.question5_longVsShortEffectiveness.long.winRate.toFixed(1)}% WR</span>
                </div>
                <div className="text-[11px] text-zinc-400 space-y-1">
                  <div>Сделок: <span className="text-zinc-200 font-bold">{insights.question5_longVsShortEffectiveness.long.tradesCount}</span> | PnL: <span className="text-emerald-400 font-mono font-bold">+{insights.question5_longVsShortEffectiveness.long.totalPnl.toFixed(2)}$</span></div>
                  <div>Profit Factor: <span className="text-zinc-200 font-bold">{insights.question5_longVsShortEffectiveness.long.profitFactor.toFixed(2)}</span> | Ср. R: <span className="text-zinc-200 font-bold">+{insights.question5_longVsShortEffectiveness.long.avgR.toFixed(2)}R</span></div>
                  <div>Мат. ожидание (Expectancy): <span className="text-emerald-300 font-mono font-bold">+{insights.question5_longVsShortEffectiveness.long.expectancy.toFixed(2)}$</span></div>
                </div>
              </div>

              <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-rose-400 flex items-center gap-1"><TrendingDown className="w-4 h-4" /> SHORT FUTURES</span>
                  <span className="text-xs font-mono font-black text-rose-400">{insights.question5_longVsShortEffectiveness.short.winRate.toFixed(1)}% WR</span>
                </div>
                <div className="text-[11px] text-zinc-400 space-y-1">
                  <div>Сделок: <span className="text-zinc-200 font-bold">{insights.question5_longVsShortEffectiveness.short.tradesCount}</span> | PnL: <span className="text-emerald-400 font-mono font-bold">+{insights.question5_longVsShortEffectiveness.short.totalPnl.toFixed(2)}$</span></div>
                  <div>Profit Factor: <span className="text-zinc-200 font-bold">{insights.question5_longVsShortEffectiveness.short.profitFactor.toFixed(2)}</span> | Ср. R: <span className="text-zinc-200 font-bold">+{insights.question5_longVsShortEffectiveness.short.avgR.toFixed(2)}R</span></div>
                  <div>Мат. ожидание (Expectancy): <span className="text-emerald-300 font-mono font-bold">+{insights.question5_longVsShortEffectiveness.short.expectancy.toFixed(2)}$</span></div>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-400 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
              <span className="text-indigo-400 font-bold">Вердикт системы: </span>
              {insights.question5_longVsShortEffectiveness.verdict}
            </p>
          </div>

          {/* 6. Вклад каждого агента & 7. Порог Confidence */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
                <Bot className="w-4 h-4 text-indigo-400" /> 6. Вклад каждого агента в результат
              </h4>
              <div className="space-y-2">
                {insights.question6_agentContribution.map((a, idx) => (
                  <div key={idx} className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 text-xs flex items-center justify-between">
                    <div>
                      <div className="font-bold text-zinc-200">{a.agentName}</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">{a.role} • Вес: {a.weight.toFixed(2)}x</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold text-indigo-300">{a.accuracy.toFixed(1)}% точность</div>
                      <div className="text-[10px] font-mono text-emerald-400">+{a.pnlImpact.toFixed(2)}$ PnL</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
                <Percent className="w-4 h-4 text-indigo-400" /> 7. Порог Confidence & Expectancy
              </h4>
              <div className="space-y-2">
                {insights.question7_confidenceExpectancy.map((c, idx) => (
                  <div key={idx} className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 text-xs flex items-center justify-between">
                    <div>
                      <div className="font-bold text-zinc-200">{c.tier}</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">{c.tradesCount} сделок • WR: {c.winRate.toFixed(1)}%</div>
                    </div>
                    <div className="text-right">
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-bold font-mono",
                        c.hasPositiveExpectancy ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                      )}>
                        {c.expectancyUsd >= 0 ? '+' : ''}{c.expectancyUsd.toFixed(2)}$ Expectancy
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 8, 9, 10: Факторы, Фильтры и Предвестники убытков */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-indigo-400" /> 8. Топ комбинации факторов
              </h4>
              <div className="space-y-2">
                {insights.question8_bestFactorCombinations.map((f, idx) => (
                  <div key={idx} className="p-2 bg-zinc-950 rounded border border-zinc-800 text-[11px]">
                    <div className="font-semibold text-zinc-200 truncate" title={f.factorsCombo}>{f.factorsCombo}</div>
                    <div className="flex justify-between text-[10px] text-zinc-400 mt-1">
                      <span>{f.tradesCount} сделок</span>
                      <span className="font-bold text-emerald-400">{f.winRate.toFixed(1)}% WR</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
                <Filter className="w-4 h-4 text-indigo-400" /> 9. Анализ фильтрации сигналов
              </h4>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 text-xs space-y-2">
                <div className="flex justify-between text-zinc-400">
                  <span>Отсеяно шума:</span>
                  <span className="font-bold text-zinc-200">{insights.question9_filterAnalysis.totalSignalsFilteredOut} сигналов</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Блокировки Risk Sentinel:</span>
                  <span className="font-bold text-amber-400">{insights.question9_filterAnalysis.riskSentinelBlocks}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Отказ консенсуса:</span>
                  <span className="font-bold text-rose-400">{insights.question9_filterAnalysis.consensusRejections}</span>
                </div>
                <div className="text-[10px] text-zinc-400 pt-2 border-t border-zinc-800 leading-relaxed">
                  {insights.question9_filterAnalysis.summary}
                </div>
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4.5 space-y-3">
              <h4 className="text-xs font-black text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-rose-400" /> 10. Предвестники убыточных сделок
              </h4>
              <div className="space-y-2">
                {insights.question10_lossPrecursors.map((lp, idx) => (
                  <div key={idx} className="p-2.5 bg-rose-950/10 border border-rose-900/30 rounded-lg text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-zinc-200">{lp.precursor}</span>
                      <span className="font-mono text-[10px] font-bold text-rose-400">{lp.frequencyInLossesPct}%</span>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">{lp.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: DIRECTIONAL LONG vs SHORT COMPARISON */}
      {activeSubTab === 'directional' && report && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* LONG Breakdown */}
            <div className="bg-zinc-900 border border-emerald-900/30 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <h3 className="text-sm font-black text-emerald-400 uppercase tracking-tight flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" /> LONG FUTURES PERFORMANCE
                </h3>
                <span className="text-xs font-mono font-black text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                  {report.longFutures.summary.winRate.toFixed(1)}% Win Rate
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Всего сделок</div>
                  <div className="text-lg font-black text-zinc-100">{report.longFutures.summary.totalTrades}</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Чистый PnL</div>
                  <div className="text-lg font-black font-mono text-emerald-400">+{report.longFutures.summary.totalPnlUsd.toFixed(2)}$</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Profit Factor</div>
                  <div className="text-lg font-black text-zinc-100">{report.longFutures.summary.profitFactor.toFixed(2)}</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний R-Multiple</div>
                  <div className="text-lg font-black font-mono text-indigo-300">+{report.longFutures.summary.avgRMultiple.toFixed(2)}R</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний MAE (Просадка)</div>
                  <div className="text-lg font-black font-mono text-rose-400">-{report.longFutures.summary.avgMaePct.toFixed(2)}%</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний MFE (Пик)</div>
                  <div className="text-lg font-black font-mono text-emerald-400">+{report.longFutures.summary.avgMfePct.toFixed(2)}%</div>
                </div>
              </div>
            </div>

            {/* SHORT Breakdown */}
            <div className="bg-zinc-900 border border-rose-900/30 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <h3 className="text-sm font-black text-rose-400 uppercase tracking-tight flex items-center gap-2">
                  <TrendingDown className="w-5 h-5" /> SHORT FUTURES PERFORMANCE
                </h3>
                <span className="text-xs font-mono font-black text-rose-400 bg-rose-500/10 px-2.5 py-1 rounded-md border border-rose-500/20">
                  {report.shortFutures.summary.winRate.toFixed(1)}% Win Rate
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Всего сделок</div>
                  <div className="text-lg font-black text-zinc-100">{report.shortFutures.summary.totalTrades}</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Чистый PnL</div>
                  <div className="text-lg font-black font-mono text-emerald-400">+{report.shortFutures.summary.totalPnlUsd.toFixed(2)}$</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Profit Factor</div>
                  <div className="text-lg font-black text-zinc-100">{report.shortFutures.summary.profitFactor.toFixed(2)}</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний R-Multiple</div>
                  <div className="text-lg font-black font-mono text-indigo-300">+{report.shortFutures.summary.avgRMultiple.toFixed(2)}R</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний MAE (Просадка)</div>
                  <div className="text-lg font-black font-mono text-rose-400">-{report.shortFutures.summary.avgMaePct.toFixed(2)}%</div>
                </div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="text-zinc-500 text-[10px]">Средний MFE (Пик)</div>
                  <div className="text-lg font-black font-mono text-emerald-400">+{report.shortFutures.summary.avgMfePct.toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: PATTERNS BREAKDOWN */}
      {activeSubTab === 'patterns' && currentDirectionStats && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" /> Статистика эффективности по паттернам ({activeSideView})
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 uppercase text-[10px] font-bold">
                  <th className="py-2.5 px-3">Паттерн</th>
                  <th className="py-2.5 px-3 text-center">Сделок</th>
                  <th className="py-2.5 px-3 text-center">Win Rate</th>
                  <th className="py-2.5 px-3 text-center">Profit Factor</th>
                  <th className="py-2.5 px-3 text-right">PnL ($)</th>
                  <th className="py-2.5 px-3 text-right">Avg R</th>
                  <th className="py-2.5 px-3 text-right">Expectancy</th>
                  <th className="py-2.5 px-3 text-right">MAE / MFE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50 font-medium">
                {Object.entries(currentDirectionStats.byPattern).map(([patName, m], idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-3 font-bold text-zinc-200">{patName}</td>
                    <td className="py-3 px-3 text-center font-mono text-zinc-400">{m.totalTrades}</td>
                    <td className="py-3 px-3 text-center font-bold">
                      <span className={cn(m.winRate >= 50 ? "text-emerald-400" : "text-rose-400")}>
                        {m.winRate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-zinc-300">{m.profitFactor.toFixed(2)}</td>
                    <td className={cn("py-3 px-3 text-right font-mono font-bold", m.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {m.totalPnlUsd >= 0 ? '+' : ''}{m.totalPnlUsd.toFixed(2)}$
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-indigo-300">
                      {m.avgRMultiple >= 0 ? '+' : ''}{m.avgRMultiple.toFixed(2)}R
                    </td>
                    <td className={cn("py-3 px-3 text-right font-mono", m.expectancyUsd >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold")}>
                      {m.expectancyUsd >= 0 ? '+' : ''}{m.expectancyUsd.toFixed(2)}$
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-[11px]">
                      <span className="text-rose-400">-{m.avgMaePct.toFixed(1)}%</span> / <span className="text-emerald-400">+{m.avgMfePct.toFixed(1)}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: MARKET REGIMES */}
      {activeSubTab === 'regimes' && currentDirectionStats && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" /> Эффективность по режимам рынка (Market Regimes - {activeSideView})
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(currentDirectionStats.byMarketRegime).map(([regName, m], idx) => (
              <div key={idx} className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-indigo-300 px-2 py-0.5 bg-indigo-500/10 rounded border border-indigo-500/20">
                    {regName}
                  </span>
                  <span className={cn("text-xs font-bold font-mono", m.winRate >= 50 ? "text-emerald-400" : "text-rose-400")}>
                    {m.winRate.toFixed(1)}% WR
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] text-zinc-500">Сделок</div>
                    <div className="font-bold text-zinc-200">{m.totalTrades}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">PnL ($)</div>
                    <div className={cn("font-bold font-mono", m.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {m.totalPnlUsd >= 0 ? '+' : ''}{m.totalPnlUsd.toFixed(2)}$
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Profit Factor</div>
                    <div className="font-bold text-zinc-200">{m.profitFactor.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Expectancy</div>
                    <div className={cn("font-bold font-mono", m.expectancyUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {m.expectancyUsd >= 0 ? '+' : ''}{m.expectancyUsd.toFixed(2)}$
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-TAB 5: AGENTS & CONFIDENCE */}
      {activeSubTab === 'agents' && currentDirectionStats && (
        <div className="space-y-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
              <Bot className="w-4 h-4 text-indigo-400" /> Скоринг и вклад ИИ-агентов ({activeSideView})
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.values(currentDirectionStats.byAgent).map((a, idx) => (
                <div key={idx} className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-bold text-zinc-200 text-xs">{a.agentName}</div>
                      <div className="text-[10px] text-zinc-500">{a.role}</div>
                    </div>
                    <span className="text-xs font-black font-mono text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                      {a.accuracy.toFixed(1)}%
                    </span>
                  </div>

                  <div className="space-y-1.5 text-xs text-zinc-400 pt-2 border-t border-zinc-800/60">
                    <div className="flex justify-between">
                      <span>Голосов:</span>
                      <span className="font-bold text-zinc-200">{a.totalVotes} (Верных: {a.correctVotes})</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Базовый / Динамич. вес:</span>
                      <span className="font-mono text-zinc-300">{a.avgAssignedWeight.toFixed(2)}x / <span className="text-indigo-400 font-bold">{a.avgDynamicWeight.toFixed(2)}x</span></span>
                    </div>
                    <div className="flex justify-between">
                      <span>Вклад в PnL ($):</span>
                      <span className="font-mono font-bold text-emerald-400">+{a.profitContributionUsd.toFixed(2)}$</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
              <Percent className="w-4 h-4 text-indigo-400" /> Диапазоны Confidence Score
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {Object.entries(currentDirectionStats.byConfidenceRange).map(([tier, m], idx) => (
                <div key={idx} className="p-3.5 bg-zinc-950 rounded-lg border border-zinc-800 space-y-2 text-xs">
                  <div className="font-bold text-zinc-200 text-[11px]">{tier}</div>
                  <div className="flex justify-between text-zinc-400">
                    <span>Сделок: <b className="text-zinc-200">{m.totalTrades}</b></span>
                    <span className={cn("font-bold font-mono", m.winRate >= 50 ? "text-emerald-400" : "text-rose-400")}>{m.winRate.toFixed(1)}% WR</span>
                  </div>
                  <div className="flex justify-between text-zinc-400">
                    <span>Expectancy:</span>
                    <span className={cn("font-bold font-mono", m.expectancyUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {m.expectancyUsd >= 0 ? '+' : ''}{m.expectancyUsd.toFixed(2)}$
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 6: FACTORS COMBINATIONS */}
      {activeSubTab === 'factors' && currentDirectionStats && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-black text-zinc-100 uppercase tracking-tight flex items-center gap-2">
            <Sliders className="w-4 h-4 text-indigo-400" /> Эффективность комбинаций факторов ({activeSideView})
          </h3>

          <div className="space-y-3">
            {Object.entries(currentDirectionStats.byFactorCombinations).map(([fcName, m], idx) => (
              <div key={idx} className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                <div>
                  <h4 className="text-xs font-bold text-zinc-200">{fcName}</h4>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {m.totalTrades} сделок • Ср. R: +{m.avgRMultiple.toFixed(2)}R • Profit Factor: {m.profitFactor.toFixed(2)}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-xs font-mono font-bold text-emerald-400">+{m.totalPnlUsd.toFixed(2)}$</div>
                    <div className="text-[10px] font-bold text-emerald-500">{m.winRate.toFixed(1)}% Win Rate</div>
                  </div>
                  <div className="w-24 bg-zinc-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${Math.min(100, Math.max(5, m.winRate))}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-TAB 7: AUDITED TRADES LOGGER & DECISION TRACE */}
      {activeSubTab === 'audit_log' && (
        <div className="space-y-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div className="relative w-full md:w-80">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Поиск по символу, паттерну или режиму..."
                value={searchAuditTerm}
                onChange={e => setSearchAuditTerm(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="text-xs text-zinc-400">
              Найдено записей: <span className="font-bold text-zinc-200">{filteredAuditedTrades.length}</span>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 uppercase text-[10px] font-bold bg-zinc-950/50">
                    <th className="py-2.5 px-3">Символ & Направление</th>
                    <th className="py-2.5 px-3">Источник (Origin)</th>
                    <th className="py-2.5 px-3">Паттерн & Режим</th>
                    <th className="py-2.5 px-3 text-right">Вход / Выход</th>
                    <th className="py-2.5 px-3 text-right">PnL ($ / %)</th>
                    <th className="py-2.5 px-3 text-center">R-Multiple</th>
                    <th className="py-2.5 px-3 text-center">MAE / MFE</th>
                    <th className="py-2.5 px-3 text-center">Score / Trace</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 font-medium">
                  {filteredAuditedTrades.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-zinc-500 text-xs">
                        Нет сохранённых сделок для выбранного фильтра ({activeOriginFilter})
                      </td>
                    </tr>
                  ) : (
                    filteredAuditedTrades.map((t, idx) => (
                      <React.Fragment key={idx}>
                        <tr className="hover:bg-zinc-800/40 transition-colors">
                          <td className="py-3 px-3">
                            <div className="font-bold text-zinc-100">{t.symbol}</div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className={cn(
                                "px-1.5 py-0.2 text-[9px] font-black rounded",
                                t.side === 'LONG' ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                              )}>
                                {t.side} {t.leverage}x
                              </span>
                              <span className="text-[10px] text-zinc-500">{t.status}</span>
                            </div>
                          </td>

                          <td className="py-3 px-3">
                            <span className={cn(
                              "px-2 py-0.5 text-[9px] font-black rounded uppercase border",
                              t.dataOrigin === 'LIVE_WEEX' 
                                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" 
                                : t.dataOrigin === 'PAPER_SIM' 
                                  ? "bg-sky-500/10 text-sky-300 border-sky-500/30" 
                                  : t.dataOrigin === 'HISTORICAL_SEED'
                                    ? "bg-zinc-800 text-zinc-400 border-zinc-700"
                                    : "bg-zinc-900 text-zinc-400 border-zinc-800"
                            )}>
                              {t.dataOrigin === 'LIVE_WEEX' ? 'LIVE ⚡' : t.dataOrigin === 'PAPER_SIM' ? 'PAPER 🎮' : 'SEED 📜'}
                            </span>
                          </td>

                          <td className="py-3 px-3">
                            <div className="text-zinc-200 font-medium truncate max-w-xs">{t.pattern}</div>
                            <span className="text-[9px] px-1.5 py-0.2 bg-zinc-800 text-zinc-400 rounded">
                              {t.marketRegime}
                            </span>
                          </td>

                          <td className="py-3 px-3 text-right font-mono text-[11px]">
                            <div>${t.entryPrice}</div>
                            <div className="text-zinc-500 text-[10px]">выход: ${t.closePrice || '---'}</div>
                          </td>

                          <td className="py-3 px-3 text-right font-mono">
                            <div className={cn("font-bold text-xs", t.pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                              {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}$
                            </div>
                            <div className={cn("text-[10px]", t.pnlPercent >= 0 ? "text-emerald-500" : "text-rose-500")}>
                              {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(1)}%
                            </div>
                          </td>

                          <td className="py-3 px-3 text-center font-mono text-xs">
                            <span className={cn("font-bold", t.rMultiple >= 0 ? "text-indigo-300" : "text-rose-400")}>
                              {t.rMultiple >= 0 ? '+' : ''}{t.rMultiple.toFixed(2)}R
                            </span>
                          </td>

                          <td className="py-3 px-3 text-center font-mono text-[10px]">
                            <span className="text-rose-400">-{t.maePct}%</span> / <span className="text-emerald-400">+{t.mfePct}%</span>
                          </td>

                          <td className="py-3 px-3 text-center">
                            <button
                              onClick={() => setSelectedTraceTrade(selectedTraceTrade?.id === t.id ? null : t)}
                              className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-[10px] font-bold inline-flex items-center gap-1 border border-zinc-700"
                            >
                              <Bot className="w-3 h-3 text-indigo-400" />
                              {t.confidenceScore}%
                              {selectedTraceTrade?.id === t.id ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            </button>
                          </td>
                        </tr>

                        {/* Expanded Decision Trace Inspector */}
                        {selectedTraceTrade?.id === t.id && (
                          <tr className="bg-zinc-950 border-y border-indigo-900/30">
                            <td colSpan={8} className="p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-black text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                                  Decision Trace & Аудит факторов ({t.symbol})
                                </h5>
                                <span className="text-[10px] text-zinc-500">ID: {t.id}</span>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800 space-y-1.5">
                                  <div className="text-[10px] font-bold text-zinc-400 uppercase">Голоса Агентов (Consensus)</div>
                                  {t.decisionTrace?.agentVotes?.length ? (
                                    t.decisionTrace.agentVotes.map((v: any, vi: number) => (
                                      <div key={vi} className="flex justify-between items-center text-[11px]">
                                        <span className="text-zinc-300 font-medium">{v.agentName || v.agentId}</span>
                                        <div className="flex items-center gap-2">
                                          <span className="text-zinc-500">{v.confidence}%</span>
                                          <span className={cn(
                                            "px-1.5 py-0.2 rounded text-[9px] font-bold",
                                            v.vote?.includes('APPROVE') ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                                          )}>
                                            {v.vote}
                                          </span>
                                        </div>
                                      </div>
                                    ))
                                  ) : (
                                    <div className="text-zinc-500 text-[10px]">Автоматический консенсус ИИ: {t.confidenceScore}% (Sentinel Approved)</div>
                                  )}
                                </div>

                                <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800 space-y-1.5">
                                  <div className="text-[10px] font-bold text-zinc-400 uppercase">Метрики исполнения</div>
                                  <div className="flex justify-between text-[11px] text-zinc-400">
                                    <span>Комиссия биржи:</span>
                                    <span className="font-mono text-zinc-200">-${t.feeUsd.toFixed(2)}</span>
                                  </div>
                                  <div className="flex justify-between text-[11px] text-zinc-400">
                                    <span>Проскальзывание (Slippage):</span>
                                    <span className="font-mono text-zinc-200">{t.slippagePct}%</span>
                                  </div>
                                  <div className="flex justify-between text-[11px] text-zinc-400">
                                    <span>Время удержания:</span>
                                    <span className="font-mono text-zinc-200">{Math.round(t.holdDurationMs / 1000)} сек ({Math.round(t.holdDurationMs / 60000)} мин)</span>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
