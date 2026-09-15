import React, { useState, useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { RefreshCw, Database, Settings, CheckCircle2, XCircle, TrendingUp, Filter, Info } from 'lucide-react';
import { cn } from '../lib/utils';
import { format, subDays, startOfDay, isAfter } from 'date-fns';

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
}

const COLORS = ['#10b981', '#ef4444'];

const getTradeCloseTimestamp = (t: any): number => {
  return t.closeTime || t.closedAt || t.history?.[t.history?.length - 1]?.time || t.openTime || 0;
};

const getTradePnlValue = (t: any): number => {
  if (t.pnl !== undefined && t.pnl !== null) return Number(t.pnl);
  if (t.pnlPercent !== undefined && t.pnlPercent !== null) {
    const amt = Number(t.amount || t.initialAmount || 10);
    return amt * (Number(t.pnlPercent) / 100);
  }
  return 0;
};

export function AnalyticsTab({ trades, onRefresh, onExport, isLoading }: AnalyticsTabProps) {
  const [filterMode, setFilterMode] = useState<'all' | 'virtual' | 'learning' | 'real'>('all');
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'all'>('all');

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      // Status filter
      if (t.status !== 'CLOSED') return false;
      
      // Mode filter
      if (filterMode === 'virtual' && !!t.isReal) return false;
      if (filterMode === 'learning' && !(t.isAutoLearning || (t as any).mode === 'LEARNING' || (t as any).isSyntheticSeed)) return false;
      if (filterMode === 'real' && !t.isReal) return false;

      // Date filter
      const closeTs = getTradeCloseTimestamp(t);
      if (!closeTs && period !== 'all') return false;
      const now = new Date();
      if (closeTs) {
        if (period === 'today' && !isAfter(closeTs, startOfDay(now))) return false;
        if (period === 'week' && !isAfter(closeTs, subDays(now, 7))) return false;
        if (period === 'month' && !isAfter(closeTs, subDays(now, 30))) return false;
      }

      return true;
    });
  }, [trades, filterMode, period]);

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

        <div className="flex items-center gap-2">
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
    </div>
  );
}
