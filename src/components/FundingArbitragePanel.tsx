import React, { useState, useEffect } from 'react';
import { Percent, TrendingUp, TrendingDown, Clock, ShieldCheck, Zap, DollarSign, Calculator, RefreshCw, ArrowUpRight, Play, AlertTriangle, Layers } from 'lucide-react';

interface FundingOpportunity {
  symbol: string;
  exchange: string;
  fundingRate: number; // Decimal (e.g. 0.0015 = 0.15%)
  fundingRateApy: number; // APY in %
  dailyYieldPct: number; // Daily yield in %
  dailyYieldUsd10k: number; // Yield for $10,000 capital
  strategyType: 'DELTA_NEUTRAL_SPOT_SHORT' | 'FUNDING_SQUEEZE_LONG' | 'HIGH_YIELD_FARM';
  strategyName: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  netYield8h: number;
  minHoldingHours: number;
  aiRecommendation: string;
  price: number;
  volume24h: number;
}

interface FundingArbitragePanelProps {
  addToast?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export const FundingArbitragePanel: React.FC<FundingArbitragePanelProps> = ({ addToast }) => {
  const [opportunities, setOpportunities] = useState<FundingOpportunity[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterStrategy, setFilterStrategy] = useState<'ALL' | 'DELTA_NEUTRAL' | 'SQUEEZE' | 'HIGH_APY'>('ALL');
  const [capital, setCapital] = useState<number>(1000);
  const [leverage, setLeverage] = useState<number>(1);
  const [selectedOpp, setSelectedOpp] = useState<FundingOpportunity | null>(null);
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [timeToNextFunding, setTimeToNextFunding] = useState<string>('00:00:00');

  // Fetch funding opportunities from API
  const fetchOpportunities = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/funding-arbitrage');
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const text = await res.text();
        if (text.trim()) {
          const data = JSON.parse(text);
          if (data.success && Array.isArray(data.opportunities)) {
            setOpportunities(data.opportunities);
          }
        }
      }
    } catch (err) {
      console.error('[Funding Arbitrage] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpportunities();
    const interval = setInterval(fetchOpportunities, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, []);

  // Countdown timer to next UTC funding settlement (00:00, 08:00, 16:00 UTC)
  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const currentUtcHour = now.getUTCHours();
      let nextFundingHour = 8;
      if (currentUtcHour >= 16) {
        nextFundingHour = 24;
      } else if (currentUtcHour >= 8) {
        nextFundingHour = 16;
      }

      const nextSettlement = new Date(now);
      nextSettlement.setUTCHours(nextFundingHour % 24, 0, 0, 0);
      if (nextFundingHour === 24) {
        nextSettlement.setUTCDate(nextSettlement.getUTCDate() + 1);
      }

      const diffMs = nextSettlement.getTime() - now.getTime();
      if (diffMs <= 0) {
        setTimeToNextFunding('00:00:00');
        return;
      }

      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diffMs % (1000 * 60)) / 1000);

      setTimeToNextFunding(
        `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      );
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, []);

  // Filter logic
  const filteredOpportunities = opportunities.filter((opp) => {
    if (filterStrategy === 'DELTA_NEUTRAL') return opp.strategyType === 'DELTA_NEUTRAL_SPOT_SHORT';
    if (filterStrategy === 'SQUEEZE') return opp.strategyType === 'FUNDING_SQUEEZE_LONG';
    if (filterStrategy === 'HIGH_APY') return opp.fundingRateApy >= 50;
    return true;
  });

  // Calculate top metrics
  const maxPositive = opportunities.reduce((prev, curr) => (curr.fundingRate > (prev?.fundingRate || -1) ? curr : prev), opportunities[0]);
  const maxNegative = opportunities.reduce((prev, curr) => (curr.fundingRate < (prev?.fundingRate || 1) ? curr : prev), opportunities[0]);
  const avgApy = opportunities.length > 0 
    ? (opportunities.slice(0, 10).reduce((acc, curr) => acc + curr.fundingRateApy, 0) / Math.min(10, opportunities.length)).toFixed(1)
    : '0.0';

  // Calculator outputs
  const selectedOppRate = selectedOpp ? selectedOpp.fundingRate : (maxPositive ? maxPositive.fundingRate : 0.001);
  const yieldPer8hUsd = (capital * leverage * selectedOppRate).toFixed(2);
  const dailyYieldUsd = (capital * leverage * selectedOppRate * 3).toFixed(2);
  const monthlyYieldUsd = (capital * leverage * selectedOppRate * 3 * 30).toFixed(2);
  const calculatedApy = (selectedOppRate * 3 * 365 * 100 * leverage).toFixed(1);

  // Execute Farming Trade Action
  const handleExecuteFarming = async (opp: FundingOpportunity) => {
    try {
      setExecutingSymbol(opp.symbol);
      const res = await fetch('/api/funding-arbitrage/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: opp.symbol,
          capital,
          leverage,
          strategyType: opp.strategyType
        })
      });

      if (res.ok) {
        const text = await res.text();
        if (text.trim()) {
          const data = JSON.parse(text);
          if (data.success) {
            if (addToast) addToast(`✅ Успешно запущен фарминг фандинга по ${opp.symbol}! Сделка открыта в терминале.`, 'success');
          } else {
            if (addToast) addToast(`⚠️ Ошибка запуска: ${data.error || 'Не удалось выполнить'}`, 'warning');
          }
        }
      }
    } catch (e: any) {
      if (addToast) addToast(`❌ Ошибка сети: ${e?.message || e}`, 'error');
    } finally {
      setExecutingSymbol(null);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn text-zinc-100">
      {/* HEADER BANNER */}
      <div className="bg-gradient-to-r from-emerald-950/40 via-zinc-900 to-indigo-950/40 border border-emerald-500/20 p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400">
            <Percent className="w-8 h-8" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold font-mono tracking-wide text-white">АРБИТРАЖ И ФАРМИНГ ФАНДИНГА</h2>
              <span className="bg-emerald-500/20 text-emerald-400 text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border border-emerald-500/30 font-mono uppercase">
                DELTA-NEUTRAL HARVESTER
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-1 font-sans">
              Пассивный заработок на процентных ставках списания фьючерсов. Дельта-нейтральный сбор без риска направления цены.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchOpportunities}
            disabled={loading}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-bold font-mono flex items-center gap-2 border border-zinc-700 transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            ОБНОВИТЬ
          </button>
        </div>
      </div>

      {/* TOP METRICS BENTO GRID */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Metric 1: Max Positive Funding */}
        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl flex flex-col justify-between hover:border-emerald-500/30 transition-all">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-mono uppercase">
            <span>Макс. Доход (Spot + Short)</span>
            <TrendingUp className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold font-mono text-emerald-400">
              {maxPositive ? `+${(maxPositive.fundingRate * 100).toFixed(4)}%` : '0.0000%'}
            </div>
            <div className="text-[11px] text-zinc-400 font-mono mt-1 flex items-center gap-1.5">
              <span>Лидер:</span>
              <strong className="text-white font-bold">{maxPositive?.symbol || '---'}</strong>
              <span className="text-emerald-400 font-extrabold">({maxPositive?.fundingRateApy.toFixed(0)}% APY)</span>
            </div>
          </div>
        </div>

        {/* Metric 2: Max Negative Funding (Short Squeeze Risk) */}
        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl flex flex-col justify-between hover:border-rose-500/30 transition-all">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-mono uppercase">
            <span>Макс. Сквиз (Short Squeeze)</span>
            <TrendingDown className="w-4 h-4 text-rose-400" />
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold font-mono text-rose-400">
              {maxNegative ? `${(maxNegative.fundingRate * 100).toFixed(4)}%` : '0.0000%'}
            </div>
            <div className="text-[11px] text-zinc-400 font-mono mt-1 flex items-center gap-1.5">
              <span>Лидер:</span>
              <strong className="text-white font-bold">{maxNegative?.symbol || '---'}</strong>
              <span className="text-rose-400 font-extrabold">(Squeeze Alert)</span>
            </div>
          </div>
        </div>

        {/* Metric 3: Countdown to Settlement */}
        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl flex flex-col justify-between hover:border-indigo-500/30 transition-all">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-mono uppercase">
            <span>До выплаты фандинга (UTC)</span>
            <Clock className="w-4 h-4 text-indigo-400 animate-pulse" />
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold font-mono text-indigo-400 tracking-wider">
              {timeToNextFunding}
            </div>
            <div className="text-[11px] text-zinc-400 font-mono mt-1">
              Списание каждые 8 часов (00:00, 08:00, 16:00 UTC)
            </div>
          </div>
        </div>

        {/* Metric 4: Avg APY Top-10 */}
        <div className="bg-zinc-900/90 border border-zinc-800 p-4 rounded-xl flex flex-col justify-between hover:border-amber-500/30 transition-all">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-mono uppercase">
            <span>Средний APY (Top 10)</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold font-mono text-amber-400">
              +{avgApy}% <span className="text-xs font-normal text-zinc-400">годовых</span>
            </div>
            <div className="text-[11px] text-zinc-400 font-mono mt-1">
              Средняя чистая доходность лучших активов
            </div>
          </div>
        </div>
      </div>

      {/* INTERACTIVE CALCULATOR & STRATEGY SELECTOR */}
      <div className="bg-zinc-900/95 border border-zinc-800 p-5 rounded-2xl grid grid-cols-1 lg:grid-cols-3 gap-6 shadow-xl">
        {/* Column 1 & 2: Interactive Yield Calculator */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
            <Calculator className="w-5 h-5 text-emerald-400" />
            <h3 className="font-bold text-sm font-mono uppercase text-white">Калькулятор доходности фарминга</h3>
            {selectedOpp && (
              <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded font-mono border border-emerald-500/20 ml-auto">
                Выбран актив: {selectedOpp.symbol} ({(selectedOpp.fundingRate * 100).toFixed(4)}% / 8ч)
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-mono text-zinc-400 mb-1.5 block">
                Капитал для фарминга ($):
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={10}
                  max={500000}
                  value={capital}
                  onChange={(e) => setCapital(Math.max(10, parseFloat(e.target.value) || 0))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-emerald-500 transition-all pl-8"
                />
                <DollarSign className="w-4 h-4 text-zinc-500 absolute left-2.5 top-3" />
              </div>
            </div>

            <div>
              <label className="text-xs font-mono text-zinc-400 mb-1.5 block">
                Кредитное плечо (Leverage):
              </label>
              <div className="flex items-center gap-2">
                {[1, 2, 3, 5].map((lev) => (
                  <button
                    key={lev}
                    onClick={() => setLeverage(lev)}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold font-mono border transition-all ${
                      leverage === lev
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                        : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {lev}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Computed Results Display */}
          <div className="grid grid-cols-3 gap-3 bg-zinc-950/80 p-4 rounded-xl border border-zinc-800/80">
            <div>
              <div className="text-[11px] text-zinc-400 font-mono">Доход за 8 часов:</div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                +${yieldPer8hUsd}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400 font-mono">Доход за сутки (3 выплаты):</div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                +${dailyYieldUsd}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400 font-mono">Доход за месяц (30 дн):</div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                +${monthlyYieldUsd}
              </div>
            </div>
          </div>
        </div>

        {/* Column 3: Summary Box & Quick Execute */}
        <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800/80 flex flex-col justify-between space-y-4">
          <div>
            <div className="text-xs font-mono text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Расчетный APY с плечом {leverage}x</span>
            </div>
            <div className="text-3xl font-extrabold font-mono text-emerald-400">
              +{calculatedApy}%
            </div>
            <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">
              Дельта-нейтральная стратегия исключает риск изменения курса криптовалюты за счет одновременного входа в разнонаправленные позиции (Спот Покупка + Фьючерс Продажа).
            </p>
          </div>

          {selectedOpp ? (
            <button
              onClick={() => handleExecuteFarming(selectedOpp)}
              disabled={!!executingSymbol}
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold text-xs font-mono rounded-xl uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              {executingSymbol === selectedOpp.symbol ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-current" />
              )}
              Запустить фарминг по {selectedOpp.symbol}
            </button>
          ) : (
            <div className="text-center py-2 text-xs font-mono text-zinc-500 border border-dashed border-zinc-800 rounded-xl">
              Выберите актив из таблицы ниже для запуска фарминга
            </div>
          )}
        </div>
      </div>

      {/* FILTER BUTTONS & OPPORTUNITIES TABLE */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-400" />
            <h3 className="font-bold text-sm font-mono uppercase text-white">Список возможностей фарминга фандинга</h3>
            <span className="text-xs text-zinc-400 font-mono">({filteredOpportunities.length} активных)</span>
          </div>

          {/* Strategy Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {[
              { id: 'ALL', label: 'Все активы' },
              { id: 'DELTA_NEUTRAL', label: 'Спот + Шорт (Дельта-нейтральный)' },
              { id: 'SQUEEZE', label: 'Short Squeeze (Лонг)' },
              { id: 'HIGH_APY', label: 'Высокий APY (>50%)' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterStrategy(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all whitespace-nowrap ${
                  filterStrategy === tab.id
                    ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TABLE */}
        {loading && opportunities.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 font-mono text-xs flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
            Сканирование ставок фандинга на биржах...
          </div>
        ) : filteredOpportunities.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 font-mono text-xs">
            Нет доступных вариантов по выбранному фильтру.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
                  <th className="py-3 px-3">Инструмент / Биржа</th>
                  <th className="py-3 px-3">Ставка 8ч</th>
                  <th className="py-3 px-3">Годовой APY</th>
                  <th className="py-3 px-3">Доход/$10k (День)</th>
                  <th className="py-3 px-3">Стратегия & Риск</th>
                  <th className="py-3 px-3">Рекомендация ИИ</th>
                  <th className="py-3 px-3 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50 font-mono text-xs">
                {filteredOpportunities.map((opp) => {
                  const isSelected = selectedOpp?.symbol === opp.symbol;
                  const isPositive = opp.fundingRate > 0;

                  return (
                    <tr
                      key={opp.symbol}
                      onClick={() => setSelectedOpp(opp)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-emerald-500/10 border-l-2 border-emerald-500'
                          : 'hover:bg-zinc-800/40'
                      }`}
                    >
                      <td className="py-3 px-3">
                        <div className="font-bold text-white flex items-center gap-2">
                          {opp.symbol}
                          <span className="text-[9px] text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded font-normal uppercase">
                            {opp.exchange}
                          </span>
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          Цена: ${opp.price ? opp.price.toFixed(opp.price < 1 ? 5 : 2) : '---'}
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <span className={`font-bold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {isPositive ? '+' : ''}{(opp.fundingRate * 100).toFixed(4)}%
                        </span>
                      </td>

                      <td className="py-3 px-3">
                        <span className="font-extrabold text-amber-400">
                          +{opp.fundingRateApy.toFixed(1)}% APY
                        </span>
                      </td>

                      <td className="py-3 px-3">
                        <span className="font-bold text-emerald-400">
                          +${opp.dailyYieldUsd10k.toFixed(2)} / дн
                        </span>
                      </td>

                      <td className="py-3 px-3">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase border ${
                              opp.strategyType === 'DELTA_NEUTRAL_SPOT_SHORT'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            }`}
                          >
                            {opp.strategyName}
                          </span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                              opp.riskLevel === 'LOW'
                                ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                                : 'bg-amber-950 text-amber-400 border-amber-800'
                            }`}
                          >
                            {opp.riskLevel}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-3 text-[11px] text-zinc-400 max-w-xs truncate">
                        {opp.aiRecommendation}
                      </td>

                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOpp(opp);
                            handleExecuteFarming(opp);
                          }}
                          disabled={executingSymbol === opp.symbol}
                          className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500 text-emerald-400 hover:text-zinc-950 border border-emerald-500/30 rounded-lg text-xs font-bold transition-all flex items-center gap-1 ml-auto"
                        >
                          {executingSymbol === opp.symbol ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          )}
                          Фармить
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* STRATEGY GUIDE FOOTER */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-xs text-zinc-400 font-sans">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-zinc-200 block mb-0.5 font-mono">Как работает Delta-Neutral Арбитраж фандинга?</span>
            При положительном фандинге покупатели (лонгисты) платят продавцам (шортистам). Покупая 1x на споте и одновременно открывая 1x шорт на фьючерсах, вы захеджированы от движения цены активов и непрерывно получаете выплатную ставку фандинга каждые 8 часов!
          </div>
        </div>
      </div>
    </div>
  );
};
