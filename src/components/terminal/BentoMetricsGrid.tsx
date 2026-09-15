import React from 'react';
import { TrendingUp, TrendingDown, Shield, Brain, Zap, DollarSign, Activity, Percent } from 'lucide-react';

interface BentoMetricsProps {
  virtualBalance: number;
  realBalance?: number;
  openPositionsCount: number;
  totalClosedTrades: number;
  winRate: number;
  todayPnl: number;
  isAutoPilotActive: boolean;
  marketRegime: string;
}

export const BentoMetricsGrid: React.FC<BentoMetricsProps> = ({
  virtualBalance,
  realBalance,
  openPositionsCount,
  totalClosedTrades,
  winRate,
  todayPnl,
  isAutoPilotActive,
  marketRegime
}) => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      {/* 1. Виртуальный / Реальный Баланс */}
      <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3.5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
          <span className="font-semibold uppercase tracking-wider text-[11px] flex items-center gap-1">
            <DollarSign className="w-3.5 h-3.5 text-yellow-500" />
            Баланс Депозита
          </span>
          <span className="text-[10px] bg-yellow-500/10 text-yellow-400 px-1.5 py-0.5 rounded font-bold border border-yellow-500/20">
            AUTO-TRADING
          </span>
        </div>
        <div className="text-xl font-black text-zinc-100 font-mono tracking-tight">
          ${virtualBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        {realBalance !== undefined && realBalance > 0 && (
          <div className="text-[11px] text-zinc-400 font-mono mt-0.5">
            WEEX Real: <span className="text-emerald-400 font-bold">${realBalance.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* 2. PnL и Результат за сутки */}
      <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3.5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
          <span className="font-semibold uppercase tracking-wider text-[11px] flex items-center gap-1">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            PnL за 24 Часа
          </span>
          {todayPnl >= 0 ? (
            <span className="text-emerald-400 flex items-center text-[10px] font-bold gap-0.5 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
              <TrendingUp className="w-3 h-3" /> +${todayPnl.toFixed(2)}
            </span>
          ) : (
            <span className="text-rose-400 flex items-center text-[10px] font-bold gap-0.5 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">
              <TrendingDown className="w-3 h-3" /> -${Math.abs(todayPnl).toFixed(2)}
            </span>
          )}
        </div>
        <div className={`text-xl font-black font-mono tracking-tight ${todayPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {todayPnl >= 0 ? `+$${todayPnl.toFixed(2)}` : `-$${Math.abs(todayPnl).toFixed(2)}`}
        </div>
        <div className="text-[11px] text-zinc-400 mt-0.5 flex justify-between">
          <span>Открыто позиций: <strong className="text-zinc-200">{openPositionsCount}</strong></span>
          <span>Всего сделок: <strong className="text-zinc-200">{totalClosedTrades}</strong></span>
        </div>
      </div>

      {/* 3. Эффективность / WinRate ИИ */}
      <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3.5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
          <span className="font-semibold uppercase tracking-wider text-[11px] flex items-center gap-1">
            <Percent className="w-3.5 h-3.5 text-emerald-400" />
            Винрейт Сигналов
          </span>
          <span className="text-[10px] text-indigo-400 font-bold bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
            {winRate >= 65 ? 'EXCELLENT' : 'OPTIMAL'}
          </span>
        </div>
        <div className="text-xl font-black font-mono tracking-tight text-emerald-400">
          {winRate.toFixed(1)}%
        </div>
        <div className="w-full bg-zinc-800 rounded-full h-1.5 mt-2 overflow-hidden">
          <div 
            className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
            style={{ width: `${Math.min(100, Math.max(0, winRate))}%` }}
          />
        </div>
      </div>

      {/* 4. Режим Автопилота и Рынка */}
      <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-xl p-3.5 backdrop-blur-sm hover:border-zinc-700/80 transition-all">
        <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
          <span className="font-semibold uppercase tracking-wider text-[11px] flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-purple-400" />
            Статус Автопилота
          </span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            isAutoPilotActive 
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 animate-pulse' 
              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
          }`}>
            {isAutoPilotActive ? 'ACTIVE' : 'STANDBY'}
          </span>
        </div>
        <div className="text-sm font-bold text-zinc-200 mt-1 flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-400" />
          <span>Рынок: <strong className="text-yellow-400">{marketRegime || 'SHORT SCALPING'}</strong></span>
        </div>
        <div className="text-[11px] text-zinc-400 mt-1">
          Агенты №1, №2, №3 активны
        </div>
      </div>
    </div>
  );
};
