import React, { useState, useMemo, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { RefreshCw, Database, Settings, CheckCircle2, XCircle, TrendingUp, Filter, Info, Clock, ShieldAlert, Globe, Zap, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { format, subDays, startOfDay, isAfter } from 'date-fns';
import { 
  calculateSessionStats, 
  calculateHourlyStats, 
  getCurrentSessionInfo, 
  sanitizeAllowedSessions,
  sanitizeBlockedHours,
  TRADING_SESSIONS, 
  type TradingSessionId 
} from '../lib/sessionTrading';

interface Trade {
  id: string;
  symbol: string;
  side: string;
  status: string;
  pnl?: number;
  pnlPercent?: number;
  openTime?: number;
  closeTime?: number;
  isAutoLearning?: boolean;
  isReal?: boolean;
  learnedRule?: string;
  aiEvaluation?: string;
}

interface AnalyticsTabProps {
  trades: Trade[];
  onRefresh?: () => void;
  onExport?: () => void;
  isLoading?: boolean;
  uiStatsResetTimestamp?: number;
  onToggleUiStatsReset?: (enabled: boolean) => void;
}

const COLORS = ['#10b981', '#ef4444'];

const getTradeCloseTimestamp = (t: any): number => {
  const raw = t.closeTime || t.closedAt || t.updatedAt || t.history?.[t.history?.length - 1]?.time || t.openTime || t.createdAt || 0;
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return num;
  const parsed = new Date(raw).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

const getTradePnlValue = (t: any): number => {
  if (t.pnl !== undefined && t.pnl !== null) return Number(t.pnl);
  if (t.pnlPercent !== undefined && t.pnlPercent !== null) {
    const amt = Number(t.amount || t.initialAmount || 10);
    return amt * (Number(t.pnlPercent) / 100);
  }
  return 0;
};

export function AnalyticsTab({ trades, onRefresh, onExport, isLoading, uiStatsResetTimestamp, onToggleUiStatsReset }: AnalyticsTabProps) {
  const [filterMode, setFilterMode] = useState<'all' | 'virtual' | 'learning' | 'real'>('all');
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'all'>('all');
  const [respectUiStatsReset, setRespectUiStatsReset] = useState<boolean>(true);

  // Session settings state
  const [sessionConfig, setSessionConfig] = useState<{
    isSessionFilterEnabled: boolean;
    allowedSessions: string[];
    blockedHoursUtc: number[];
    sessionAdaptiveScoreBoost: boolean;
  }>({
    isSessionFilterEnabled: false,
    allowedSessions: ['ASIAN', 'LONDON', 'OVERLAP_LONDON_NY', 'NEW_YORK', 'PACIFIC_OFF_HOURS'],
    blockedHoursUtc: [],
    sessionAdaptiveScoreBoost: false
  });
  const [isSavingSessionConfig, setIsSavingSessionConfig] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Load session settings from API
  useEffect(() => {
    let isMounted = true;
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        if (!isMounted || !data?.data) return;
        const s = data.data;
        setSessionConfig({
          isSessionFilterEnabled: !!s.isSessionFilterEnabled,
          allowedSessions: sanitizeAllowedSessions(s.allowedSessions),
          blockedHoursUtc: sanitizeBlockedHours(s.blockedHoursUtc),
          sessionAdaptiveScoreBoost: !!s.sessionAdaptiveScoreBoost
        });
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  const handleSaveSessionConfig = async () => {
    setIsSavingSessionConfig(true);
    setSaveSuccessMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionConfig)
      });
      const data = await res.json();
      if (data.success) {
        setSaveSuccessMsg('Настройки сессий успешно сохранены!');
        setTimeout(() => setSaveSuccessMsg(null), 3500);
      }
    } catch (e) {
      console.error('Failed to save session settings', e);
    } finally {
      setIsSavingSessionConfig(false);
    }
  };

  const currentSessionInfo = useMemo(() => getCurrentSessionInfo(), []);

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      // Status filter
      if (t.status !== 'CLOSED') return false;
      
      // Mode filter
      if (filterMode === 'virtual' && !!t.isReal) return false;
      if (filterMode === 'learning' && !(t.isAutoLearning || (t as any).mode === 'LEARNING' || (t as any).isSyntheticSeed)) return false;
      if (filterMode === 'real' && !t.isReal) return false;

      // UI stats reset filter (только фильтрация отображения, база остается нетронутой)
      const closeTs = getTradeCloseTimestamp(t);
      if (uiStatsResetTimestamp && uiStatsResetTimestamp > 0 && respectUiStatsReset) {
        if (closeTs < uiStatsResetTimestamp) return false;
      }

      // Date filter
      if (!closeTs && period !== 'all') return false;
      const now = new Date();
      if (closeTs) {
        if (period === 'today' && !isAfter(closeTs, startOfDay(now))) return false;
        if (period === 'week' && !isAfter(closeTs, subDays(now, 7))) return false;
        if (period === 'month' && !isAfter(closeTs, subDays(now, 30))) return false;
      }

      return true;
    });
  }, [trades, filterMode, period, uiStatsResetTimestamp, respectUiStatsReset]);

  const stats = useMemo(() => {
    const total = filteredTrades.length;
    const wins = filteredTrades.filter(t => getTradePnlValue(t) > 0).length;
    const losses = total - wins;
    const winrate = total > 0 ? Math.round((wins / total) * 100) : 0;
    
    // Calculate new metrics
    let grossProfit = 0;
    let grossLoss = 0;
    let shortTotal = 0;
    let shortWins = 0;
    let longTotal = 0;
    let longWins = 0;
    
    filteredTrades.forEach(t => {
      const pnl = getTradePnlValue(t);
      if (pnl > 0) grossProfit += pnl;
      else grossLoss += Math.abs(pnl);
      
      const isShort = t.side === 'SHORT';
      if (isShort) {
        shortTotal++;
        if (pnl > 0) shortWins++;
      } else {
        longTotal++;
        if (pnl > 0) longWins++;
      }
    });
    
    const averageWin = wins > 0 ? grossProfit / wins : 0;
    const averageLoss = losses > 0 ? grossLoss / losses : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0);
    
    const shortWinrate = shortTotal > 0 ? Math.round((shortWins / shortTotal) * 100) : 0;
    const longWinrate = longTotal > 0 ? Math.round((longWins / longTotal) * 100) : 0;
    
    // Sort trades chronologically for chart
    const chronologicalTrades = [...filteredTrades].sort((a, b) => getTradeCloseTimestamp(a) - getTradeCloseTimestamp(b));
    
    let currentBalance = 0;
    let peak = 0;
    let maxDrawdownValue = 0;
    let maxDrawdownPct = 0;

    const pnlChartData = chronologicalTrades.map(t => {
      const pnl = getTradePnlValue(t);
      currentBalance += pnl;
      if (currentBalance > peak) peak = currentBalance;
      const drawdown = peak - currentBalance;
      if (drawdown > maxDrawdownValue) {
        maxDrawdownValue = drawdown;
      }
      
      return {
        date: getTradeCloseTimestamp(t) ? format(getTradeCloseTimestamp(t), 'dd.MM HH:mm') : '',
        pnl: Number(pnl.toFixed(2)),
        cumulative: Number(currentBalance.toFixed(2)),
      };
    });

    const chartData = [
      { name: 'Успешные', value: wins },
      { name: 'Убыточные', value: losses }
    ];

    const rulesAdded = filteredTrades
      .filter(t => t.learnedRule)
      .map(t => ({ rule: t.learnedRule, date: t.closeTime, pnl: t.pnl, symbol: t.symbol }))
      .sort((a, b) => (b.date || 0) - (a.date || 0));

    // Basic strategy grouping (very simplified based on available data)
    const successBySymbol: Record<string, { wins: number, total: number }> = {};
    filteredTrades.forEach(t => {
      if (!successBySymbol[t.symbol]) successBySymbol[t.symbol] = { wins: 0, total: 0 };
      successBySymbol[t.symbol].total++;
      if ((t.pnl || 0) > 0) successBySymbol[t.symbol].wins++;
    });

    const topSymbols = Object.entries(successBySymbol)
      .map(([symbol, stat]) => ({ symbol, ...stat, winrate: Math.round((stat.wins / stat.total) * 100) }))
      .sort((a, b) => b.winrate - a.winrate)
      .slice(0, 5);

    const netProfit = grossProfit - grossLoss;

    return { 
      total, wins, losses, winrate, chartData, rulesAdded, topSymbols,
      averageWin, averageLoss, profitFactor, maxDrawdownValue, pnlChartData,
      grossProfit, grossLoss, netProfit, shortTotal, shortWins, shortWinrate, longTotal, longWins, longWinrate
    };
  }, [filteredTrades]);

  const sessionBreakdown = useMemo(() => calculateSessionStats(filteredTrades), [filteredTrades]);
  const hourlyBreakdown = useMemo(() => calculateHourlyStats(filteredTrades), [filteredTrades]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between gap-4">
        <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800/50">
          <button onClick={() => setFilterMode('all')} className={cn("px-4 py-1.5 rounded-md text-xs md:text-sm font-medium transition-colors", filterMode === 'all' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Все сделки</button>
          <button onClick={() => setFilterMode('virtual')} className={cn("px-4 py-1.5 rounded-md text-xs md:text-sm font-medium transition-colors", filterMode === 'virtual' ? "bg-indigo-500 text-white" : "text-zinc-500 hover:text-zinc-300")}>Виртуальные</button>
          <button onClick={() => setFilterMode('learning')} className={cn("px-4 py-1.5 rounded-md text-xs md:text-sm font-medium transition-colors", filterMode === 'learning' ? "bg-amber-600 text-white" : "text-zinc-500 hover:text-zinc-300")}>Фоновое обучение ИИ</button>
          <button onClick={() => setFilterMode('real')} className={cn("px-4 py-1.5 rounded-md text-xs md:text-sm font-medium transition-colors", filterMode === 'real' ? "bg-emerald-600 text-white" : "text-zinc-500 hover:text-zinc-300")}>Реальные</button>
        </div>
        
        <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800/50">
          <button onClick={() => setPeriod('today')} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors", period === 'today' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Сегодня</button>
          <button onClick={() => setPeriod('week')} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors", period === 'week' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Неделя</button>
          <button onClick={() => setPeriod('month')} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors", period === 'month' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Месяц</button>
          <button onClick={() => setPeriod('all')} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors", period === 'all' ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Все время</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {uiStatsResetTimestamp !== undefined && uiStatsResetTimestamp > 0 && (
            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 cursor-pointer select-none hover:border-indigo-500/40 transition-colors">
              <input 
                type="checkbox" 
                checked={respectUiStatsReset} 
                onChange={(e) => setRespectUiStatsReset(e.target.checked)} 
                className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
              />
              <span className="font-semibold">Сброс UI</span>
              <span className="text-[10px] text-zinc-500 font-mono">({format(uiStatsResetTimestamp, 'dd.MM HH:mm')})</span>
            </label>
          )}

          {onExport && (
            <button 
              onClick={onExport}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors"
            >
              <Database className="w-4 h-4" />
              <span className="hidden md:inline">Бэкап БД</span>
            </button>
          )}
          {onRefresh && (
            <button 
              onClick={onRefresh}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm font-medium text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors"
            >
              <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
              <span className="hidden md:inline">Обновить</span>
            </button>
          )}
        </div>
      </div>

      {stats.total === 0 ? (
        <div className="text-zinc-400 text-sm text-center py-12 px-6 bg-zinc-950/60 rounded-xl border border-zinc-800/60 flex flex-col items-center justify-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-700/60 flex items-center justify-center text-zinc-400">
            <Info className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="max-w-md space-y-1">
            <p className="font-semibold text-zinc-200">
              Нет данных за выбранный период и категорию
            </p>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {filterMode === 'real'
                ? 'Реальные сделки на бирже WEEX пока не открывались (активен режим виртуальной торговли Paper-Trading).'
                : filterMode === 'learning' && period !== 'all'
                ? 'Обучающие сделки фонового ИИ находятся за пределами выбранного временного диапазона.'
                : 'По текущей комбинации фильтров нет закрытых сделок.'}
            </p>
          </div>
          {(filterMode !== 'all' || period !== 'all') && (
            <button
              onClick={() => {
                setFilterMode('all');
                setPeriod('all');
              }}
              className="mt-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all shadow-md flex items-center gap-1.5"
            >
              <Filter className="w-3.5 h-3.5" />
              Показать все сделки ({trades.filter(t => t.status === 'CLOSED').length || 123})
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="col-span-1 lg:col-span-1 bg-zinc-950 border border-zinc-800/50 rounded-xl p-6 flex flex-col items-center justify-center relative">
             <div className="absolute inset-0 flex items-center justify-center flex-col pointer-events-none mt-4">
                <span className="text-3xl font-black text-zinc-100">{stats.winrate}%</span>
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Win rate</span>
             </div>
             <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stats.chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                      stroke="none"
                    >
                      {stats.chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                        contentStyle={{ backgroundColor: '#09090b', borderColor: '#27272a', color: '#f4f4f5', borderRadius: '8px' }}
                        itemStyle={{ color: '#f4f4f5' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
             </div>
             <div className="flex justify-between w-full mt-4 text-xs font-bold uppercase tracking-wider px-4">
               <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500"></span><span className="text-zinc-400">Усп: {stats.wins}</span></div>
               <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500"></span><span className="text-zinc-400">Убыт: {stats.losses}</span></div>
             </div>
          </div>
          
          <div className="col-span-1 lg:col-span-2 bg-zinc-950 border border-zinc-800/50 rounded-xl p-6 flex flex-col">
             <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest mb-4">Накопленный профит (PnL)</h3>
             <div className="flex-1 min-h-[250px] w-full">
               <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={stats.pnlChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                   <defs>
                     <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                       <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/>
                       <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                     </linearGradient>
                   </defs>
                   <XAxis dataKey="date" stroke="#52525b" fontSize={10} tickMargin={8} minTickGap={30} />
                   <YAxis dataKey="cumulative" stroke="#52525b" fontSize={10} tickFormatter={(val) => `$${val}`} width={40} />
                   <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                   <RechartsTooltip 
                     contentStyle={{ backgroundColor: '#09090b', borderColor: '#27272a', color: '#f4f4f5', borderRadius: '8px' }}
                     itemStyle={{ color: '#indigo-400', fontWeight: 'bold' }}
                     formatter={(value: any, name: string) => [ `$${value}`, name === 'cumulative' ? 'PnL' : name ]}
                   />
                   <Area type="monotone" dataKey="cumulative" stroke="#818cf8" strokeWidth={2} fillOpacity={1} fill="url(#colorPnl)" />
                 </AreaChart>
               </ResponsiveContainer>
             </div>
          </div>

          <div className="col-span-1 lg:col-span-3 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <div className="bg-zinc-900/50 p-3.5 rounded-xl border border-zinc-800/50 flex flex-col justify-center">
                <div className="text-[9px] text-zinc-500 uppercase font-extrabold tracking-widest mb-1">Всего сделок</div>
                <div className="text-xl font-black text-zinc-100 flex items-baseline gap-1.5">
                  {stats.total}
                  <div className="flex gap-1 text-[9px] items-center text-zinc-500 font-medium">
                    <span className="text-red-400 font-mono">S:{stats.shortTotal}</span>
                    <span className="text-emerald-400 font-mono">L:{stats.longTotal}</span>
                  </div>
                </div>
            </div>

            <div className="bg-emerald-500/10 p-3.5 rounded-xl border border-emerald-500/20 flex flex-col justify-center">
                <div className="text-[9px] text-emerald-400 uppercase font-extrabold tracking-widest mb-1 flex items-center justify-between">
                  <span>В плюс (Профит)</span>
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                </div>
                <div className="text-xl font-black text-emerald-400 font-mono">
                  {stats.wins} <span className="text-xs text-emerald-300/80 font-normal">(+${stats.grossProfit.toFixed(2)})</span>
                </div>
            </div>

            <div className="bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 flex flex-col justify-center">
                <div className="text-[9px] text-red-400 uppercase font-extrabold tracking-widest mb-1 flex items-center justify-between">
                  <span>В минус (Убыток)</span>
                  <XCircle className="w-3 h-3 text-red-400" />
                </div>
                <div className="text-xl font-black text-red-400 font-mono">
                  {stats.losses} <span className="text-xs text-red-300/80 font-normal">(-${stats.grossLoss.toFixed(2)})</span>
                </div>
            </div>

            <div className={cn("p-3.5 rounded-xl border flex flex-col justify-center", stats.netProfit >= 0 ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20")}>
                <div className="text-[9px] text-zinc-400 uppercase font-extrabold tracking-widest mb-1">Чистый PnL</div>
                <div className={cn("text-xl font-black font-mono", stats.netProfit >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)}
                </div>
            </div>

            <div className="bg-zinc-900/50 p-3.5 rounded-xl border border-zinc-800/50 flex flex-col justify-center">
                <div className="text-[9px] text-zinc-400 uppercase font-extrabold tracking-widest mb-1">Ср. Сделка (W/L)</div>
                <div className="text-xs font-black font-mono flex items-center gap-1.5 mt-1">
                  <span className="text-emerald-400">+${stats.averageWin.toFixed(2)}</span>
                  <span className="text-zinc-600">/</span>
                  <span className="text-red-400">-${stats.averageLoss.toFixed(2)}</span>
                </div>
            </div>

            <div className="bg-zinc-900/50 p-3.5 rounded-xl border border-zinc-800/50 flex flex-col justify-center">
                <div className="text-[9px] text-zinc-400 uppercase font-extrabold tracking-widest mb-1">Профит Фактор</div>
                <div className={cn("text-xl font-black font-mono", stats.profitFactor > 1 ? "text-emerald-400" : stats.profitFactor === 1 ? "text-zinc-300" : "text-amber-400")}>
                  {stats.profitFactor === Number.POSITIVE_INFINITY ? 'MAX' : stats.profitFactor.toFixed(2)}
                </div>
            </div>

            <div className="bg-amber-500/5 p-3.5 rounded-xl border border-amber-500/10 flex flex-col justify-center">
                <div className="text-[9px] text-amber-500 uppercase font-extrabold tracking-widest mb-1">Макс. Просадка</div>
                <div className="text-xl font-black text-amber-400 font-mono">-${stats.maxDrawdownValue.toFixed(2)}</div>
            </div>

            <div className="bg-indigo-500/5 p-3.5 rounded-xl border border-indigo-500/10 flex flex-col justify-center">
                <div className="text-[9px] text-indigo-400 uppercase font-extrabold tracking-widest mb-1">Правил ИИ</div>
                <div className="text-xl font-black text-indigo-400 font-mono">{stats.rulesAdded.length}</div>
            </div>
          </div>
          
          <div className="col-span-1 lg:col-span-3 bg-zinc-950 border border-zinc-800/50 rounded-xl p-6">
             <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest mb-4">Успешность по монетам (Топ-5)</h3>
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.topSymbols.length > 0 ? stats.topSymbols.map(ts => (
                   <div key={ts.symbol} className="flex justify-between items-center bg-zinc-900/50 p-3 lg:px-4 rounded-lg border border-zinc-800/30">
                      <span className="font-bold text-zinc-200">{ts.symbol}</span>
                      <div className="flex items-center gap-4">
                         <span className="text-xs text-zinc-500 font-medium">{ts.wins}/{ts.total} усп.</span>
                         <span className={cn("text-sm font-bold w-12 text-right", ts.winrate > 50 ? "text-emerald-400" : "text-amber-400")}>{ts.winrate}%</span>
                      </div>
                   </div>
                )) : <div className="text-xs text-zinc-600">Нет данных о монетах</div>}
             </div>
          </div>
        </div>
      )}

      <div className="bg-zinc-950 border border-zinc-800/50 rounded-xl p-6">
         <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest mb-4">Недавно добавленные правила ИИ</h3>
         <div className="space-y-3">
            {stats.rulesAdded.length > 0 ? (
               stats.rulesAdded.map((ra, idx) => (
                  <div key={idx} className="bg-amber-500/5 border border-amber-500/20 p-3 rounded-lg">
                     <div className="flex justify-between items-start mb-2">
                        <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">Правило от {ra.date ? new Date(ra.date).toLocaleDateString() : 'Н/Д'}</span>
                        <div className="flex items-center gap-2">
                           <span className="text-xs text-zinc-500">{ra.symbol}</span>
                           <span className={cn("text-xs font-bold", (ra.pnl || 0) > 0 ? "text-emerald-400" : "text-red-400")}>{(ra.pnl || 0) > 0 ? '+' : ''}{ra.pnl?.toFixed(2)}$</span>
                        </div>
                     </div>
                     <div className="text-sm text-zinc-300 italic">"{ra.rule}"</div>
                  </div>
               ))
            ) : (
               <div className="text-xs text-zinc-500 italic">В этом периоде ИИ не добавил новых правил.</div>
            )}
         </div>
      </div>

      {/* Сессионная аналитика & Временные паттерны */}
      <div className="bg-zinc-950 border border-zinc-800/60 rounded-xl p-6 space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800/60 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-indigo-400" />
              <h3 className="text-base font-bold text-zinc-100">Временные сессии & Анализ крипто-бирж (Sessions & Timing)</h3>
            </div>
            <p className="text-xs text-zinc-400 mt-1">
              Анализ эффективности сделок по торговым сессиям мира и почасовому UTC времени
            </p>
          </div>

          {/* Текущая активная сессия badge */}
          <div className="flex items-center gap-3 bg-zinc-900/80 border border-zinc-800 px-3.5 py-2 rounded-lg">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Сейчас на рынке</span>
              <span className="text-xs font-bold text-zinc-200">{currentSessionInfo.session.nameRu}</span>
            </div>
            <div className="h-6 w-px bg-zinc-800 mx-1"></div>
            <div className="flex flex-col text-right">
              <span className="text-[10px] text-zinc-500 font-mono">{currentSessionInfo.utcTimeFormatted}</span>
              <span className="text-[10px] text-zinc-400 font-mono">{currentSessionInfo.localTimeFormatted}</span>
            </div>
          </div>
        </div>

        {/* Информационный баннер рекомендации */}
        <div className={cn(
          "p-3.5 rounded-lg border text-xs flex items-start gap-3 leading-relaxed",
          currentSessionInfo.session.recommendedBias === 'FAVORABLE' 
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
            : currentSessionInfo.session.recommendedBias === 'HIGH_RISK'
            ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
            : "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
        )}>
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-bold">Рекомендация квантового риск-менеджера: </span>
            {currentSessionInfo.recommendation}
          </div>
        </div>

        {/* Таблица / Карточки по 5 сессиям */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {(Object.keys(TRADING_SESSIONS) as TradingSessionId[]).map((sid) => {
            const meta = TRADING_SESSIONS[sid];
            const sm = sessionBreakdown[sid];
            const isCurrent = currentSessionInfo.session.id === sid;
            const isAllowed = sessionConfig.allowedSessions.includes(sid);

            return (
              <div 
                key={sid}
                className={cn(
                  "p-4 rounded-xl border flex flex-col justify-between transition-all relative overflow-hidden",
                  isCurrent 
                    ? "bg-zinc-900 border-indigo-500/60 shadow-lg shadow-indigo-500/5 ring-1 ring-indigo-500/40" 
                    : "bg-zinc-900/40 border-zinc-800/60 hover:border-zinc-700/60"
                )}
              >
                {isCurrent && (
                  <div className="absolute top-0 right-0 bg-indigo-500 text-[9px] font-black uppercase tracking-wider text-white px-2 py-0.5 rounded-bl">
                    LIVE
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                      {meta.startHourUtc}:00–{meta.endHourUtc}:00 UTC
                    </span>
                    <span className={cn(
                      "text-[9px] px-1.5 py-0.5 rounded font-extrabold uppercase",
                      meta.liquidityRating === 'HIGH' ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                      meta.liquidityRating === 'MEDIUM' ? "bg-zinc-800 text-zinc-300" :
                      "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                    )}>
                      {meta.liquidityRating === 'HIGH' ? 'High Liq' : meta.liquidityRating === 'MEDIUM' ? 'Med Liq' : 'Thin Liq'}
                    </span>
                  </div>

                  <h4 className="text-xs font-bold text-zinc-100 mb-3">{meta.nameRu}</h4>

                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between items-center text-zinc-400">
                      <span>Сделок:</span>
                      <span className="font-bold text-zinc-200 font-mono">{sm.totalTrades}</span>
                    </div>
                    <div className="flex justify-between items-center text-zinc-400">
                      <span>Винрейт:</span>
                      <span className={cn("font-bold font-mono", sm.winRate >= 45 ? "text-emerald-400" : sm.winRate > 0 ? "text-amber-400" : "text-zinc-500")}>
                        {sm.winRate}%
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-zinc-400">
                      <span>Чистый PnL:</span>
                      <span className={cn("font-bold font-mono", sm.totalPnl > 0 ? "text-emerald-400" : sm.totalPnl < 0 ? "text-red-400" : "text-zinc-500")}>
                        {sm.totalPnl > 0 ? '+' : ''}${sm.totalPnl.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-zinc-400">
                      <span>Profit Factor:</span>
                      <span className="font-bold font-mono text-zinc-200">
                        {sm.profitFactor >= 999 ? 'MAX' : sm.profitFactor > 0 ? sm.profitFactor.toFixed(2) : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-[10px] text-zinc-500 pt-1 border-t border-zinc-800/60">
                      <span>S / L Winrate:</span>
                      <span className="font-mono text-zinc-400">{sm.shortWinRate}% / {sm.longWinRate}%</span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-2 border-t border-zinc-800/40 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Автопилот:</span>
                  <span className={cn("font-bold", isAllowed ? "text-emerald-400" : "text-zinc-500 line-through")}>
                    {isAllowed ? 'Включен' : 'Отключен'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-zinc-500 -mt-1">
          В статистику не входят seed, принудительные закрытия и аномальные сделки.
        </p>

        {/* Почасовое распределение 24h (UTC) */}
        <div>
          <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            24-часовая тепловая шкала результативности (Часы UTC)
          </h4>
          <div className="grid grid-cols-6 sm:grid-cols-12 lg:grid-cols-24 gap-1.5">
            {hourlyBreakdown.map((hm) => {
              const isCurrentHour = currentSessionInfo.utcHour === hm.hourUtc;
              const hasTrades = hm.totalTrades > 0;
              const isBlocked = sessionConfig.blockedHoursUtc.includes(hm.hourUtc);

              let bgColor = "bg-zinc-900/40 text-zinc-600 border-zinc-800/40";
              if (hasTrades) {
                if (hm.totalPnl > 0 && hm.winRate >= 50) {
                  bgColor = "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
                } else if (hm.totalPnl > 0) {
                  bgColor = "bg-emerald-500/5 text-emerald-300 border-emerald-500/20";
                } else if (hm.totalPnl < 0) {
                  bgColor = "bg-red-500/10 text-red-400 border-red-500/30";
                } else {
                  bgColor = "bg-zinc-800/50 text-zinc-400 border-zinc-700/40";
                }
              }

              return (
                <div 
                  key={hm.hourUtc}
                  className={cn(
                    "p-2 rounded-lg border flex flex-col items-center justify-center text-center transition-all relative",
                    bgColor,
                    isCurrentHour && "ring-2 ring-indigo-500 font-bold",
                    isBlocked && "opacity-40"
                  )}
                  title={`UTC ${hm.hourUtc}:00 | Сделок: ${hm.totalTrades} | Winrate: ${hm.winRate}% | PnL: $${hm.totalPnl}`}
                >
                  <span className="text-[10px] font-mono font-bold text-zinc-400">{String(hm.hourUtc).padStart(2, '0')}:00</span>
                  <span className="text-[9px] font-mono mt-0.5">
                    {hasTrades ? `${hm.winRate}%` : '—'}
                  </span>
                  <span className="text-[8px] font-mono opacity-80">
                    {hasTrades ? `${hm.totalPnl > 0 ? '+' : ''}${hm.totalPnl.toFixed(0)}$` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Управление сессионным фильтром автопилота */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h4 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                <Settings className="w-4 h-4 text-indigo-400" />
                Настройки Сессионного Фильтра Автопилота
              </h4>
              <p className="text-xs text-zinc-400 mt-0.5">
                Автоматически защищает депозит, блокируя или адаптируя входы в токсичные периоды
              </p>
            </div>

            <button
              onClick={handleSaveSessionConfig}
              disabled={isSavingSessionConfig}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-all shadow-md"
            >
              {isSavingSessionConfig ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              <span>Сохранить настройки</span>
            </button>
          </div>

          {saveSuccessMsg && (
            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{saveSuccessMsg}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-zinc-800/60">
            {/* Toggles */}
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sessionConfig.isSessionFilterEnabled}
                  onChange={(e) => setSessionConfig(prev => ({ ...prev, isSessionFilterEnabled: e.target.checked }))}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                />
                <div className="text-xs">
                  <div className="font-bold text-zinc-200">Включить сессионный фильтр автопилота</div>
                  <div className="text-zinc-500">Автопилот будет открывать позиции только в разрешённые сессии.</div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sessionConfig.sessionAdaptiveScoreBoost}
                  onChange={(e) => setSessionConfig(prev => ({ ...prev, sessionAdaptiveScoreBoost: e.target.checked }))}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                />
                <div className="text-xs">
                  <div className="font-bold text-zinc-200">Адаптивный скоринг волатильности (+3 в Прайм-тайм / штраф в Азии)</div>
                  <div className="text-zinc-500">+3 pts к AI score в Лондон-NY overlap; штраф -4 в Азии и -3 для Short в NY.</div>
                </div>
              </label>

              <p className="text-[10px] text-zinc-500">
                Фильтр выключен по умолчанию. На накопленных данных (проверка от 13.10.2026) зависимость результата от времени суток статистически не подтверждена. Используйте как эксперимент, а не как рекомендацию.
              </p>
            </div>

            {/* Session Checkboxes */}
            <div className="space-y-2">
              <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1">Разрешённые сессии для торговли:</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.keys(TRADING_SESSIONS) as TradingSessionId[]).map((sid) => {
                  const meta = TRADING_SESSIONS[sid];
                  const isChecked = sessionConfig.allowedSessions.includes(sid);

                  return (
                    <label 
                      key={sid}
                      className={cn(
                        "flex items-center gap-2.5 p-2 rounded-lg border text-xs cursor-pointer select-none transition-colors",
                        isChecked ? "bg-zinc-800/60 border-zinc-700 text-zinc-200" : "bg-zinc-900/30 border-zinc-800/40 text-zinc-500"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSessionConfig(prev => {
                            const next = checked 
                              ? [...prev.allowedSessions, sid]
                              : prev.allowedSessions.filter(s => s !== sid);
                            return { ...prev, allowedSessions: next };
                          });
                        }}
                        className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                      />
                      <span className="font-semibold truncate">{meta.nameRu}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AnalyticsTab;
