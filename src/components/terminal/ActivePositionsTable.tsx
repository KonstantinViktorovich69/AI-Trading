import React from 'react';
import { Shield, TrendingDown, TrendingUp, XCircle, Clock, Zap, AlertTriangle, ExternalLink } from 'lucide-react';

export interface PositionItem {
  id: string;
  symbol: string;
  exchange?: string;
  entryPrice: number;
  closePrice?: number;
  amount: number;
  leverage: number;
  side: 'SHORT' | 'LONG';
  status: 'OPEN' | 'CLOSED';
  mode?: 'MANUAL' | 'AUTO' | 'SEMI_AUTO' | 'EXTERNAL';
  pnl?: number;
  pnlPercent?: number;
  isReal?: boolean;
  openTime?: number;
  closeTime?: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface ActivePositionsTableProps {
  positions: PositionItem[];
  onClosePosition: (posId: string) => void;
  onUpdateSlTp?: (posId: string, sl?: number, tp?: number) => void;
  isRealTradingEnabled?: boolean;
}

export const ActivePositionsTable: React.FC<ActivePositionsTableProps> = ({
  positions,
  onClosePosition,
  isRealTradingEnabled = false
}) => {
  const activePositions = positions.filter(p => p.status === 'OPEN');

  return (
    <div className="bg-zinc-950 border border-zinc-800/80 rounded-xl overflow-hidden shadow-lg flex flex-col h-full">
      {/* Шапка таблицы */}
      <div className="bg-zinc-900/80 p-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-emerald-400" />
          <h2 className="text-xs font-black uppercase tracking-wider text-zinc-100">
            Активные Шорт-Позиции Агентов ({activePositions.length})
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {isRealTradingEnabled && (
            <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold rounded">
              WEEX REAL API
            </span>
          )}
        </div>
      </div>

      {/* Список активных сделок */}
      <div className="overflow-x-auto custom-scrollbar flex-1 max-h-[400px]">
        {activePositions.length === 0 ? (
          <div className="p-8 text-center text-zinc-500 text-xs">
            Нет открытых позиций. Сканер Агента №1 в режиме реального времени ищет сетапы.
          </div>
        ) : (
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-zinc-900/50 text-zinc-500 text-[10px] uppercase font-bold border-b border-zinc-800/60 sticky top-0 backdrop-blur">
              <tr>
                <th className="p-2.5">Символ</th>
                <th className="p-2.5">Сторона / Плечо</th>
                <th className="p-2.5">Вход / Объем</th>
                <th className="p-2.5">Нереализованный PnL</th>
                <th className="p-2.5">Режим</th>
                <th className="p-2.5 text-right">Закрыть</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/40">
              {activePositions.map((pos) => {
                const pnl = pos.pnl || 0;
                const pnlPct = pos.pnlPercent || 0;
                const isProfit = pnl >= 0;

                return (
                  <tr key={pos.id} className="hover:bg-zinc-900/60 transition-colors">
                    <td className="p-2.5 font-bold text-zinc-100">
                      <div className="flex items-center gap-1.5">
                        <span>{pos.symbol}</span>
                        {pos.isReal && (
                          <span className="px-1 py-0.2 bg-emerald-500/20 text-emerald-400 text-[9px] rounded font-mono">
                            REAL
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="p-2.5">
                      <span className={`inline-flex items-center gap-1 font-black text-[10px] px-1.5 py-0.5 rounded ${
                        pos.side === 'SHORT'
                          ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      }`}>
                        <TrendingDown className="w-3 h-3" />
                        {pos.side} {pos.leverage}x
                      </span>
                    </td>

                    <td className="p-2.5">
                      <div className="text-zinc-200 font-bold">${pos.entryPrice.toFixed(4)}</div>
                      <div className="text-[10px] text-zinc-500">${pos.amount.toFixed(0)}</div>
                    </td>

                    <td className="p-2.5 font-bold">
                      <div className={isProfit ? 'text-emerald-400' : 'text-rose-400'}>
                        {isProfit ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`}
                      </div>
                      <div className={`text-[10px] ${isProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {isProfit ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`}
                      </div>
                    </td>

                    <td className="p-2.5">
                      <span className="px-2 py-0.5 bg-zinc-800 text-zinc-300 text-[10px] rounded font-sans font-semibold">
                        {pos.mode || 'AUTO'}
                      </span>
                    </td>

                    <td className="p-2.5 text-right">
                      <button
                        onClick={() => onClosePosition(pos.id)}
                        className="px-2.5 py-1 bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 rounded font-bold text-[10px] uppercase transition-all inline-flex items-center gap-1"
                      >
                        <XCircle className="w-3 h-3" />
                        <span>Закрыть</span>
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
