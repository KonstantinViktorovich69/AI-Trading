import React, { useState, useEffect } from 'react';
import { History, Play, CheckCircle2, TrendingUp, ShieldAlert, Zap, ArrowUpRight, ArrowDownRight, RefreshCw, Sparkles } from 'lucide-react';

interface ScenarioSummary {
  totalPnlPct: number;
  winRate: number;
  deltaPnlVsActualPct: number;
  bestScenarioTradeCount: number;
}

interface TopAdaptiveLesson {
  patternName: string;
  bestScenario: string;
  advantagePct: number;
  sampleSize: number;
  recommendation: string;
}

interface TimeMachineSummary {
  totalAnalyzedTrades: number;
  actualTotalPnlPct: number;
  actualWinRate: number;
  scenarioSummaries: Record<string, ScenarioSummary>;
  overallBestScenario: string;
  topAdaptiveLessons: TopAdaptiveLesson[];
  simulatedAt: number;
}

interface TradeAnalysisSample {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  patternName: string;
  openTime: number;
  closeTime: number;
  actualResult: {
    pnlPercent: number;
    pnlUsdt: number;
    closeReason: string;
    isWin: boolean;
  };
  bestScenario: string;
  deltaPnlVsActual: number;
  recommendedAction: string;
  scenarios: Record<string, {
    scenarioName: string;
    pnlPercent: number;
    closeReason: string;
    isWin: boolean;
  }>;
}

export const TimeMachineView: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [summary, setSummary] = useState<TimeMachineSummary | null>(null);
  const [analyses, setAnalyses] = useState<TradeAnalysisSample[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<TradeAnalysisSample | null>(null);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

  const fetchSummary = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/time-machine/summary');
      const data = await res.json();
      if (data.success && data.data) {
        setSummary(data.data);
        if (data.analysesSample && Array.isArray(data.analysesSample)) {
          setAnalyses(data.analysesSample);
          if (data.analysesSample.length > 0) {
            setSelectedTrade(data.analysesSample[0]);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load Time Machine summary:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  const handleApplyLearnings = async () => {
    setIsApplying(true);
    setAppliedMessage(null);
    try {
      const res = await fetch('/api/time-machine/apply-learnings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        setAppliedMessage(data.message || 'Уроки успешно применены в базу знаний!');
        setTimeout(() => setAppliedMessage(null), 6000);
      }
    } catch (e: any) {
      console.error('Failed to apply learnings:', e);
      setAppliedMessage(`Ошибка применения: ${e?.message || e}`);
    } finally {
      setIsApplying(false);
    }
  };

  const scenarioDisplayNames: Record<string, { name: string; desc: string }> = {
    ACTUAL: { name: 'Фактический исход', desc: 'Реальные выходы позиций из истории сделок' },
    OTE_ENTRY: { name: 'Вход OTE (0.618 Fib)', desc: 'Лимитный вход в зоне отката 50%-61.8% от импульса' },
    TRAILING_STOP: { name: 'Dynamic Trailing Stop', desc: 'Подтягивание стопа на дистанции 1.5% после достижения +5%' },
    PTTP_PROFIT: { name: 'PTTP Трейлинг от пика', desc: 'Фиксация прибыли при откате на 35% от максимального пика' },
    BREAKEVEN_QUICK: { name: 'Быстрый безубыток (+2%)', desc: 'Гарантированный перенос стопа в +0.3% при профите +2%' }
  };

  if (loading && !summary) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-zinc-400">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-400 mb-4" />
        <span className="text-sm font-medium tracking-wide">Машина времени: симуляция альтернативных исходов сделок...</span>
      </div>
    );
  }

  const bestScenarioKey = summary?.overallBestScenario || 'ACTUAL';
  const bestSummary = summary?.scenarioSummaries?.[bestScenarioKey];
  const deltaPnl = bestSummary?.deltaPnlVsActualPct ?? 0;

  return (
    <div className="space-y-6">
      {/* Верхний заголовок и панель действий */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-semibold text-zinc-100">Машина времени & Многосценарный бэктестинг</h2>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Ретроспективное проигрывание завершённых сделок по минутным свечам биржи WEEX для выявления идеальных параметров входа и выходов.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchSummary}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Обновить симуляции
          </button>

          <button
            onClick={handleApplyLearnings}
            disabled={isApplying}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-500 rounded-md shadow-sm transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {isApplying ? 'Интеграция...' : 'Применить опыт в самообучение'}
          </button>
        </div>
      </div>

      {appliedMessage && (
        <div className="p-3 bg-emerald-950/60 border border-emerald-500/30 rounded-lg text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{appliedMessage}</span>
        </div>
      )}

      {/* Ключевые показатели эффективности */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
          <span className="text-xs text-zinc-400 block">Проанализировано сделок</span>
          <span className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1 block">
            {summary?.totalAnalyzedTrades ?? 0}
          </span>
          <span className="text-[11px] text-zinc-500 mt-1 block">Исторические завершённые сделки</span>
        </div>

        <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
          <span className="text-xs text-zinc-400 block">Фактический результат (Факт)</span>
          <span className={`text-2xl font-bold font-mono tabular-nums mt-1 block ${(summary?.actualTotalPnlPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {(summary?.actualTotalPnlPct ?? 0) > 0 ? '+' : ''}{(summary?.actualTotalPnlPct ?? 0).toFixed(1)}%
          </span>
          <span className="text-[11px] text-zinc-500 mt-1 block font-mono tabular-nums">
            Винрейт: {summary?.actualWinRate ?? 0}%
          </span>
        </div>

        <div className="p-4 bg-zinc-900 border border-cyan-900/50 rounded-lg">
          <span className="text-xs text-cyan-400 font-medium block">Оптимальная стратегия выхода</span>
          <span className="text-base font-bold text-zinc-100 mt-1 block truncate">
            {scenarioDisplayNames[bestScenarioKey]?.name || bestScenarioKey}
          </span>
          <span className="text-[11px] text-emerald-400 mt-1 block font-mono tabular-nums">
            Винрейт: {bestSummary?.winRate ?? 0}% ({bestSummary?.totalPnlPct ?? 0}% PnL)
          </span>
        </div>

        <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
          <span className="text-xs text-zinc-400 block">Потенциал оптимизации PnL</span>
          <span className={`text-2xl font-bold font-mono tabular-nums mt-1 block ${deltaPnl >= 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
            {deltaPnl > 0 ? `+${deltaPnl.toFixed(1)}%` : `${deltaPnl.toFixed(1)}%`}
          </span>
          <span className="text-[11px] text-zinc-500 mt-1 block">
            Прирост прибыли при адаптации правил
          </span>
        </div>
      </div>

      {/* Сравнительная матрица сценариев */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Сравнение сценариев сопровождения</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {summary && Object.entries(summary.scenarioSummaries).map(([scId, sc]) => {
            const isBest = scId === summary.overallBestScenario;
            const meta = scenarioDisplayNames[scId] || { name: scId, desc: '' };
            return (
              <div
                key={scId}
                className={`p-3.5 rounded-lg border transition-all ${
                  isBest
                    ? 'bg-cyan-950/20 border-cyan-500/40 shadow-sm'
                    : 'bg-zinc-900 border-zinc-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-200 truncate">{meta.name}</span>
                  {isBest && (
                    <span className="text-[10px] font-bold text-cyan-300 uppercase tracking-wider">Лучший</span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500 mt-1 line-clamp-2 h-8">{meta.desc}</p>
                <div className="mt-3 pt-3 border-t border-zinc-800/80 space-y-1 font-mono tabular-nums text-xs">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">PnL:</span>
                    <span className={sc.totalPnlPct >= 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                      {sc.totalPnlPct > 0 ? '+' : ''}{sc.totalPnlPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Win Rate:</span>
                    <span className="text-zinc-300">{sc.winRate}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Δ vs Факт:</span>
                    <span className={sc.deltaPnlVsActualPct >= 0 ? 'text-emerald-400' : 'text-zinc-400'}>
                      {sc.deltaPnlVsActualPct > 0 ? `+${sc.deltaPnlVsActualPct.toFixed(1)}%` : `${sc.deltaPnlVsActualPct.toFixed(1)}%`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Уроки и рекомендации самообучения */}
      {summary && summary.topAdaptiveLessons.length > 0 && (
        <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-zinc-200">Выводы Машины Времени для самообучения системы</h3>
          </div>
          <div className="divide-y divide-zinc-800 text-xs">
            {summary.topAdaptiveLessons.map((lesson, idx) => (
              <div key={idx} className="py-2.5 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="font-semibold text-zinc-200">{lesson.patternName}</span>
                  <p className="text-zinc-400 text-[11px]">{lesson.recommendation}</p>
                </div>
                <div className="flex items-center gap-4 text-right shrink-0 font-mono tabular-nums">
                  <div className="text-[11px]">
                    <span className="text-zinc-500 block">Преимущество</span>
                    <span className="text-emerald-400 font-bold">+{lesson.advantagePct}%</span>
                  </div>
                  <div className="text-[11px]">
                    <span className="text-zinc-500 block">Выборка</span>
                    <span className="text-zinc-300">{lesson.sampleSize} сделок</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Таблица проигранных сделок */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Выборка симулированных сделок</h3>
        <div className="overflow-x-auto border border-zinc-800 rounded-lg">
          <table className="w-full text-xs text-left">
            <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800 font-medium">
              <tr>
                <th className="px-4 py-2.5">Монета / Направление</th>
                <th className="px-4 py-2.5">Паттерн входа</th>
                <th className="px-4 py-2.5 text-right font-mono">Фактический PnL</th>
                <th className="px-4 py-2.5">Лучший сценарий</th>
                <th className="px-4 py-2.5 text-right font-mono">Прирост PnL</th>
                <th className="px-4 py-2.5">Рекомендация</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80 bg-zinc-900/40">
              {analyses.map((a) => {
                const isSelected = selectedTrade?.tradeId === a.tradeId;
                const isShort = a.side === 'SHORT';
                return (
                  <tr
                    key={a.tradeId}
                    onClick={() => setSelectedTrade(a)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'
                    }`}
                  >
                    <td className="px-4 py-3 font-semibold text-zinc-200">
                      <div className="flex items-center gap-1.5">
                        <span className={isShort ? 'text-rose-400' : 'text-emerald-400'}>
                          {isShort ? <ArrowDownRight className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                        </span>
                        <span>{a.symbol.replace(/[\/:]/g, '')}</span>
                        <span className={`text-[10px] px-1 py-0.5 rounded ${isShort ? 'bg-rose-950/60 text-rose-300' : 'bg-emerald-950/60 text-emerald-300'}`}>
                          {a.side}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-300 truncate max-w-xs">{a.patternName}</td>
                    <td className={`px-4 py-3 text-right font-mono font-semibold tabular-nums ${a.actualResult.pnlPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {a.actualResult.pnlPercent > 0 ? '+' : ''}{a.actualResult.pnlPercent.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 font-medium text-cyan-300">
                      {scenarioDisplayNames[a.bestScenario]?.name || a.bestScenario}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-bold tabular-nums ${a.deltaPnlVsActual > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {a.deltaPnlVsActual > 0 ? `+${a.deltaPnlVsActual.toFixed(1)}%` : '0.0%'}
                    </td>
                    <td className="px-4 py-3 text-zinc-400 text-[11px] truncate max-w-md">{a.recommendedAction}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Детальный просмотр выбранной сделки */}
      {selectedTrade && (
        <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div className="flex items-center gap-2">
              <span className="font-bold text-zinc-100">{selectedTrade.symbol}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${selectedTrade.side === 'SHORT' ? 'bg-rose-950 text-rose-300' : 'bg-emerald-950 text-emerald-300'}`}>
                {selectedTrade.side} {selectedTrade.leverage}x
              </span>
              <span className="text-xs text-zinc-400 font-mono">ID: {selectedTrade.tradeId}</span>
            </div>
            <span className="text-xs font-semibold text-cyan-400">
              Оптимальный сценарий: {scenarioDisplayNames[selectedTrade.bestScenario]?.name}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {Object.entries(selectedTrade.scenarios).map(([scId, res]) => {
              const isBest = scId === selectedTrade.bestScenario;
              return (
                <div
                  key={scId}
                  className={`p-3 rounded-md border ${
                    isBest ? 'bg-cyan-950/30 border-cyan-500/50' : 'bg-zinc-950 border-zinc-800/80'
                  }`}
                >
                  <span className="text-[11px] font-semibold text-zinc-300 block truncate">
                    {scenarioDisplayNames[scId]?.name || scId}
                  </span>
                  <span className={`text-base font-bold font-mono tabular-nums block mt-1 ${res.pnlPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {res.pnlPercent > 0 ? '+' : ''}{res.pnlPercent.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-zinc-500 block truncate mt-1" title={res.closeReason}>
                    {res.closeReason}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
