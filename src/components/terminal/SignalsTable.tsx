import React, { useState, useMemo } from 'react';
import { Search, Filter, TrendingDown, Zap, ExternalLink, ShieldAlert, CheckCircle2, Sliders, ArrowRight } from 'lucide-react';

export interface SignalItem {
  symbol: string;
  coin: string;
  exchange: string;
  price: number;
  change24h: number;
  volume: number;
  signal: string;
  riskLevel: string;
  type: string;
  marketType?: 'SPOT' | 'FUTURES';
  isBinanceCrossListed?: boolean;
  aiScore?: number;
  vwap?: number;
  rsi?: number;
  patternName?: string;
  timestamp?: number;
  insights?: string[];
}

interface SignalsTableProps {
  signals: SignalItem[];
  onSelectSignal: (sig: SignalItem) => void;
  onOpenShortOrder: (sig: SignalItem) => void;
  isLoading?: boolean;
}

export const SignalsTable: React.FC<SignalsTableProps> = ({
  signals,
  onSelectSignal,
  onOpenShortOrder,
  isLoading = false
}) => {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'SHORT_ONLY' | 'SPOT_ONLY' | 'FUTURES_ONLY' | 'HIGH_SCORE'>('ALL');
  const [minScore, setMinScore] = useState<number>(60);

  const filteredSignals = useMemo(() => {
    return (signals || []).filter(sig => {
      if (!sig) return false;
      const sym = sig.symbol || '';
      const typeStr = sig.type || '';
      const signalStr = sig.signal || '';
      // Поисковый фильтр
      if (search && !sym.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      // Фильтр по типам рынков
      if (filterType === 'SPOT_ONLY') {
        const isSpotMatch = sig.marketType === 'SPOT' ||
                            typeStr.includes('Спот') ||
                            typeStr.includes('Spot');
        if (!isSpotMatch) return false;
      }
      if (filterType === 'FUTURES_ONLY' && (sig.marketType === 'SPOT' || typeStr.includes('Спот') || typeStr.includes('Spot'))) {
        return false;
      }
      // Фильтр только SHORT
      if (filterType === 'SHORT_ONLY' && signalStr !== 'SHORT' && !typeStr.includes('SHORT') && !typeStr.includes('Шорт')) {
        return false;
      }
      // Фильтр по AI Score
      if (filterType === 'HIGH_SCORE' && (sig.aiScore || 0) < minScore) {
        return false;
      }
      return true;
    });
  }, [signals, search, filterType, minScore]);

  return (
    <div className="bg-zinc-950 border border-zinc-800/80 rounded-xl overflow-hidden shadow-lg flex flex-col h-full">
      {/* Шапка таблицы с фильтрами */}
      <div className="bg-zinc-900/80 p-3 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-500 animate-pulse" />
          <h2 className="text-xs font-black uppercase tracking-wider text-zinc-100">
            Сканер Поиска Пампов & Шорт-Сетапов ({filteredSignals.length})
          </h2>
        </div>

        {/* Панель Поиска и Фильтров */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Поиск монеты..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/50 w-32 sm:w-40"
            />
          </div>

          <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-xs flex-wrap">
            <button
              onClick={() => setFilterType('ALL')}
              className={`px-2 py-0.5 font-bold rounded ${
                filterType === 'ALL' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Все
            </button>
            <button
              onClick={() => setFilterType('FUTURES_ONLY')}
              className={`px-2 py-0.5 font-bold rounded ${
                filterType === 'FUTURES_ONLY' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              ⚡ Фьючерсы
            </button>
            <button
              onClick={() => setFilterType('SPOT_ONLY')}
              className={`px-2 py-0.5 font-bold rounded ${
                filterType === 'SPOT_ONLY' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              📈 Спот
            </button>
            <button
              onClick={() => setFilterType('SHORT_ONLY')}
              className={`px-2 py-0.5 font-bold rounded ${
                filterType === 'SHORT_ONLY' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Шорт
            </button>
            <button
              onClick={() => setFilterType('HIGH_SCORE')}
              className={`px-2 py-0.5 font-bold rounded ${
                filterType === 'HIGH_SCORE' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              ИИ Top
            </button>
          </div>
        </div>
      </div>

      {/* Список сигналов */}
      <div className="overflow-x-auto custom-scrollbar flex-1 max-h-[500px]">
        {isLoading ? (
          <div className="p-8 text-center text-zinc-500 text-xs">
            Сканирование ликвидности и выявление аномальных объемов...
          </div>
        ) : filteredSignals.length === 0 ? (
          <div className="p-8 text-center text-zinc-500 text-xs">
            Сигналов по текущим фильтрам не обнаружено. Сканер обновляется каждые 10с.
          </div>
        ) : (
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-zinc-900/50 text-zinc-500 text-[10px] uppercase font-bold border-b border-zinc-800/60 sticky top-0 backdrop-blur">
              <tr>
                <th className="p-2.5">Монета</th>
                <th className="p-2.5">Цена / 24ч</th>
                <th className="p-2.5">AI Score</th>
                <th className="p-2.5">Паттерн / Сигнал</th>
                <th className="p-2.5">Объем 24h</th>
                <th className="p-2.5 text-right">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/40">
              {filteredSignals.map((sig) => {
                const score = sig.aiScore || 50;
                const isHighAi = score >= 75;

                return (
                  <tr
                    key={`${sig.exchange}-${sig.symbol}`}
                    onClick={() => onSelectSignal(sig)}
                    className="hover:bg-zinc-900/60 transition-colors cursor-pointer group"
                  >
                    <td className="p-2.5">
                      <div className="flex items-center gap-1.5 font-bold text-zinc-100 flex-wrap">
                        <span>{sig.symbol}</span>
                        <span className="text-[9px] px-1 py-0.2 bg-zinc-800 text-zinc-400 rounded uppercase font-sans">
                          {sig.exchange}
                        </span>
                        {sig.marketType === 'SPOT' || (sig.type || '').includes('Спот') || (sig.type || '').includes('Spot') ? (
                          <span className="text-[9px] px-1 py-0.2 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded font-sans font-bold">
                            SPOT
                          </span>
                        ) : (
                          <span className="text-[9px] px-1 py-0.2 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded font-sans font-bold">
                            FUTURES
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="p-2.5">
                      <div className="font-bold text-zinc-200">${(sig.price || 0).toFixed(4)}</div>
                      <div className={`text-[10px] font-bold ${(sig.change24h || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {(sig.change24h || 0) >= 0 ? `+${(sig.change24h || 0).toFixed(1)}%` : `${(sig.change24h || 0).toFixed(1)}%`}
                      </div>
                    </td>

                    <td className="p-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-black text-[11px] ${
                        isHighAi
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          : 'bg-zinc-800 text-zinc-300'
                      }`}>
                        {score} pts
                      </span>
                    </td>

                    <td className="p-2.5">
                      <div className="flex items-center gap-1">
                        <TrendingDown className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="text-zinc-300 font-semibold text-[11px] truncate max-w-[180px]">
                          {sig.patternName || sig.type || 'Short Scalp Setup'}
                        </span>
                      </div>
                    </td>

                    <td className="p-2.5 text-zinc-400 text-[11px]">
                      ${((sig.volume || 0) / 1000).toFixed(0)}k
                    </td>

                    <td className="p-2.5 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenShortOrder(sig);
                        }}
                        className="px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 rounded font-bold text-[10px] uppercase tracking-wider transition-all inline-flex items-center gap-1"
                      >
                        <span>Short Limit</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
