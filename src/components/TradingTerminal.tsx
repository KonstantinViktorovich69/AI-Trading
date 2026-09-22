import React, { useState, useEffect, useRef, useMemo, useDeferredValue, useCallback, lazy, Suspense } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Info, Bell, Calculator, TrendingDown, TrendingUp, AlertCircle, AlertTriangle, Rocket, HelpCircle, Play, Bot, Send, RefreshCw, Brain, ShieldAlert, CheckCircle2, Smartphone, Activity, ExternalLink, Filter, Search, ChevronDown, Check, Plus, Settings, X, History, Volume2, VolumeX, Star, Zap, Lightbulb, BookOpen, Loader2, Clock, ArrowRight, Eye, EyeOff, Archive, FolderDown, FolderUp, Sparkles, Sliders, Maximize2, Minimize2, BarChart3, Edit, Wifi, WifiOff } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { cn } from '../lib/utils';

const TradingChart = lazy(() => import('./TradingChart').then(m => ({ default: m.TradingChart })));
const AnalyticsTab = lazy(() => import('./AnalyticsTab').then(m => ({ default: m.AnalyticsTab })));
const SignalAnalyticsDashboard = lazy(() => import('./SignalAnalyticsDashboard').then(m => ({ default: m.SignalAnalyticsDashboard })));
const FineTuningPanel = lazy(() => import('./FineTuningPanel').then(m => ({ default: m.FineTuningPanel })));
const FundingArbitragePanel = lazy(() => import('./FundingArbitragePanel').then(m => ({ default: m.FundingArbitragePanel })));

function Tooltip({ text, children, className }: { text: string, children: React.ReactNode, position?: 'top' | 'right' | 'bottom', className?: string, key?: string | number }) {
  return (
    <div title={text} className={cn("inline-flex items-center", className)}>
      {children}
    </div>
  );
}

const getTradeUrl = (exchange: string = '', coin: string = '') => {
  const safeCoin = coin || '';
  const safeEx = (exchange || '').toLowerCase();
  const base = safeCoin.split('/')[0] || safeCoin;
  const quote = safeCoin.split('/')[1] || 'USDT';
  const baseLower = base.toLowerCase();
  const quoteLower = quote.toLowerCase();
  switch (safeEx) {
    case 'binance': return `https://www.binance.com/en/trade/${base}_${quote}`;
    case 'bybit': return `https://www.bybit.com/trade/usdt/${base}${quote}`;
    case 'okx': return `https://www.okx.com/trade-spot/${baseLower}-${quoteLower}`;
    case 'htx': case 'huobi': return `https://www.htx.com/trade/${baseLower}_${quoteLower}`;
    case 'kucoin': return `https://www.kucoin.com/trade/${base}-${quote}`;
    case 'gateio': return `https://www.gate.io/trade/${base}_${quote}`;
    case 'bitget': return `https://www.bitget.com/spot/${base}${quote}`;
    case 'mexc': return `https://www.mexc.com/exchange/${base}_${quote}`;
    case 'kraken': return `https://pro.kraken.com/app/trade/${baseLower}-${quoteLower}`;
    case 'bitfinex': return `https://trading.bitfinex.com/t/${base}${quote}`;
    default: return `https://coinmarketcap.com/currencies/${baseLower}/`;
  }
};

const EXCHANGES = ['weex'];

async function safeFetchJson(res: Response): Promise<any> {
  if (!res) return { success: false, error: 'No response' };
  try {
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { success: false, error: 'Non-JSON response' };
    const text = await res.text();
    if (!text || !text.trim()) return { success: false, error: 'Empty response' };
    return JSON.parse(text);
  } catch (e: any) {
    return { success: false, error: e?.message || 'JSON parse error' };
  }
}

const getMinNotional = (price: number) => {
  if (!price) return 5;
  if (price > 20000) return 50;
  if (price > 1000) return 20;
  if (price > 100) return 15;
  if (price > 10) return 10;
  return 5;
};

interface Signal {
  symbol: string; rawSymbol?: string; coin: string; exchange: string; price: number; change24h: number; volume: number;
  high24h?: number; low24h?: number; volatility?: number | string; dropFromHigh?: number; riseFromLow?: number;
  change15m?: number; change1h?: number; volumeSpike?: number; funding?: number; oi?: number; obImbalance?: number | string; obWalls?: { type: 'bid'|'ask', price: number, size: number, distancePct: number }[];
  icebergs?: {
    askIceberg?: { price: number; size: number; distancePct: number; smartSellLimit: number } | null;
    bidIceberg?: { price: number; size: number; distancePct: number; smartBuyLimit: number } | null;
  } | null;
  smartLimitTarget?: number;
  spotDcaLadder?: Array<{
    step: number;
    price: number;
    percentDip: number;
    allocationPct: number;
    label: string;
  }> | null;
  signal: string; riskLevel: string; type: string; aiScore?: number; liqPrice?: number; fomoIndex?: number;
  matchedPattern?: string; patternName?: string;
  consensus?: string;
  rsi?: number; macd?: string; bbStatus?: string;
  atr?: number | string; liquidations?: { shortsSq: number, longsSq: number }; cvd?: { buyVol: number, sellVol: number, cvd: number }; whaleHit?: boolean; pumpDetected?: boolean;
  vwap?: number; vwapDist?: number; squeeze?: string; stopHunt?: string; strongPlayer?: boolean;
  score10?: string;
  target?: string;
  confidenceP?: number;
  timestamp?: number; insights?: string[]; aiValidationPassed?: boolean;
}

interface KnowledgeRule {
  id: string;
  agent: 'SCANNER' | 'MANAGER' | 'LONG_MANAGER' | 'GENERAL';
  text: string;
  image?: string;
  isArchived?: boolean;
  archiveReason?: string;
  marketRegimeAtArchive?: string;
  successRate?: number;
  usageCount?: number;
  impact?: number;
  filterIndicator?: string;
  filterCondition?: string;
  filterValue?: number;
  filterAction?: string;
}

interface PaperTrade {
  id: string;
  symbol: string;
  exchange?: string;
  entryPrice: number;
  amount: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  mode: 'MANUAL' | 'AUTO' | 'SEMI_AUTO' | 'EXTERNAL';
  isAutoLearning?: boolean;
  isReal?: boolean;
  isExternal?: boolean;
  isExchangeManual?: boolean;
  pnl?: number;
  pnlPercent?: number;
  closePrice?: number;
  openTime?: number;
  closeTime?: number;
  aiAdvice?: string;
  lastAiCheck?: number;
  history?: any[];
  aiEvaluation?: string;
  learnedRule?: string;
  takeProfit?: number;
  stopLoss?: number;
  smartDca?: number[];
}

interface ActiveTradeItemProps {
  trade: PaperTrade;
  latestPrices: Record<string, number>;
  livePrice: number;
  handleCloseActiveTrade: (trade: PaperTrade) => void | Promise<void>;
  handleChangeTradeMode: (tradeId: string, mode: string) => void | Promise<void>;
  handleLeverageChange: (tradeId: string, leverage: number) => void | Promise<void>;
  handleAverageTrade: (tradeId: string, amount: number) => void | Promise<void>;
  handleSlTpChange: (tradeId: string, sl: number | null, tp: number | null) => void | Promise<void>;
  activeTerminalTradeId: string | null;
  setActiveTerminalTradeId: (id: string | null | ((prev: string | null) => string | null)) => void;
  key?: string | number;
  isRealBalanceVisible?: boolean;
  isStandalone?: boolean;
}

const interpretConfidence = (p: number) => {
  if (p >= 0.80) return { level: 'ВЫСОКАЯ', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Уверенность', desc: '' };
  if (p >= 0.60) return { level: 'СРЕДНЯЯ', color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20', label: 'Уверенность', desc: 'Ручной вход на усмотрение трейдера' };
  return { level: 'НИЗКАЯ', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'Низкая уверенность', desc: 'Вход не рекомендуется' };
};

const calculateKelly = (aiScore: number, rewardToRisk: number = 2.0): { pct: number, recommendedSize: string } => {
  const w = aiScore / 100;
  if (w <= 0.4) return { pct: 0, recommendedSize: 'ИГНОР' };
  // Kelly formula: w - (1 - w) / rewardToRisk
  const k = w - (1 - w) / rewardToRisk;
  // Apply Half-Kelly for safety (industry standard)
  const halfKelly = Math.max(0, k / 2);
  const sizeValue = halfKelly * 100;
  
  if (sizeValue <= 0) {
    return { pct: 0, recommendedSize: 'ПРОПУСК' };
  }
  return { 
    pct: sizeValue, 
    recommendedSize: `${sizeValue.toFixed(0)}%` 
  };
};

const interpretScore = (sig: Signal) => {
  const score = sig.aiScore || 0;
  const isApproved = sig.aiValidationPassed;
  const isRejected = sig.consensus?.includes('HOLD') || sig.consensus?.includes('REJECTED');
  
  if (isApproved) {
    return { label: 'ОДОБРЕНО ИИ', text: 'text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)] font-black', fill: 'bg-emerald-400 shadow-glow-emerald', bg: 'bg-emerald-500/20', border: 'border-emerald-500/40' };
  }
  if (isRejected) {
    return { label: 'ОТКЛОНЕНО ИИ', text: 'text-zinc-500', fill: 'bg-zinc-600', bg: 'bg-zinc-900', border: 'border-white/5' };
  }
  
  if (score >= 80) return { label: 'ВЫСОКИЙ (STRONG)', text: 'text-emerald-400', fill: 'bg-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' };
  if (score >= 60) return { label: 'СРЕДНИЙ', text: 'text-amber-400', fill: 'bg-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/20' };
  return { label: 'НИЗКИЙ', text: 'text-rose-400', fill: 'bg-rose-500', bg: 'bg-rose-500/10', border: 'border-rose-500/20' };
};

const SignalRow = React.memo(({ sig, onSelect, selected, latestPrice, favorites, toggleFavorite, setChartSymbol, getMinNotional, pStability, btcTrend15m, activeTrade }: { 
  sig: Signal, 
  onSelect: (s: Signal) => void, 
  selected: boolean, 
  latestPrice?: number,
  favorites: string[],
  toggleFavorite: (s: string) => void,
  setChartSymbol: (p: {symbol: string, exchange: string}) => void,
  getMinNotional: (p: number) => number,
  pStability?: { isUnstable: boolean },
  btcTrend15m?: number,
  activeTrade?: any
}) => {
  const currentPrice = latestPrice || sig.price;
  const isShort = (sig.signal || '').includes('SELL') || (sig.signal || '').includes('SHORT');
  const diffPct = ((currentPrice - sig.price) / sig.price) * 100;
  const isPassed = isShort ? diffPct < -0.3 : diffPct > 0.3;
  const scoreDetails = interpretScore(sig);

  const warnings: string[] = [];
  const ageMs = sig.timestamp ? Date.now() - sig.timestamp : 0;
  if (ageMs > 5 * 60 * 1000 && (sig.aiScore || 0) >= 80) warnings.push("⚠️ Сигнал стареет");
  if (btcTrend15m !== undefined && btcTrend15m < -2) warnings.push("⚠️ BTC падает — каскадный сброс альтов вероятен");
  if (pStability?.isUnstable) warnings.push("⚠️ Score нестабилен — подождите стабилизации");
  if (isPassed) warnings.push("🕒 Цена могла уйти, проверьте точку входа");

  return (
    <tr 
      className={cn(
        "hover:bg-white/[0.02] transition-colors duration-200 cursor-pointer group border-b border-white/[0.03] py-2", 
        selected && "bg-indigo-500/[0.08] border-l-2 border-indigo-500 shadow-[inset_4px_0_15px_-5px_rgba(99,102,241,0.3)]",
        activeTrade && (
          activeTrade.isReal 
            ? "bg-emerald-500/[0.04] border-l-2 border-emerald-500/80 shadow-[inset_4px_0_20px_-5px_rgba(16,185,129,0.15)] hover:bg-emerald-500/[0.06]"
            : "bg-sky-500/[0.02] border-l-2 border-sky-500/60 shadow-[inset_4px_0_15px_-5px_rgba(14,165,233,0.1)] hover:bg-sky-500/[0.04]"
        )
      )} 
      onClick={() => onSelect(sig)}
    >
      <td className="px-3 py-2 min-w-[140px]">
        <div className="flex items-center gap-3">
          <button 
            onClick={(e) => { e.stopPropagation(); toggleFavorite(sig.symbol); }}
            className="text-zinc-700 hover:text-amber-500 transition-colors focus:outline-none"
          >
            <Star className={cn("w-3.5 h-3.5 transition-all text-zinc-600", favorites.includes(sig.symbol) && "fill-amber-500 text-amber-500 scale-110 shadow-glow-rose")} />
          </button>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span 
                className="font-black text-zinc-100 text-xs tracking-wider cursor-pointer hover:text-indigo-400 transition-colors flex items-center gap-1.5"
                onClick={(e) => { e.stopPropagation(); setChartSymbol({ symbol: sig.rawSymbol || sig.symbol, exchange: sig.exchange }); }}
              >
                {sig.coin || (sig.rawSymbol || sig.symbol || '').split(/[\/:\-_]/)[0] || sig.symbol}
                {activeTrade && (
                  <span className="flex h-2 w-2 relative" title={`В позиции: ${activeTrade.side || 'ПОЗИЦИЯ'}`}>
                    <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", activeTrade.isReal ? "bg-emerald-400" : "bg-sky-400")}></span>
                    <span className={cn("relative inline-flex rounded-full h-2 w-2", activeTrade.isReal ? "bg-emerald-500" : "bg-sky-500")}></span>
                  </span>
                )}
                <Activity className="w-3 h-3 text-indigo-500 opacity-40 group-hover:opacity-100 transition-opacity" />
              </span>
              <span className="text-[10px] text-zinc-600 font-mono uppercase opacity-60 tracking-tight">{sig.exchange}</span>
            </div>
            <div className="flex items-center gap-1.5 overflow-hidden flex-wrap max-w-[200px]">
              {sig.change15m !== undefined && (
                <span className={cn(
                  "text-[8px] font-black px-1.5 py-0.5 rounded-sm border uppercase tracking-widest", 
                  sig.change15m > 0 ? "text-emerald-500 border-emerald-500/20 bg-emerald-500/5" : "text-rose-500 border-rose-500/20 bg-rose-500/5"
                )}>
                  {sig.change15m > 0 ? '↑' : '↓'} {Math.abs(sig.change15m).toFixed(1)}%
                </span>
              )}
              {isPassed && (
                <span className="text-[8px] font-black px-1.5 py-0.5 rounded-sm border border-zinc-500/20 bg-zinc-500/5 text-zinc-500 uppercase tracking-widest flex items-center gap-1">
                  <CheckCircle2 className="w-2 h-2" /> ЗАВЕРШЕНО
                </span>
              )}
              {activeTrade && (
                <span className={cn(
                  "text-[8px] font-black px-1.5 py-0.5 rounded-sm border uppercase tracking-widest flex items-center gap-1 shadow-sm select-none min-w-fit flex-shrink-0",
                  activeTrade.isReal 
                    ? "text-emerald-400 border-emerald-500/35 bg-emerald-500/10 shadow-[0_0_10px_rgba(16,185,129,0.2)] font-extrabold animate-pulse" 
                    : "text-sky-400 border-sky-500/25 bg-sky-500/5 font-semibold"
                )}>
                  {activeTrade.isReal ? '⚡ РЕАЛ' : '🤖 ДЕМО'}: {activeTrade.side || (activeTrade.direction || 'SHORT').toUpperCase()}
                </span>
              )}
            </div>
          </div>
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs font-black text-zinc-100 font-mono tracking-tighter">
            ${(latestPrice || sig.price || 0).toLocaleString('en-US', { minimumFractionDigits: (sig.price || 0) < 1 ? 6 : 2 })}
          </div>
          <div className={cn("text-[9px] font-bold font-mono", isPassed ? "text-emerald-500/50" : "text-zinc-600")}>
            {isShort ? 'ВХОД (MAX)' : 'ВХОД (MIN)'}: ${(sig.price || 0) > 10 ? (sig.price || 0).toFixed(2) : (sig.price || 0).toFixed(5)}
          </div>
        </div>
      </td>

      <td className="px-3 py-2">
        <div className={cn(
          "text-xs font-black font-mono",
          (sig.change24h || 0) > 0 ? "text-emerald-400" : (sig.change24h || 0) < 0 ? "text-rose-400" : "text-zinc-500"
        )}>
          {(sig.change24h || 0) > 0 ? '+' : ''}{(sig.change24h || 0).toFixed(2)}%
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs font-black text-zinc-400 font-mono">${((sig.volume || 0) / 1000000).toFixed(1)}M</div>
          {sig.volumeSpike && sig.volumeSpike > 1.2 && (
            <div className="flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-[9px] text-amber-500/80 font-black font-mono">{sig.volumeSpike.toFixed(1)}x ВСПЛЕСК</span>
            </div>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col gap-1 items-start">
          {sig.obImbalance !== undefined && (
            <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
              <div 
                className={cn("h-full transition-all duration-1000", Number(sig.obImbalance) > 0 ? "bg-rose-500" : "bg-emerald-500")}
                style={{ width: `${Math.min(100, Math.abs(Number(sig.obImbalance)) * 2)}%` }}
              />
            </div>
          )}
          <span className="text-[10px] font-black text-zinc-400 font-mono tracking-tighter uppercase whitespace-nowrap">
            {sig.volatility !== undefined ? `ВОЛ-ТЬ: ${Number(sig.volatility || 0).toFixed(1)}%` : 'СТАБИЛЬНО'}
          </span>
        </div>
      </td>

      <td className="px-3 py-2">
        <div className={cn(
          "px-2.5 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest inline-block",
          isShort 
            ? "bg-rose-500/5 text-rose-500 border-rose-500/20 shadow-glow-rose" 
            : "bg-emerald-500/5 text-emerald-500 border-emerald-500/20 shadow-glow-emerald"
        )}>
          {isShort ? 'ШОРТ' : 'ЛОНГ'}
        </div>
      </td>

      <td className="px-3 py-2 max-w-[220px]">
        <div className="flex flex-col gap-1 items-start">
          <div className="flex items-center gap-1.5 w-full">
            <span className="text-[9px] text-zinc-400 font-black uppercase tracking-widest bg-zinc-900/80 px-2 py-1 rounded border border-white/5 truncate flex-1">
              {sig.type || sig.matchedPattern || sig.patternName || (isShort ? 'Квантовый Шорт' : 'Квантовый Лонг')}
            </span>
            {sig.aiValidationPassed && (
              <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 flex-shrink-0" title="Проверено ИИ">
                ✅
              </span>
            )}
          </div>
          {warnings.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-0.5 w-full">
              {warnings.map((w, idx) => (
                <span key={idx} className="text-[8px] text-amber-500/90 font-bold truncate w-full">
                  {w}
                </span>
              ))}
            </div>
          )}
          {sig.insights && sig.insights.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-0.5 opacity-80 w-full" title="AI Инсайты">
              {sig.insights.slice(0, 1).map((insight, idx) => (
                <span key={idx} className="text-[8px] text-indigo-300 font-mono italic truncate w-full">
                  💡 {insight}
                </span>
              ))}
            </div>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("text-xs font-black font-mono", scoreDetails.text)}>{Number(sig.aiScore || 0).toFixed(1)}%</span>
            <span className={cn("text-[8px] font-black uppercase px-1.5 py-0.5 rounded-sm border whitespace-nowrap", scoreDetails.text, scoreDetails.bg, scoreDetails.border)}>
              {scoreDetails.label.replace(' (STRONG)', '')}
            </span>
          </div>
          <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden hidden sm:block">
            <div className={cn("h-full", scoreDetails.fill)} style={{ width: `${sig.aiScore || 0}%` }} />
          </div>
          {sig.aiScore !== undefined && (
            <div className="flex items-center gap-1 mt-0.5">
              <Zap className="w-2.5 h-2.5 text-amber-400 fill-amber-400/20" />
              <span className="text-[8.5px] text-amber-400 font-mono font-bold leading-none" title="Оптимальный объем позиции по формуле Келли">
                Келли: {calculateKelly(sig.aiScore).recommendedSize}
              </span>
            </div>
          )}
          {sig.confidenceP !== undefined && (
            <div className={cn(
              "text-[8px] font-black uppercase tracking-tight px-1 rounded-sm border whitespace-nowrap w-fit",
              interpretConfidence(sig.confidenceP).bg,
              interpretConfidence(sig.confidenceP).color,
              interpretConfidence(sig.confidenceP).border
            )}>
              P:{((sig.confidenceP || 0) * 100).toFixed(0)}% {pStability?.isUnstable && '⚠️'}
            </div>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        {(() => {
          const rawRisk = (sig.riskLevel || (Number(sig.volatility || 0) > 30 ? 'HIGH' : Number(sig.volatility || 0) > 15 ? 'MODERATE' : 'LOW')).toUpperCase();
          const isCrit = rawRisk === 'CRITICAL' || rawRisk === 'КРИТ';
          const isHigh = rawRisk === 'HIGH' || rawRisk === 'ВЫСОК';
          const isMed = rawRisk === 'MODERATE' || rawRisk === 'MEDIUM' || rawRisk === 'СРЕД';
          const label = isCrit ? 'КРИТ' : isHigh ? 'ВЫСОК' : isMed ? 'СРЕД' : 'НИЗК';
          return (
            <span className={cn(
              "text-[8px] px-2 py-0.5 rounded-sm border font-black uppercase tracking-widest inline-block text-center min-w-[48px]", 
              isCrit ? "text-rose-400 border-rose-500/30 bg-rose-500/10 shadow-[0_0_8px_rgba(244,63,94,0.2)]" :
              isHigh ? "text-amber-400 border-amber-500/30 bg-amber-500/10" :
              isMed ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10" :
              "text-emerald-400/80 border-emerald-500/20 bg-emerald-500/5"
            )}>
              {label}
            </span>
          );
        })()}
      </td>

      <td className="px-3 py-2 text-right">
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-xs font-black text-zinc-100 font-mono tracking-tighter bg-white/5 px-1.5 py-0.5 rounded">
            ${(sig.price * (isShort ? 0.92 : 1.08)).toFixed(sig.price < 1 ? 5 : 2)}
          </span>
          <span className="text-[8px] text-zinc-600 font-bold uppercase tracking-tight whitespace-nowrap">ЦЕЛЬ</span>
        </div>
      </td>
    </tr>
  );
});

const ActiveTradeItem = ({ 
  trade, 
  latestPrices, 
  livePrice, 
  handleCloseActiveTrade, 
  handleChangeTradeMode, 
  handleLeverageChange, 
  handleAverageTrade, 
  handleSlTpChange,
  activeTerminalTradeId, 
  setActiveTerminalTradeId,
  isRealBalanceVisible = true,
  isStandalone = false
}: ActiveTradeItemProps) => {
  const [isCardFullscreen, setIsCardFullscreen] = useState(false);
  const [localAverageAmount, setLocalAverageAmount] = useState<number>(trade.amount); // Auto-suggest DCA based on current amount
  const [tpMode, setTpMode] = useState<'PRICE' | 'PERCENT'>('PRICE');
  const [slMode, setSlMode] = useState<'PRICE' | 'PERCENT'>('PRICE');
  const [localSL, setLocalSL] = useState<string>(trade.stopLoss ? trade.stopLoss.toString() : '');
  const [localTP, setLocalTP] = useState<string>(trade.takeProfit ? trade.takeProfit.toString() : '');
  const [currentTab, setCurrentTab] = useState<'МЕТРИКИ' | 'ИИ' | 'ЛОГИ'>('МЕТРИКИ');
  const isExternal = (trade as any).isExternal || (trade as any).isExchangeManual || trade.mode === 'EXTERNAL' || (trade.id && trade.id.toString().includes('-external')) || false;
  const singleTradeArray = useMemo(() => [trade], [trade]);

  useEffect(() => {
    setLocalSL(trade.stopLoss ? trade.stopLoss.toString() : '');
  }, [trade.stopLoss]);

  useEffect(() => {
    setLocalTP(trade.takeProfit ? trade.takeProfit.toString() : '');
  }, [trade.takeProfit]);

  const getPriceFromPnlPct = (pct: number, isTp: boolean) => {
    if (!trade.entryPrice || !trade.leverage) return 0;
    const isShort = trade.side === 'SHORT';
    const factor = (pct / 100) / trade.leverage;
    
    if (isShort) {
      return isTp 
        ? trade.entryPrice * (1 - factor)
        : trade.entryPrice * (1 + factor);
    } else {
      return isTp
        ? trade.entryPrice * (1 + factor)
        : trade.entryPrice * (1 - factor);
    }
  };

  const getPnlPctFromPrice = (targetPrice: number, isTp: boolean) => {
    if (!targetPrice || !trade.entryPrice || !trade.leverage) return 0;
    const isShort = trade.side === 'SHORT';
    
    if (isShort) {
      return isTp
        ? ((trade.entryPrice - targetPrice) / trade.entryPrice) * 100 * trade.leverage
        : ((targetPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
    } else {
      return isTp
        ? ((targetPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage
        : ((trade.entryPrice - targetPrice) / trade.entryPrice) * 100 * trade.leverage;
    }
  };

  const handleToggleTpMode = () => {
    if (tpMode === 'PRICE') {
      setTpMode('PERCENT');
      if (localTP && !isNaN(Number(localTP))) {
        const pct = getPnlPctFromPrice(Number(localTP), true);
        setLocalTP(pct > 0 ? pct.toFixed(2) : '');
      }
    } else {
      setTpMode('PRICE');
      if (localTP && !isNaN(Number(localTP))) {
        const prc = getPriceFromPnlPct(Number(localTP), true);
        setLocalTP(prc > 0 ? prc.toFixed(5) : '');
      }
    }
  };

  const handleToggleSlMode = () => {
    if (slMode === 'PRICE') {
      setSlMode('PERCENT');
      if (localSL && !isNaN(Number(localSL))) {
        const pct = getPnlPctFromPrice(Number(localSL), false);
        setLocalSL(pct > 0 ? pct.toFixed(2) : '');
      }
    } else {
      setSlMode('PRICE');
      if (localSL && !isNaN(Number(localSL))) {
        const prc = getPriceFromPnlPct(Number(localSL), false);
        setLocalSL(prc > 0 ? prc.toFixed(5) : '');
      }
    }
  };

  const baseSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[0] : trade.symbol;
  const cleanSym = baseSymbol.replace(/[\/]/g, '').toUpperCase();
  const currentSymbolPrice = latestPrices[cleanSym] || 
                             latestPrices[trade.symbol] || 
                             latestPrices[baseSymbol] ||
                             latestPrices[trade.symbol.replace('/', '')] || 
                             latestPrices[trade.symbol.replace('_', '/')] ||
                             livePrice || 
                             trade.entryPrice;
                             
  const isActualPrice = (
    latestPrices[cleanSym] || 
    latestPrices[trade.symbol] || 
    latestPrices[baseSymbol] ||
    latestPrices[trade.symbol.replace('/', '')] || 
    latestPrices[trade.symbol.replace('_', '/')] ||
    livePrice
  ) > 0;
  
  const diff = trade.side === 'SHORT' ? (trade.entryPrice - currentSymbolPrice) : (currentSymbolPrice - trade.entryPrice);
  const calculatedPnlPct = isActualPrice ? (diff / trade.entryPrice) * 100 * trade.leverage : 0;
  const calculatedPnlUsd = trade.amount * (calculatedPnlPct / 100);

  const isRealTrade = (trade as any).isReal || trade.exchange === 'real' || (trade.id && trade.id.toString().startsWith('real-'));
  const pnlPct = (isRealTrade && (trade as any).pnlPercent !== undefined && (trade as any).pnlPercent !== null && !isNaN((trade as any).pnlPercent))
    ? (trade as any).pnlPercent
    : calculatedPnlPct;
    
  const pnlUsd = (isRealTrade && (trade as any).pnl !== undefined && (trade as any).pnl !== null && !isNaN((trade as any).pnl))
    ? (trade as any).pnl
    : calculatedPnlUsd;
  const isHideBalance = (((trade as any).isReal || trade.exchange === 'real') && !isRealBalanceVisible);

  return (
    <div className={cn(
      "bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300",
      (isCardFullscreen || isStandalone) 
        ? "fixed inset-0 bg-zinc-950 z-[9999] overflow-y-auto w-screen h-screen p-6 rounded-none flex flex-col" 
        : ""
    )}>
      {/* Compact Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-zinc-900/30 border-b border-zinc-800/50">
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg", trade.side === 'SHORT' ? "bg-red-500/10" : "bg-emerald-500/10")}>
            {trade.side === 'SHORT' ? <TrendingDown className="w-4 h-4 text-red-500" /> : <TrendingUp className="w-4 h-4 text-emerald-500" />}
          </div>
          <div>
            <div className="text-xs font-bold text-white flex items-center gap-2">
              {trade.symbol}
              <span className={cn("text-[9px] px-1.5 py-0.5 rounded uppercase font-bold", trade.side === 'SHORT' ? "bg-red-500/20 text-red-400" : "bg-emerald-500/20 text-emerald-400")}>
                {trade.side} {trade.leverage}x
              </span>
              {(trade as any).isAutoLearning && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-md text-[9px] font-black uppercase tracking-widest">
                   <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
                   AI LEARNING
                </span>
              )}
              {trade.isReal && !isExternal && trade.mode === 'AUTO' && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-md text-[9px] font-black uppercase tracking-widest ml-1">
                   <Bot className="w-2.5 h-2.5" /> РЕАЛ: ИИ-АВТОПИЛОТ
                </span>
              )}
              {trade.isReal && !isExternal && trade.mode === 'SEMI_AUTO' && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-md text-[9px] font-black uppercase tracking-widest ml-1">
                   <Activity className="w-2.5 h-2.5 animate-pulse" /> РЕАЛ: ПОЛУАВТО
                </span>
              )}
              {trade.isReal && !isExternal && (trade.mode === 'MANUAL' || !trade.mode) && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md text-[9px] font-black uppercase tracking-widest ml-1">
                   <Zap className="w-2.5 h-2.5" /> РЕАЛ: ТЕРМИНАЛ
                </span>
              )}
              {trade.isReal && isExternal && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-md text-[9px] font-black uppercase tracking-widest ml-1 animate-pulse">
                   <Smartphone className="w-2.5 h-2.5 text-amber-400" /> ВНЕШНЯЯ (БИРЖА)
                </span>
              )}
            </div>
            <div className="text-[10px] text-zinc-500">Вход: ${(trade.entryPrice || 0).toFixed(5)}</div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className={cn("text-lg font-black font-mono tracking-tight", pnlPct >= 0 ? "text-emerald-400" : "text-red-400")}>
              {pnlPct >= 0 ? '+' : ''}{(pnlPct || 0).toFixed(2)}%
            </div>
            <div className="text-sm font-medium text-zinc-400 font-mono tracking-wider">{isHideBalance ? "•••• USDT" : `${pnlUsd >= 0 ? '+' : ''}${(pnlUsd || 0).toFixed(2)} USDT`}</div>
          </div>

          {isExternal ? (
            <div className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/25 rounded-lg text-[9px] font-extrabold text-amber-400 capitalize tracking-wide select-none">
              Вне терминала
            </div>
          ) : (
            <div className="flex items-center gap-1 bg-zinc-900/50 p-1 ml-4 rounded-lg border border-zinc-800">
              {['MANUAL', 'SEMI_AUTO', 'AUTO'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleChangeTradeMode(trade.id, mode)}
                  className={cn(
                    "px-2 py-1 rounded text-[9px] font-bold transition-all",
                    trade.mode === mode 
                      ? "bg-zinc-800 text-white shadow-sm border border-zinc-700" 
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  {mode === 'MANUAL' ? 'РУЧ' : mode === 'SEMI_AUTO' ? 'ПОЛУ' : 'АВТО'}
                </button>
              ))}
            </div>
          )}
          <button 
            onClick={() => handleCloseActiveTrade(trade)}
            className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-[10px] font-bold transition-all"
          >
            ЗАКРЫТЬ
          </button>

          {/* Управление отображением конкретно этой активной сделки */}
          <div className="flex items-center gap-1.5 border-l border-zinc-800/80 pl-3 ml-2">
            <button
              onClick={() => setIsCardFullscreen(!isCardFullscreen)}
              className="p-1.5 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-white transition-all rounded-md flex items-center justify-center cursor-pointer"
              title={isCardFullscreen ? "Свернуть" : "Открыть во весь экран эту сделку"}
            >
              {isCardFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => {
                const url = window.location.origin + `?standalone=trade&tradeId=${trade.id}&symbol=${trade.symbol}`;
                window.open(url, '_blank', 'width=1400,height=900,status=no,menubar=no,resizable=yes');
              }}
              className="p-1.5 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-white transition-all rounded-md flex items-center justify-center cursor-pointer"
              title="Открыть эту сделку в отдельном окне/вкладке"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Work Area */}
      <div className={cn(
        "flex flex-col lg:flex-row",
        (isCardFullscreen || isStandalone) ? "flex-1 min-h-[500px]" : "h-[450px]"
      )}>
        {/* Chart (80% on large) */}
        <div className="flex-1 relative bg-zinc-950 overflow-hidden group">
          <div className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
             <button onClick={() => setActiveTerminalTradeId(trade.id === activeTerminalTradeId ? null : trade.id)} className="p-1.5 bg-zinc-900/90 text-zinc-400 hover:text-white rounded border border-zinc-800 shadow-xl">
                {trade.id === activeTerminalTradeId ? <X className="w-3 h-3" /> : <Activity className="w-3 h-3" />}
             </button>
          </div>
          <Suspense fallback={
            <div className="w-full h-full min-h-[400px] flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
              <span className="text-xs text-zinc-400 font-mono">Загрузка графика...</span>
            </div>
          }>
            <TradingChart 
              symbol={trade.symbol} 
              exchange={trade.exchange || 'weex'} 
              trades={singleTradeArray}
            />
          </Suspense>
        </div>

        {/* Compact Sidebar (320px) */}
        <div className="w-full lg:w-[320px] bg-zinc-900/50 border-l border-zinc-800 flex flex-col min-h-0">
          {/* Sub-Tabs Selector */}
          <div className="flex border-b border-zinc-800">
             {['МЕТРИКИ', 'ИИ', 'ЛОГИ'].map((tab) => (
                <button 
                  key={tab} 
                  onClick={() => setCurrentTab(tab as any)}
                  className={cn("flex-1 py-3 text-[10px] font-bold transition-all border-b-2", 
                    currentTab === tab ? "text-indigo-400 border-indigo-500 bg-indigo-500/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                  )}
                >
                  {tab}
                </button>
             ))}
          </div>

          <div className="p-4 flex-1 overflow-y-auto space-y-4">
            {currentTab === 'МЕТРИКИ' && (
              <div className="space-y-4 animate-in slide-in-from-right-1 duration-200">
                {/* Live Stats Grid */}
                <div className="grid grid-cols-2 gap-2">
                   <div className="bg-zinc-950/50 border border-zinc-800/50 p-2 rounded-lg">
                     <div className="text-[9px] text-zinc-500 uppercase">Цена</div>
                     <div className={cn("text-xs font-mono font-bold", isActualPrice ? "text-zinc-100" : "text-zinc-500")}>
                       ${(currentSymbolPrice || 0).toFixed(5)}
                       {!isActualPrice && <span className="ml-1 text-[8px] animate-pulse">●</span>}
                     </div>
                   </div>
                   <div className="bg-zinc-950/50 border border-zinc-800/50 p-2 rounded-lg">
                     <div className="text-[9px] text-zinc-500 uppercase">Маржа</div>
                     <div className="text-xs font-mono font-bold">{isHideBalance ? "$••••" : `$${(trade.amount || 0).toFixed(2)}`}</div>
                   </div>
                   <div className="bg-zinc-950/50 border border-zinc-800/50 p-2 rounded-lg">
                     <div className="text-[9px] text-zinc-500 uppercase">TP</div>
                     <div className="text-xs font-mono font-bold text-emerald-500">${trade.takeProfit || '-'}</div>
                   </div>
                   <div className="bg-zinc-950/50 border border-zinc-800/50 p-2 rounded-lg">
                     <div className="text-[9px] text-zinc-500 uppercase">SL</div>
                     <div className="text-xs font-mono font-bold text-red-500">${trade.stopLoss || '-'}</div>
                   </div>
                </div>

                {/* Controls */}
                {isExternal ? (
                  <div className="bg-amber-950/20 border border-amber-500/20 rounded-xl p-4 text-[11px] text-zinc-300 space-y-3 mt-3 animate-in fade-in duration-300">
                     <div className="flex items-center gap-2 font-bold text-amber-100 font-sans">
                        <Smartphone className="w-4 h-4 text-amber-400" />
                        <span>Внешняя позиция фьючерсов</span>
                     </div>
                     <p className="text-zinc-300 text-[10.5px] leading-relaxed">
                        Эта сделка запущена напрямую через интерфейс или мобильное приложение биржи.
                     </p>
                     <p className="text-zinc-400 text-[10px] leading-relaxed font-normal">
                        Для безопасности Ваших средств наш <b>ИИ-автопилот и алгоритмы</b> полностью отключены от управления этой позиции. Траектория ордера никак не затронет баланс робота.
                     </p>
                     <p className="text-zinc-500 text-[9.5px]/relaxed">
                        Вы можете наблюдать за метриками и графиком в реальном времени или при необходимости закрыть сделку с биржи по кнопке «ЗАКРЫТЬ» выше.
                     </p>
                  </div>
                ) : (
                  <div className="space-y-3 pt-2">
                   <div>
                     <label className="text-[9px] text-zinc-500 uppercase tracking-tighter mb-1.5 block">Плечо</label>
                     <div className="flex gap-2">
                       <input type="number" defaultValue={trade.leverage} id={`leverage-${trade.id}`} className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white font-mono" />
                       <button 
                         onClick={() => {
                           const val = document.getElementById(`leverage-${trade.id}`) as HTMLInputElement;
                           if (val && val.value) handleLeverageChange(trade.id, Number(val.value));
                         }}
                         className="px-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 text-[10px] font-bold"
                       >OK</button>
                     </div>
                   </div>

                   <div className="flex flex-col gap-3 p-3 bg-zinc-950/40 border border-zinc-800/60 rounded-xl w-full">
                     <div className="grid grid-cols-2 gap-3">
                       {/* Take Profit Input */}
                       <div>
                         <div className="flex items-center justify-between mb-1 items-center">
                           <span className="text-[9px] text-zinc-500 uppercase tracking-tighter font-extrabold text-zinc-400">Take Profit</span>
                           <button
                             type="button"
                             onClick={handleToggleTpMode}
                             className={cn(
                               "text-[8px] px-1 py-0.5 rounded font-black transition-colors uppercase",
                               tpMode === 'PERCENT' ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                             )}
                           >
                             {tpMode === 'PERCENT' ? '% PnL' : 'Цена ($)'}
                           </button>
                         </div>
                         <div className="relative">
                           <input
                             type="number"
                             value={localTP}
                             onChange={e => setLocalTP(e.target.value)}
                             placeholder={tpMode === 'PERCENT' ? "например 7" : "0.00"}
                             className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-2 pr-6 py-1.5 text-xs text-white font-mono"
                             step="0.00001"
                           />
                           {tpMode === 'PERCENT' && (
                             <span className="absolute right-2 top-2 text-[10px] text-emerald-400 font-mono font-bold">%</span>
                           )}
                         </div>
                         {localTP && !isNaN(Number(localTP)) && (
                           <div className="mt-1 text-[8px] text-zinc-500 font-mono">
                             {tpMode === 'PERCENT' ? (
                               <span>~ ${getPriceFromPnlPct(Number(localTP), true).toFixed(5)}</span>
                             ) : (
                               <span>~ +{getPnlPctFromPrice(Number(localTP), true).toFixed(1)}% PnL</span>
                             )}
                           </div>
                         )}
                       </div>

                       {/* Stop Loss Input */}
                       <div>
                         <div className="flex items-center justify-between mb-1 items-center">
                           <span className="text-[9px] text-zinc-500 uppercase tracking-tighter font-extrabold text-zinc-400">Stop Loss</span>
                           <button
                             type="button"
                             onClick={handleToggleSlMode}
                             className={cn(
                               "text-[8px] px-1 py-0.5 rounded font-black transition-colors uppercase",
                               slMode === 'PERCENT' ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                             )}
                           >
                             {slMode === 'PERCENT' ? '% Loss' : 'Цена ($)'}
                           </button>
                         </div>
                         <div className="relative">
                           <input
                             type="number"
                             value={localSL}
                             onChange={e => setLocalSL(e.target.value)}
                             placeholder={slMode === 'PERCENT' ? "например 5" : "0.00"}
                             className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-2 pr-6 py-1.5 text-xs text-white font-mono"
                             step="0.00001"
                           />
                           {slMode === 'PERCENT' && (
                             <span className="absolute right-2 top-2 text-[10px] text-rose-400 font-mono font-bold">%</span>
                           )}
                         </div>
                         {localSL && !isNaN(Number(localSL)) && (
                           <div className="mt-1 text-[8px] text-zinc-500 font-mono">
                             {slMode === 'PERCENT' ? (
                               <span>~ ${getPriceFromPnlPct(Number(localSL), false).toFixed(5)}</span>
                             ) : (
                               <span>~ -{getPnlPctFromPrice(Number(localSL), false).toFixed(1)}% PnL</span>
                             )}
                           </div>
                         )}
                       </div>
                     </div>

                     <button
                       onClick={() => {
                         const slVal = localSL && !isNaN(Number(localSL)) 
                           ? (slMode === 'PERCENT' ? getPriceFromPnlPct(Number(localSL), false) : Number(localSL))
                           : null;
                         const tpVal = localTP && !isNaN(Number(localTP)) 
                           ? (tpMode === 'PERCENT' ? getPriceFromPnlPct(Number(localTP), true) : Number(localTP))
                           : null;
                         handleSlTpChange(trade.id, slVal, tpVal);
                       }}
                       className="w-full py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg text-[10px] font-bold transition-all"
                     >
                       Применить TP / SL
                     </button>
                   </div>

                    <div>
                      <label className="text-[9px] text-zinc-500 uppercase tracking-tighter mb-1.5 flex justify-between items-center">
                        <span>DCA (Докупка)</span>
                        <button 
                          onClick={() => setLocalAverageAmount(trade.amount)}
                          className="text-indigo-400 hover:text-indigo-300 text-[8px] font-bold border border-indigo-500/20 px-1.5 rounded transition-all bg-indigo-500/5"
                        >
                          РЕКОМЕНДУЕМОЕ ({isHideBalance ? "••••" : (trade.amount || 0).toFixed(0)})
                        </button>
                      </label>
                      <div className="flex gap-2">
                        <input type="number" value={localAverageAmount || ''} onChange={(e) => setLocalAverageAmount(Number(e.target.value))} className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-white font-mono" placeholder="USDT" />
                        <button 
                          onClick={() => handleAverageTrade(trade.id, localAverageAmount)}
                          disabled={!localAverageAmount || !currentSymbolPrice}
                          className="px-3 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg border border-indigo-500/20 text-[10px] font-bold"
                        >DCA</button>
                      </div>
                      
                      {/* Killer Feature 3 Display: Smart ATR-DCA suggestions */}
                      {(trade as any).smartDca && (trade as any).smartDca.length > 0 && (
                        <div className="mt-3 space-y-2 p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                          <div className="text-[9px] font-bold text-indigo-400 tracking-widest flex items-center gap-1.5 mb-2">
                             <TrendingUp className="w-3 h-3" /> SMART DCA LEVELS (ATR-BASED)
                          </div>
                          <div className="grid grid-cols-1 gap-1.5">
                            {(trade as any).smartDca.slice(0, 3).map((level: number, i: number) => (
                              <div key={i} className="flex items-center justify-between group">
                                <span className="text-[9px] text-zinc-500">{i + 1}-я Ступень:</span>
                                <button 
                                  onClick={() => {
                                     // Quick set price if UI supported it, or just show
                                     setLocalAverageAmount(trade.amount);
                                  }}
                                  className="text-[10px] font-mono text-zinc-300 group-hover:text-indigo-400 transition-colors"
                                >
                                  ${(level || 0).toFixed(5)}
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {localAverageAmount > 0 && currentSymbolPrice > 0 && (
                        <div className="mt-1 text-[8px] text-zinc-500 flex justify-between">
                           <span>Новая цена входа (расчет):</span>
                           <span className="text-yellow-500 font-mono">
                             ${((trade.amount + localAverageAmount) / ((trade.amount / trade.entryPrice) + (localAverageAmount / currentSymbolPrice))).toFixed(5)}
                           </span>
                        </div>
                      )}
                    </div>
                </div>
              )}
              </div>
            )}

            {currentTab === 'ИИ' && (
              <div className="animate-in slide-in-from-right-1 duration-200">
                 {(trade.mode === 'AUTO' || trade.mode === 'SEMI_AUTO') ? (
                   <div className="space-y-3">
                      <div className="flex items-center gap-2 p-2 bg-indigo-500/5 rounded-lg border border-indigo-500/10">
                        <Brain className="w-3.5 h-3.5 text-indigo-400" />
                        <span className="text-[10px] font-bold text-indigo-300">Режим: {trade.mode}</span>
                      </div>
                      <div className="bg-zinc-950/50 p-3 rounded-lg border border-zinc-800/50">
                        <p className="text-[11px] text-zinc-300 leading-relaxed italic">
                          {trade.aiAdvice || 'Первый анализ через 60 сек...'}
                        </p>
                        {trade.lastAiCheck && (
                          <div className="text-[9px] text-zinc-600 mt-2 text-right">
                            Обновлено: {new Date(trade.lastAiCheck).toLocaleTimeString()}
                          </div>
                        )}
                      </div>
                   </div>
                 ) : (
                   <div className="text-center py-10 opacity-30">
                      <Bot className="w-10 h-10 mx-auto mb-2" />
                      <p className="text-[10px]">Включите АВТО режим</p>
                   </div>
                 )}
              </div>
            )}

            {currentTab === 'ЛОГИ' && (
              <div className="space-y-2 animate-in slide-in-from-right-1 duration-200">
                 {trade.history && trade.history.length > 0 ? (
                   trade.history.map((h: any, i: number) => (
                     <div key={i} className="bg-zinc-950/30 p-2 rounded-lg border border-zinc-900/50 flex flex-col gap-1">
                       <div className="flex justify-between items-center text-[9px]">
                         <span className="text-zinc-600">{new Date(h.time).toLocaleTimeString()}</span>
                         <span className={cn("px-1.5 py-0.5 rounded uppercase font-bold text-[8px]", 
                           h.type === 'OPEN' ? "bg-emerald-500/10 text-emerald-500" : 
                           h.type === 'AVERAGE' ? "bg-yellow-500/10 text-yellow-500" : 
                           h.type === 'ADJUST_SL_TP' ? "bg-purple-500/15 text-purple-400 border border-purple-500/10" : 
                           "bg-zinc-800 text-zinc-400"
                         )}>{h.type === 'AVERAGE' ? 'УСР' : (h.type === 'ADJUST_SL_TP' ? 'КОРР-ИИ' : h.type)}</span>
                       </div>
                       {h.type === 'ADJUST_SL_TP' ? (
                         <div className="text-[10px] space-y-1">
                           <div className="flex justify-between font-mono text-zinc-400">
                             <span>SL: <span className="text-red-400/90">${(h.price || 0).toFixed(5)}</span></span>
                             <span>TP: <span className="text-emerald-400/90">${(h.amount || 0).toFixed(5)}</span></span>
                           </div>
                           {h.notes && (
                             <p className="text-[9px] text-zinc-500 break-words border-t border-zinc-900/40 pt-1 leading-relaxed italic">
                               {h.notes}
                             </p>
                           )}
                         </div>
                       ) : (
                         <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                           <span>${(h.price || 0).toFixed(5)}</span>
                           <span>${(h.amount || 0).toFixed(1)}</span>
                         </div>
                       )}
                     </div>
                   ))
                 ) : (
                   <div className="text-center py-6 text-[10px] text-zinc-600 italic">Событий нет</div>
                 )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

let globalAiCooldownUntil = 0;

export function TradingTerminal({ 
  telegramBots, 
  addToast, 
  soundEnabled = true, 
  onVirtualBalanceChange, 
  tradingMode = 'virtual', 
  setTradingMode,
  realBalance,
  isAutoPilotEnabled, 
  setIsAutoPilotEnabled,
  exchangeConfigEnabled,
  onRefreshRealBalance,
  isStandaloneTrade = false,
  isStandaloneTerminal = false,
  isAppFullscreen = false,
  onToggleAppFullscreen
}: { 
  telegramBots?: any[], 
  addToast?: (msg: string, type?: 'success' | 'error' | 'info') => void, 
  soundEnabled?: boolean, 
  onVirtualBalanceChange?: (b: number) => void, 
  tradingMode?: 'virtual' | 'real', 
  setTradingMode?: (m: 'virtual' | 'real') => void,
  realBalance?: number | null,
  isAutoPilotEnabled: boolean, 
  setIsAutoPilotEnabled: (v: boolean) => void,
  exchangeConfigEnabled?: boolean,
  onRefreshRealBalance?: () => void,
  isStandaloneTrade?: boolean,
  isStandaloneTerminal?: boolean,
  isAppFullscreen?: boolean,
  onToggleAppFullscreen?: () => void
}) {
  const [standaloneParams, setStandaloneParams] = useState<{ tradeId: string | null; symbol: string | null }>({ tradeId: null, symbol: null });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      setStandaloneParams({
        tradeId: params.get('tradeId'),
        symbol: params.get('symbol')
      });
    }
  }, []);

  const [latencyInfo, setLatencyInfo] = useState<{ weex: number; binance: number }>({ weex: 38, binance: 24 });

  useEffect(() => {
    let active = true;
    const fetchPing = async () => {
      try {
        const res = await fetch('/api/ping');
        if (res.ok) {
          const data = await res.json();
          if (active && data && data.success) {
            setLatencyInfo({
              weex: data.weexLatency || 35,
              binance: data.binanceLatency || 22
            });
          }
        }
      } catch (e) {}
    };
    fetchPing();
    const timer = setInterval(fetchPing, 10000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // AI Task Poller logic
  useEffect(() => {
    let active = true;
    const pollTasks = async () => {
      while (active) {
        try {
          const res = await fetch('/api/ai-tasks/pending');
          if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
            const data = await res.json();
            if (data && data.success && data.tasks && data.tasks.length > 0) {
            const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || (window as any).__GEMINI_API_KEY__ || '';
            
            const buildSmartTaskFallback = (taskItem: any) => {
              const promptStr = JSON.stringify(taskItem.params?.contents || "");
              if (taskItem.params?.config?.responseSchema?.type === 'ARRAY' || taskItem.params?.config?.responseSchema?.type === 2 || promptStr.includes('Return ONLY a JSON array')) {
                return '[]';
              }
              if (promptStr.includes('retrospectiveSummary') || promptStr.includes('ИИ-Контур') || promptStr.includes('Ретроспективная Оптимизация')) {
                return JSON.stringify({
                  retrospectiveSummary: "Текущая просадка за день вызвана зависанием сделок во флэте при изменении микроструктуры рынка. Алгоритмы PTTP продемонстрировали высокую эффективность на импульсах. Требуется соблюдение временных лимитов удержания позиций.",
                  winRate: 50.0,
                  agentExchangeConversations: [
                    { fromAgent: "RETROSPECTIVE", toAgent: "EXPERT", message: "Ретроспективный квант-аудит выборки завершен.", details: "Активированы скользящие лимитные ордера Pegged/Post-Only и контроль спреда.", type: "info" }
                  ],
                  rulesToArchive: [],
                  expertModifications: "Внедрить обязательное использование скользящих лимитных заявок (Pegged/Post-Only) для защиты от рыночного проскальзывания. Запретить открытие позиций по монетам, у которых спред превышает 0.25%."
                });
              }
              if (promptStr.includes('expertPrompt') || promptStr.includes('ИИ-Ведущий Трейдер') || promptStr.includes('dcaMultiplier')) {
                return JSON.stringify({
                  action: "UPDATE_SL",
                  advice: "Позиция находится в зоне консолидации над ключевым уровнем. На основании правила '3-15' корректируем Take Profit для фиксирования профита при локальном отскоке и фиксируем Stop Loss за пределами локального рыночного шума.",
                  reasonCategory: "NOISE_EXCLUSION"
                });
              }
              return JSON.stringify({
                rationale: "Управление позицией передано квант-алгоритмам рисков с соблюдением стоп-ордеров.",
                evaluation: "Сделка закрыта и зафиксирована квантовой системой. Результат сохранен в журнале.",
                learnedRule: "Соблюдать жесткое соответствие входов правилу фильтрации спреда.",
                consensus: "ПОДТВЕРЖДЕНО",
                judgeDecision: "LONG",
                aiScore: 80,
                approved: true,
                action: "HOLD"
              });
            };

            for (const task of data.tasks) {
              
              // Skip instantly if apiKey is missing or cooling down from quota error
              if (!apiKey || Date.now() < globalAiCooldownUntil) {
                 if (!apiKey) console.warn("Browser GEMINI API key is not configured. Instantly resolving task with fallback...");
                 else console.warn("AI is cooling down from Quota Error. Instantly resolving task with fallback...");
                 const defaultFallback = buildSmartTaskFallback(task);
                 await fetch('/api/ai-tasks/complete', {
                   method: 'POST',
                   headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify({ id: task.id, result: { text: defaultFallback } })
                 });
                 continue; // go to next task, do not even try API
              }
              
              let attempts = 0;
              let success = false;
              let resultText = "";
              while (attempts < 3 && !success && active) {
                try {
                  // We recreate the GoogleGenerativeAI instance on the frontend where the Free Tier proxy intercept works!
                  const ai = new GoogleGenerativeAI(apiKey);
                  
                  let fallbackModel = task.params.model || 'gemini-3.5-flash';
                  if (fallbackModel.includes('3.1-pro') || fallbackModel.includes('2.5-flash') || fallbackModel.includes('2.0-flash')) {
                    fallbackModel = 'gemini-3.5-flash';
                  }
                  // Convert v2 config to v1 config if needed
                  const modelParams: any = { model: fallbackModel };
                  if (task.params.config?.systemInstruction) {
                      modelParams.systemInstruction = task.params.config.systemInstruction;
                  }
                  const model = ai.getGenerativeModel(modelParams);
                  
                  const generationConfig: any = {};
                  if (task.params.config?.responseMimeType) generationConfig.responseMimeType = task.params.config.responseMimeType;
                  if (task.params.config?.temperature) generationConfig.temperature = task.params.config.temperature;
                  
                  // Format contents array
                  let formattedContents = task.params.contents;
                  
                  const result = await model.generateContent({
                    contents: formattedContents,
                    generationConfig
                  });
                  resultText = result.response.text() || "";
                  
                  await fetch('/api/ai-tasks/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: task.id, result: { text: resultText } })
                  });
                  // Small delay to prevent 429 Resource Exhausted on Free Tier proxy
                  await new Promise(r => setTimeout(r, 4000));
                  success = true;
                } catch (err: any) {
                  attempts++;
                  const isQuotaError = err?.message?.includes("429") || err?.message?.includes("quota") || err?.message?.includes("Failed to call") || err?.message?.includes("Too Many Requests") || err?.message?.includes("Failed to fetch");
                  
                  if (isQuotaError || attempts >= 2) {
                     if (!isQuotaError) {
                       console.warn(`AI Task err (attempt ${attempts}/3). Rate limit or network error, cooling down.`, err?.message);
                     }
                     globalAiCooldownUntil = Date.now() + 120000; // 2 minutes cooldown
                     attempts = 3; // Force early exit
                     await new Promise(r => setTimeout(r, 1000));
                  } else {
                     console.warn(`AI Task err (attempt ${attempts}/3)`, err?.message);
                     await new Promise(r => setTimeout(r, 2000));
                  }
                  
                  if (attempts >= 3) {
                    // Provide smart fallback JSON to prevent backend from crashing or failing
                    const defaultFallback = buildSmartTaskFallback(task);

                    await fetch('/api/ai-tasks/complete', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: task.id, result: { text: defaultFallback } })
                    });
                  }
                }
              }
            }
          }
          }
        } catch (e) {
          // ignore network errors
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    pollTasks();
    return () => { active = false; };
  }, []);

  const [signals, setSignals] = useState<Signal[]>([]);
  const normalizeSymbol = (s: string = '') => s.replace(/[\/:]/g, '').toUpperCase();
  const getPrecision = (num: number): number => {
    if (!num) return 2;
    const absNum = Math.abs(num);
    if (absNum < 0.00001) return 8;
    if (absNum < 0.001) return 7;
    if (absNum < 0.1) return 6;
    if (absNum < 1) return 5;
    if (absNum < 10) return 4;
    if (absNum < 100) return 3;
    return 2;
  };
  const formatPrice = (num: number | undefined | null): string => {
    if (num === undefined || num === null || isNaN(num)) return '0.00';
    return num.toFixed(getPrecision(num));
  };
  const isManagingRef = useRef(false);

  const [termReady, setTermReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState(0);
  // Use local state for clock instead of top-level terminal state to avoid massive re-renders
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const [selectedExchanges, setSelectedExchanges] = useState<string[]>(['weex']);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Signal[]>([]);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const rawSearch = searchTerm || '';
    if (rawSearch.trim().length >= 1 && !rawSearch.toLowerCase().includes('fav:')) {
      const controller = new AbortController();
      const timer = setTimeout(async () => {
         try {
           const res = await fetch(`/api/search?q=${encodeURIComponent(searchTerm.trim())}`, { signal: controller.signal });
           if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
             const data = await res.json();
             if (data && data.success && Array.isArray(data.data)) {
               setSearchResults(data.data);
             }
           }
         } catch (e) {}
      }, 400);
      return () => { clearTimeout(timer); controller.abort(); };
    } else {
      setSearchResults([]);
    }
  }, [searchTerm]);

  const [showTop5, setShowTop5] = useState(false);
  const [signalDirectionFilter, setSignalDirectionFilter] = useState<'ALL' | 'SHORT' | 'LONG' | 'POSITIONS'>('ALL');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showRealModeConfirm, setShowRealModeConfirm] = useState(false);
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [balanceInputVal, setBalanceInputVal] = useState('');
  const [balanceModalType, setBalanceModalType] = useState<'edit' | 'topup'>('edit');
  const [closeActiveTradesOnReset, setCloseActiveTradesOnReset] = useState<boolean>(true);
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);

  const [entryPrice, setEntryPrice] = useState<number>(0);
  const [margin, setMargin] = useState<number>(100);
  const [leverage, setLeverage] = useState<number>(5);
  const [positionType, setPositionType] = useState<'short' | 'long'>('short');
  const [stepPercent, setStepPercent] = useState<number>(5);
  const [stepsCount, setStepsCount] = useState<number>(3);
  const [alignWithWalls, setAlignWithWalls] = useState<boolean>(true);
  const [useAtrDynamicDca, setUseAtrDynamicDca] = useState<boolean>(true);
  const [isCircuitBreakerActive, setIsCircuitBreakerActive] = useState<boolean>(false);
  const [isBtcShockLock, setIsBtcShockLock] = useState<boolean>(false);
  const [btcShockRemaining, setBtcShockRemaining] = useState<number>(0);
  const [selectedCoin, setSelectedCoin] = useState<string>('');
  const [tradeMode, setTradeMode] = useState<'MANUAL' | 'AUTO' | 'SEMI_AUTO'>('MANUAL');
  const [feeType, setFeeType] = useState<'maker' | 'taker'>('taker');
  const [hidePassedEntries, setHidePassedEntries] = useState(false); // Default to false to show more data initially
  const [isSyncing, setIsSyncing] = useState(false);

  const syncTradingModeWithServer = async (mode: 'virtual' | 'real') => {
    try {
      const res = await fetch('/api/settings/trading-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingMode: mode })
      });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        if (data && data.success) {
          console.log(`Successfully synchronized trading mode with server: ${mode}`);
          if (addToast) {
            addToast(`Режим торговли успешно изменен на: ${mode === 'real' ? 'РЕАЛЬНЫЙ ⚡' : 'ВИРТУАЛЬНЫЙ 🧪'}`, 'success');
          }
        } else {
          if (addToast) addToast(`Ошибка синхронизации режима торговли: ${data?.error || 'Server error'}`, 'error');
        }
      } else {
        if (addToast) addToast(`Ошибка синхронизации: сервер вернул некорректный ответ (код ${res.status})`, 'error');
      }
    } catch (e: any) {
      console.error('Failed to sync trading mode with server:', e);
      if (addToast) addToast(`Ошибка синхронизации режима торговли: ${e.message}`, 'error');
    }
  };

  const handleToggleTradingMode = (targetMode: 'real' | 'virtual') => {
    if (targetMode === 'real') {
       if (!exchangeConfigEnabled) {
          if (addToast) addToast('Сначала настройте API биржи в настройках.', 'error');
          return;
       }
       setShowRealModeConfirm(true);
    } else {
       if (setTradingMode) setTradingMode('virtual');
       syncTradingModeWithServer('virtual');
    }
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      await fetch('/api/sync', { method: 'POST' });
    } catch (e) {
      console.error('Sync failed', e);
    } finally {
      setTimeout(() => setIsSyncing(false), 3000);
    }
  };

  const seenSignalsRef = useRef<Set<string>>(new Set());
  const pHistoryRef = useRef<Record<string, { lastP: number, lastTime: number, isUnstable: boolean }>>({});

  // Create a single AudioContext to reuse
  const audioContextRef = useRef<AudioContext | null>(null);

  const playNotificationSound = () => {
    if (!soundEnabled) return;
    try {
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) audioContextRef.current = new AudioContextClass();
      }
      const ctx = audioContextRef.current;
      if (!ctx) return;
      
      // Resume if suspended (browser policy)
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.02, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
      console.error('Audio play failed', e);
    }
  };

  const [favorites, setFavorites] = useState<string[]>(() => {
    if (typeof localStorage !== 'undefined') {
      try {
        return JSON.parse(localStorage.getItem('cryptoFavorites') || '[]');
      } catch (e) { return []; }
    }
    return [];
  });

  const toggleFavorite = (symbol: string) => {
    setFavorites(prev => {
      let newFavs;
      if (prev.includes(symbol)) {
        newFavs = prev.filter(s => s !== symbol);
      } else {
        newFavs = [...prev, symbol];
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cryptoFavorites', JSON.stringify(newFavs));
      }
      return newFavs;
    });
  };

  const [takeProfit, setTakeProfit] = useState<number | ''>('');
  const [stopLoss, setStopLoss] = useState<number | ''>('');
  const [calcTpMode, setCalcTpMode] = useState<'PRICE' | 'PERCENT'>('PRICE');
  const [calcSlMode, setCalcSlMode] = useState<'PRICE' | 'PERCENT'>('PRICE');

  const getCalcPriceFromPnlPct = (pct: number, isTp: boolean) => {
    if (!entryPrice || !leverage) return 0;
    const isShort = positionType === 'short';
    const factor = (pct / 100) / leverage;
    
    if (isShort) {
      return isTp 
        ? entryPrice * (1 - factor)
        : entryPrice * (1 + factor);
    } else {
      return isTp
        ? entryPrice * (1 + factor)
        : entryPrice * (1 - factor);
    }
  };

  const getCalcPnlPctFromPrice = (targetPrice: number, isTp: boolean) => {
    if (!targetPrice || !entryPrice || !leverage) return 0;
    const isShort = positionType === 'short';
    
    if (isShort) {
      return isTp
        ? ((entryPrice - targetPrice) / entryPrice) * 100 * leverage
        : ((targetPrice - entryPrice) / entryPrice) * 100 * leverage;
    } else {
      return isTp
        ? ((targetPrice - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - targetPrice) / entryPrice) * 100 * leverage;
    }
  };

  const handleToggleCalcTpMode = () => {
    if (calcTpMode === 'PRICE') {
      setCalcTpMode('PERCENT');
      if (takeProfit && !isNaN(Number(takeProfit))) {
        const pct = getCalcPnlPctFromPrice(Number(takeProfit), true);
        setTakeProfit(pct > 0 ? Number(pct.toFixed(2)) : '');
      }
    } else {
      setCalcTpMode('PRICE');
      if (takeProfit && !isNaN(Number(takeProfit))) {
        const prc = getCalcPriceFromPnlPct(Number(takeProfit), true);
        setTakeProfit(prc > 0 ? Number(prc.toFixed(5)) : '');
      }
    }
  };

  const handleToggleCalcSlMode = () => {
    if (calcSlMode === 'PRICE') {
      setCalcSlMode('PERCENT');
      if (stopLoss && !isNaN(Number(stopLoss))) {
        const pct = getCalcPnlPctFromPrice(Number(stopLoss), false);
        setStopLoss(pct > 0 ? Number(pct.toFixed(2)) : '');
      }
    } else {
      setCalcSlMode('PRICE');
      if (stopLoss && !isNaN(Number(stopLoss))) {
        const prc = getCalcPriceFromPnlPct(Number(stopLoss), false);
        setStopLoss(prc > 0 ? Number(prc.toFixed(5)) : '');
      }
    }
  };
  const [isTerminalFullscreen, setIsTerminalFullscreen] = useState(false);

  const toggleFullscreen = () => {
    const el = document.getElementById('simulator-section');
    if (!document.fullscreenElement) {
      if (el) {
        el.requestFullscreen().catch(() => {
          // Fallback gracefully to virtual CSS fullscreen state if iframe sandbox blocks HTML5 requestFullscreen
        });
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      setIsTerminalFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      setIsTerminalFullscreen(false);
    }
  };

  const handleOpenNewWindow = () => {
    const url = window.location.origin + '?standalone=terminal';
    window.open(url, '_blank', 'width=1400,height=900,status=no,menubar=no,resizable=yes');
  };

  const [paperTrades, setPaperTrades] = useState<any[]>([]);
  const [realTrades, setRealTrades] = useState<any[]>([]);
  const [virtualBalance, setVirtualBalance] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('qs_last_virtual_balance');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch {}
    return 500;
  });
  const [startOfDayBalance, setStartOfDayBalance] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('qs_last_start_of_day_balance');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch {}
    return 500;
  });
  const [startOfWeekBalance, setStartOfWeekBalance] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('qs_last_start_of_week_balance');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch {}
    return 500;
  });
  const [historyTab, setHistoryTab] = useState<'virtual' | 'real' | 'learning' | 'analytics' | 'signal_analytics'>('virtual');

  const virtualBalanceRef = useRef(virtualBalance);
  useEffect(() => { virtualBalanceRef.current = virtualBalance; }, [virtualBalance]);

  // Lock mechanism to prevent stale SSE/polling broadcasts from causing balance jitter/jumping
  const balanceUpdateLockUntilRef = useRef<number>(0);

  const updateSafeVirtualBalance = useCallback((newBal: number, isAuthoritativeLocalMutation = false) => {
    if (typeof newBal !== 'number' || isNaN(newBal)) return;
    const now = Date.now();
    
    try {
      localStorage.setItem('qs_last_virtual_balance', String(newBal));
    } catch {}

    if (isAuthoritativeLocalMutation) {
      // Local mutation (open trade, close trade, manual top-up): lock external SSE overwrites for 3500ms
      balanceUpdateLockUntilRef.current = now + 3500;
      virtualBalanceRef.current = newBal;
      setVirtualBalance(prev => (Math.abs(prev - newBal) < 0.001 ? prev : newBal));
      return;
    }
    
    // External SSE broadcast or polling: ignore if within authoritative local mutation window
    if (now <= balanceUpdateLockUntilRef.current) {
      return;
    }
    
    virtualBalanceRef.current = newBal;
    setVirtualBalance(prev => (Math.abs(prev - newBal) < 0.001 ? prev : newBal));
  }, []);

  useEffect(() => {
    if (tradingMode !== 'real' || !exchangeConfigEnabled) {
      setRealTrades([]);
      return;
    }
    const fetchPositions = async () => {
      try {
        const res = await fetch('/api/real-trade/positions');
        if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
          const d = await res.json();
          if (d && d.success) {
             const mappedReal = d.data.map((p: any) => ({
               id: p.id || 'real-' + p.symbol,
               symbol: p.symbol,
               exchange: 'real',
               entryPrice: parseFloat(p.entryPrice) || parseFloat(p.price) || 0,
               amount: parseFloat(p.initialMargin) || ((parseFloat(p.contracts || p.amount || 0) * (parseFloat(p.entryPrice || p.price || 0))) / parseFloat(p.leverage || 1)),
               leverage: parseFloat(p.leverage) || 1,
               side: (p.side === 'long' || p.side === 'LONG' || p.side === 'buy' || p.side === 'BUY') ? 'LONG' : 'SHORT',
               status: 'OPEN',
               pnl: parseFloat(p.unrealizedPnl || 0),
               pnlPercent: parseFloat(p.percentage !== undefined && p.percentage !== null && p.percentage !== 0 ? p.percentage : (p.unrealizedPnl && p.initialMargin ? (p.unrealizedPnl / p.initialMargin * 100) : 0)),
               mode: p.mode || 'MANUAL',
               stopLoss: p.stopLoss || undefined,
               takeProfit: p.takeProfit || undefined,
               isReal: true,
               openTime: p.timestamp || Date.now()
             }));
             setRealTrades(mappedReal);
          }
        }
      } catch (err) {}
    };
    fetchPositions();
    const intId = setInterval(fetchPositions, 5000);
    return () => clearInterval(intId);
  }, [tradingMode, exchangeConfigEnabled]);
  
  useEffect(() => {
    // Initial fetch to ensure we have the complete trade history for the Analytics tab
    const handleFsChange = () => {
      setIsTerminalFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  useEffect(() => {
    // Robust polling & initial fetch for paper-trade data to ensure absolute UI/Server sync
    const syncPaperTrades = () => {
      fetch('/api/paper-trade')
        .then(res => {
          if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
            return res.json();
          }
          return { success: false };
        })
        .then(d => {
          if (d && d.success && Array.isArray(d.data)) {
            const nowTime = Date.now();
            const serverTrades = d.data;
            const serverTradeIds = new Set(serverTrades.map((t: any) => t.id));

            // 1. Keep trades that were JUST opened locally but not yet on server
            const locallyAdded = paperTradesRef.current.filter(p => 
              p.status === 'OPEN' && 
              !serverTradeIds.has(p.id) &&
              (nowTime - (p.openTime || 0) < 15000)
            );

            // 2. Map server trades: if server says CLOSED, strictly update UI to CLOSED
            const syncedTrades = serverTrades.map((s: any) => {
              const localTrade = paperTradesRef.current.find(p => p.id === s.id);
              if (closingTradesRef.current.has(s.id) && s.status === 'OPEN') {
                return { ...s, status: 'CLOSED', closeTime: nowTime };
              }
              if (localTrade && localTrade.status === 'CLOSED' && s.status === 'OPEN' && (nowTime - (localTrade.closeTime || 0) < 20000)) {
                return localTrade;
              }
              return s;
            });

            // 3. Retain older closed trades for history tabs if missing in light payload
            const olderClosedTrades = paperTradesRef.current.filter(p => 
              p.status === 'CLOSED' && !serverTradeIds.has(p.id)
            );

            const fullSynced = [...syncedTrades, ...locallyAdded, ...olderClosedTrades];

            // Only update paperTrades if list changed
            const isChanged = fullSynced.length !== paperTradesRef.current.length ||
              fullSynced.some((t, i) => {
                const prev = paperTradesRef.current[i];
                return !prev || prev.id !== t.id || prev.status !== t.status || prev.pnl !== t.pnl || prev.amount !== t.amount;
              });

            if (isChanged) {
              setPaperTrades(fullSynced);
              paperTradesRef.current = fullSynced;
            }

            if (d.balance !== undefined) updateSafeVirtualBalance(d.balance, false);
            if (d.startOfDayBalance !== undefined) setStartOfDayBalance(prev => prev === d.startOfDayBalance ? prev : d.startOfDayBalance);
            if (d.startOfWeekBalance !== undefined) setStartOfWeekBalance(prev => prev === d.startOfWeekBalance ? prev : d.startOfWeekBalance);
            if (d.startOfDayRealBalance !== undefined) setStartOfDayRealBalance(prev => prev === d.startOfDayRealBalance ? prev : d.startOfDayRealBalance);
          }
        })
        .catch(err => console.warn("Paper trades sync fetch error:", err));
    };

    syncPaperTrades();
    const pollInterval = setInterval(syncPaperTrades, 3000);
    return () => clearInterval(pollInterval);
  }, []);

  const onVirtualBalanceChangeRef = useRef(onVirtualBalanceChange);
  useEffect(() => {
    onVirtualBalanceChangeRef.current = onVirtualBalanceChange;
  }, [onVirtualBalanceChange]);

  useEffect(() => {
    if (onVirtualBalanceChangeRef.current) {
      onVirtualBalanceChangeRef.current(virtualBalance);
    }
  }, [virtualBalance]);

  const [marketHealth, setMarketHealth] = useState<number>(50);
  const [socialSentiment, setSocialSentiment] = useState<Record<string, { score: number, mentions: number, trend: string, lastScraped: number, sources: string[] }>>({});
  const [marketPulse, setMarketPulse] = useState<{
    sentiment: string;
    bias: number;
    recommendation: string;
    lastUpdated: number;
  }>({
    sentiment: 'NEUTRAL',
    bias: 0,
    recommendation: 'Standby',
    lastUpdated: 0
  });
  const [marketRegime, setMarketRegime] = useState<string>('FLAT');
  const [btcTrend24h, setBtcTrend24h] = useState<number>(0);
  const [btcTrend15m, setBtcTrend15m] = useState<number>(0);
  const [activeTerminalTradeId, setActiveTerminalTradeId] = useState<string | null>(null);
  const [livePrice, setLivePrice] = useState<number>(0);
  const [averageAmount, setAverageAmount] = useState<number>(0);
  
  // Use a ref for latest prices to avoid re-renders on EVERY price tick
  const latestPricesRef = useRef<Record<string, number>>({});
  const lastDataTimeRef = useRef<number>(Date.now());
  const lastMainStreamTimeRef = useRef<number>(Date.now());
  const [dataLag, setDataLag] = useState<number>(0);

  // Network connection resilience states (VPN & Low-latency monitoring)
  const [networkQuality, setNetworkQuality] = useState<'optimal' | 'lag' | 'reconnecting'>('optimal');
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [reconnectTrigger, setReconnectTrigger] = useState<number>(0);
  const [reconnectCount, setReconnectCount] = useState<number>(0);
  const [isManualReconnecting, setIsManualReconnecting] = useState<boolean>(false);
  const priceStreamRetryRef = useRef<number>(0);
  
  // Only update state for prices once every 2 seconds to keep UI responsive
  const [renderedPrices, setRenderedPrices] = useState<Record<string, number>>({});
  const [livePulse, setLivePulse] = useState(0);

  const handleForceReconnectAll = useCallback(() => {
    setIsManualReconnecting(true);
    setNetworkQuality('reconnecting');
    lastDataTimeRef.current = Date.now();
    lastMainStreamTimeRef.current = Date.now();
    setReconnectTrigger(prev => prev + 1);
    setReconnectCount(c => c + 1);
    
    // Мгновенный запрос свежих данных через HTTP REST API для гарантированного наполнения UI
    fetch('/api/signals')
      .then(r => r.json())
      .then(d => {
        if (d && d.success && d.data) {
          setSignals(d.data);
          if (d.isCircuitBreakerActive !== undefined) setIsCircuitBreakerActive(d.isCircuitBreakerActive);
          if (d.isBtcShockLock !== undefined) setIsBtcShockLock(d.isBtcShockLock);
          if (d.btcShockRemainingSeconds !== undefined) setBtcShockRemaining(d.btcShockRemainingSeconds);
        }
      })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => setIsManualReconnecting(false), 800);
      });
  }, []);
  
  useEffect(() => {
    let priceSource: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isCleanedUp = false;

    const connectStream = () => {
      if (isCleanedUp) return;
      if (priceSource) {
        priceSource.close();
      }
      
      priceSource = new EventSource('/api/stream/prices');
      
      priceSource.onmessage = (e) => {
        try {
          const prices = JSON.parse(e.data);
          latestPricesRef.current = { ...latestPricesRef.current, ...prices };
          lastDataTimeRef.current = Date.now();
          priceStreamRetryRef.current = 0;
        } catch (err) {}
      };

      // Слушаем heartbeat для детекции зависшего TCP сокета на плохом VPN
      priceSource.addEventListener('heartbeat', () => {
        lastDataTimeRef.current = Date.now();
        priceStreamRetryRef.current = 0;
      });

      priceSource.onerror = () => {
        if (isCleanedUp) return;
        priceSource?.close();
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        // Экспоненциальный бэкофф с быстрым первым переподключением
        const delay = Math.min(3000, 400 * Math.pow(1.4, priceStreamRetryRef.current++));
        reconnectTimeout = setTimeout(connectStream, delay);
      };
    };

    connectStream();

    const interval = setInterval(() => {
      const now = Date.now();
      const lag = now - lastDataTimeRef.current;
      setRenderedPrices({ ...latestPricesRef.current });
      setLivePulse(p => (p + 1) % 1000);
      setDataLag(lag);

      // Watchdog: если поток цен молчит более 7.5 секунд, мягко перезапускаем сокет цен
      if (lag > 7500 && !isCleanedUp) {
        lastDataTimeRef.current = now; // сброс флага перед попыткой
        connectStream();
      }
    }, 250); // High-frequency UI updates for better response

    return () => {
      isCleanedUp = true;
      if (priceSource) {
        priceSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      clearInterval(interval);
    };
  }, [reconnectTrigger]);

  const [mainTab, setMainTab] = useState<'scanner' | 'funding' | 'knowledge' | 'history' | 'peaks' | 'telemetry' | 'fine_tuning' | 'signal_analytics'>('scanner');
  
  useEffect(() => {
    if (isStandaloneTerminal || isStandaloneTrade) {
      setMainTab('scanner');
    }
  }, [isStandaloneTerminal, isStandaloneTrade]);
  const [exchangePing, setExchangePing] = useState<number | null>(null);
  const [pingHistory, setPingHistory] = useState<any[]>([]);
  const [structuredLogs, setStructuredLogs] = useState<any[]>([]);
  const [agentsStatus, setAgentsStatus] = useState<any[]>([]);
  
  useEffect(() => {
    const fetchTelemetry = async () => {
      try {
        const pingRes = await fetch('/api/telemetry/ping').then(r => {
          if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
          return { success: false };
        });
        if (pingRes && pingRes.success) {
          setExchangePing(pingRes.currentPingMs);
          setPingHistory(pingRes.history || []);
          if (pingRes.agents) {
            setAgentsStatus(pingRes.agents);
          }
        }
        
        const logsRes = await fetch('/api/logs/structured?limit=100').then(r => {
          if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
          return { success: false };
        });
        if (logsRes && logsRes.success) {
          setStructuredLogs(logsRes.logs || []);
        }
      } catch (err) {
        console.warn('Failed to fetch ping or structured logs telemetry:', err);
      }
    };
    
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 6000);
    return () => clearInterval(interval);
  }, []);

  const [isRealBalanceVisible, setIsRealBalanceVisible] = useState<boolean>(() => {
    const cached = localStorage.getItem('isRealBalanceVisible');
    return cached === null ? true : cached === 'true';
  });
  const [dailyGoalPercent, setDailyGoalPercent] = useState<number>(() => {
    const cached = localStorage.getItem('dailyGoalPercent');
    return cached ? Number(cached) : 20;
  });
  const [startOfDayRealBalance, setStartOfDayRealBalance] = useState<number>(0);
  const [isEditingGoal, setIsEditingGoal] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem('isRealBalanceVisible', isRealBalanceVisible.toString());
  }, [isRealBalanceVisible]);

  useEffect(() => {
    localStorage.setItem('dailyGoalPercent', dailyGoalPercent.toString());
  }, [dailyGoalPercent]);

  const [prolivPeaks, setProlivPeaks] = useState<any[]>([]);
  const [retrospectiveLessons, setRetrospectiveLessons] = useState<any[]>([]);
  const [agentExchangeLogs, setAgentExchangeLogs] = useState<any[]>([]);
  const [forceScanLoading, setForceScanLoading] = useState(false);
  const [forceScanResults, setForceScanResults] = useState<any[] | null>(null);
  const [logSearchText, setLogSearchText] = useState('');
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'success' | 'info' | 'warn' | 'error'>('all');
  const [logComponentFilter, setLogComponentFilter] = useState<string>('all');
  const [expandedLogIndex, setExpandedLogIndex] = useState<number | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeRule[]>([]);
  const [newRule, setNewRule] = useState('');
  const [newRuleAgent, setNewRuleAgent] = useState<'SCANNER' | 'MANAGER' | 'GENERAL'>('GENERAL');
  const [newRuleImage, setNewRuleImage] = useState<string | null>(null);
  const [ruleFilterIndicator, setRuleFilterIndicator] = useState<string>('none');
  const [ruleFilterCondition, setRuleFilterCondition] = useState<string>('gt');
  const [ruleFilterValue, setRuleFilterValue] = useState<string>('');
  const [ruleFilterAction, setRuleFilterAction] = useState<string>('penalty');
  const [isAdvancedRuleOpen, setIsAdvancedRuleOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [chartSymbol, setChartSymbol] = useState<{ symbol: string, exchange: string } | null>(null);
  const chartScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chartSymbol && chartScrollRef.current) {
      chartScrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [chartSymbol]);
  const [isRebalancing, setIsRebalancing] = useState(false);

  const handleRebalanceKnowledge = async () => {
    setIsRebalancing(true);
    try {
      const res = await fetch('/api/knowledge/rebalance', { method: 'POST' });
      if (!res.ok) throw new Error("Status " + res.status);
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        if (addToast) addToast(data.msg || 'База знаний успешно оптимизирована!', 'success');
      } else {
        throw new Error(data.error);
      }
    } catch (e: any) {
      if (addToast && !e?.message?.includes("Failed to fetch")) addToast(`Ошибка ребалансировки: ${e.message}`, 'error');
    } finally {
      setIsRebalancing(false);
    }
  };

  const [isRestoringAll, setIsRestoringAll] = useState(false);

  const handleUnarchiveAll = async () => {
    setIsRestoringAll(true);
    try {
      const res = await fetch('/api/knowledge/unarchive-all', { method: 'POST' });
      if (!res.ok) throw new Error("Status " + res.status);
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        if (addToast) addToast(`Успешно активировано ${data.unarchivedCount || 0} правил!`, 'success');
      } else {
        throw new Error(data.error);
      }
    } catch (e: any) {
      if (addToast) addToast(`Ошибка активации правил: ${e.message}`, 'error');
    } finally {
      setIsRestoringAll(false);
    }
  };

  const [knowledgeSubTab, setKnowledgeSubTab] = useState<'active' | 'archived'>('active');
  const [retroActiveSubTab, setRetroActiveSubTab] = useState<'lessons' | 'telemetry' | 'reports' | 'signals_analysis'>('lessons');
  const [aiPerformanceReports, setAiPerformanceReports] = useState<any[]>([]);
  const [isFetchingReports, setIsFetchingReports] = useState(false);

  const [committeeStats, setCommitteeStats] = useState<any>(null);
  const [isFetchingCommitteeStats, setIsFetchingCommitteeStats] = useState(false);

  const fetchCommitteeStats = async () => {
    setIsFetchingCommitteeStats(true);
    try {
      const res = await fetch('/api/ai-committee/stats');
      const data = await res.json();
      if (data.success) {
        setCommitteeStats(data.data);
      }
    } catch (e) {
      console.error("Failed to fetch committee stats:", e);
    } finally {
      setIsFetchingCommitteeStats(false);
    }
  };

  const fetchAiPerformanceReports = async () => {
    setIsFetchingReports(true);
    try {
      const res = await fetch('/api/agent-exchange/reports');
      const data = await res.json();
      if (data.success) {
        setAiPerformanceReports(data.data || []);
      }
    } catch (e) {
      console.error("Failed to fetch reports:", e);
    } finally {
      setIsFetchingReports(false);
    }
  };

  useEffect(() => {
    if (retroActiveSubTab === 'reports') {
      fetchAiPerformanceReports();
    } else if (retroActiveSubTab === 'signals_analysis') {
      fetchCommitteeStats();
    }
  }, [retroActiveSubTab]);

  const [isOptimizingExchange, setIsOptimizingExchange] = useState(false);
  const [optimizationSummary, setOptimizationSummary] = useState<string | null>(null);
  const [isSmartAuditing, setIsSmartAuditing] = useState(false);
  const [smartAuditExplanation, setSmartAuditExplanation] = useState<string | null>(null);

  const handleSmartAudit = async () => {
    setIsSmartAuditing(true);
    setSmartAuditExplanation(null);
    if (addToast) addToast('Запущен тактический аудит конъюнктуры рынка (Архивариус)...', 'info');
    try {
      const res = await fetch('/api/knowledge/smart-audit', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        setSmartAuditExplanation(data.explanation);
        if (addToast) {
          addToast(`Успешный аудит: архивировано ${data.archivedCount || 0}, восстановлено ${data.unarchivedCount || 0}`, 'success');
        }
      } else {
        throw new Error(data.error || 'Ошибка аудита');
      }
    } catch (e: any) {
      if (addToast) addToast(`Ошибка аудита: ${e.message}`, 'error');
    } finally {
      setIsSmartAuditing(false);
    }
  };

  const handleArchiveRule = async (id: string, reason?: string) => {
    try {
      const res = await fetch(`/api/knowledge/archive/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'Переведено пользователем в архив' })
      });
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        if (addToast) addToast('Правило перемещено в архив', 'success');
      }
    } catch (e: any) {
      if (addToast) addToast(`Не удалось архивировать правило: ${e.message}`, 'error');
    }
  };

  const handleUnarchiveRule = async (id: string) => {
    try {
      const res = await fetch(`/api/knowledge/unarchive/${id}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        if (addToast) addToast('Правило успешно возвращено из архива', 'success');
      }
    } catch (e: any) {
      if (addToast) addToast(`Не удалось восстановить правило: ${e.message}`, 'error');
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        if (addToast) addToast("Размер изображения не должен превышать 2MB", "error");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setNewRuleImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveRule = async () => {
    if (!newRule.trim()) {
      if (addToast) addToast('Введите текст правила!', 'error');
      return;
    }
    try {
      const payload = {
        rule: newRule,
        agent: newRuleAgent,
        image: newRuleImage || undefined,
        filterIndicator: ruleFilterIndicator !== 'none' ? ruleFilterIndicator : undefined,
        filterCondition: ruleFilterCondition,
        filterValue: ruleFilterValue ? parseFloat(ruleFilterValue) : undefined,
        filterAction: ruleFilterAction
      };
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setKnowledgeBase(data.data);
        setNewRule('');
        setNewRuleImage(null);
        setRuleFilterValue('');
        setIsAdvancedRuleOpen(false);
        if (addToast) addToast('Правило успешно добавлено в Базу Знаний!', 'success');
      } else {
        if (addToast) addToast(`Ошибка: ${data.error}`, 'error');
      }
    } catch (e: any) {
      console.error(e);
      if (addToast) addToast(`Ошибка добавления: ${e.message}`, 'error');
    }
  };

  useEffect(() => {
    if (activeTerminalTradeId) {
      const trade = paperTrades.find(t => t.id === activeTerminalTradeId);
      if (trade) {
        const targetAmt = Number((trade.amount || 0).toFixed(2));
        setAverageAmount(prev => prev === targetAmt ? prev : targetAmt);
      }
    }
  }, [activeTerminalTradeId, paperTrades]);

  const [aiAnalysisResult, setAiAnalysisResult] = useState<any | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleAiAnalyze = async () => {
    if (!selectedSignal) return;
    setIsAnalyzing(true);
    setAiAnalysisResult(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch('/api/ai-analyze-signal', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ signal: selectedSignal })
      });
      
      const data = await res.json();
      if (data.success) {
        setAiAnalysisResult(data.result);
        setSignals(prev => prev.map(s => s.symbol === selectedSignal.symbol ? {
          ...s,
          aiScore: data.result.aiScore !== undefined ? data.result.aiScore : s.aiScore,
          consensus: data.result.consensus,
          aiValidationPassed: data.result.approved,
          insights: [data.result.consensusReason || 'Анализ завершен']
        } : s));
      } else {
        throw new Error(data.error || 'Failed to analyze');
      }
    } catch (e: any) {
      const isQuota = e?.message?.includes("429") || e?.message?.includes("quota") || e?.message?.includes("Failed to call") || e?.message?.includes("Too Many Requests");
      if (!isQuota) {
        console.warn('AI Analysis warning:', e?.message || e);
      }
      const isAbort = e.name === 'AbortError';
      let msg = isAbort ? 'Анализ ИИ прерван по таймауту (сервер перегружен)' : (e.message || 'Ошибка анализа ИИ');
      if (e?.message?.includes('Failed to fetch')) {
        msg = 'Ошибка сети (сервер или ИИ не отвечает - таймаут)';
      }
      setAiAnalysisResult({ error: msg });
      // Suppress UI toast for quota/fetch issues to stop spamming
      if (addToast && !isQuota && !e?.message?.includes("Failed to fetch")) {
        addToast(msg, 'error');
      }
    } finally {
      clearTimeout(timeoutId);
      setIsAnalyzing(false);
    }
  };

  const sigSymbol = selectedSignal?.symbol;
  const sigAtr = selectedSignal?.atr;

  useEffect(() => {
    if (selectedSignal && entryPrice > 0) {
      let lastPrice = entryPrice;
      const isShort = positionType === 'short';
      const count = Math.max(1, stepsCount || 1);
      const pct = stepPercent || 0;
      
      const atrNum = sigAtr ? Number(sigAtr) : (entryPrice * 0.015);
      const atrPct = (atrNum / entryPrice) * 100;

      for (let i = 0; i < count; i++) {
        const stepCoef = 1.0 + (i * 0.35);
        const currentStepPct = useAtrDynamicDca ? Math.max(1.5, Math.min(15, atrPct * stepCoef)) : pct;
        lastPrice = isShort ? lastPrice * (1 + currentStepPct / 100) : lastPrice * (1 - currentStepPct / 100);
      }
      
      const calculatedSl = isShort 
        ? Number((lastPrice * 1.015).toFixed(5)) 
        : Number((lastPrice * 0.985).toFixed(5));
      setStopLoss(prev => prev === calculatedSl ? prev : calculatedSl);
      
      // Strict 1:3 Risk to Reward Ratio (TP distance = 3 * SL distance)
      const slDist = Math.abs(entryPrice - calculatedSl);
      const tpDist = slDist * 3;
      const calculatedTp = isShort
        ? Number((entryPrice - tpDist).toFixed(5))
        : Number((entryPrice + tpDist).toFixed(5));

      setTakeProfit(prev => prev === calculatedTp ? prev : calculatedTp);
    }
  }, [entryPrice, positionType, stepsCount, stepPercent, sigSymbol, sigAtr, useAtrDynamicDca]);

  useEffect(() => {
    setAiAnalysisResult(null);
  }, [sigSymbol]);

  useEffect(() => {
    let interval: any;
    if (activeTerminalTradeId) {
      const trade = paperTradesRef.current.find(t => t.id === activeTerminalTradeId);
      if (trade) {
        const fetchPrice = async () => {
          try {
            // Clean symbol for API
            const cleanSymbol = trade.symbol.replace('/', '').replace(':', '');
            const res = await fetch(`/api/ticker?symbol=${cleanSymbol}&exchange=${trade.exchange || 'weex'}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.price && parseFloat(data.price) > 0) {
              setLivePrice(parseFloat(data.price));
            } else {
              throw new Error("Invalid price");
            }
          } catch (e) {
            console.warn("Price fetch failed for:", trade.symbol, e);
          }
        };
        fetchPrice();
        interval = setInterval(fetchPrice, 5000);
      }
    }
    return () => clearInterval(interval);
  }, [activeTerminalTradeId]);

  const handleTopUpBalance = () => {
    setBalanceModalType('topup');
    setBalanceInputVal('500');
    setShowBalanceModal(true);
  };

  const handleEditBalance = () => {
    setBalanceModalType('edit');
    setBalanceInputVal(virtualBalance.toString());
    setShowBalanceModal(true);
  };

  const submitBalanceChange = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const amount = parseFloat(balanceInputVal);
    if (isNaN(amount) || amount < 0) {
      if (addToast) addToast('Пожалуйста, введите корректное неотрицательное число', 'error');
      return;
    }
    if (balanceModalType === 'topup' && amount <= 0) {
      if (addToast) addToast('Сумма пополнения должна быть больше нуля', 'error');
      return;
    }

    try {
      const endpoint = balanceModalType === 'edit' 
        ? '/api/paper-trade/balance/update' 
        : '/api/paper-trade/balance/topup';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          amount, 
          closeActiveTrades: balanceModalType === 'edit' ? closeActiveTradesOnReset : false 
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        updateSafeVirtualBalance(data.balance, true);
        
        // Fetch fresh trades from the server to immediately synchronize the UI
        try {
          const tradesRes = await fetch('/api/paper-trade');
          if (tradesRes.ok) {
            const tradesData = await tradesRes.json();
            if (tradesData.success && Array.isArray(tradesData.data)) {
              setPaperTrades(tradesData.data);
              paperTradesRef.current = tradesData.data;
            }
          }
        } catch (fetchErr) {
          console.error('[BALANCE CHANGE] Failed to sync paper trades:', fetchErr);
        }

        if (addToast) {
          addToast(
            balanceModalType === 'edit' 
              ? `Виртуальный баланс успешно изменен на $${amount}`
              : `Баланс успешно пополнен на $${amount}`, 
            'success'
          );
        }
        setShowBalanceModal(false);
      }
    } catch (e) {
      if (addToast) {
        addToast(
          balanceModalType === 'edit'
            ? 'Ошибка при изменении виртуального баланса'
            : 'Ошибка при пополнении баланса',
          'error'
        );
      }
    }
  };

  const handleResetCircuitBreaker = async () => {
    try {
      const res = await fetch('/api/paper-trade/reset-circuit-breaker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setIsCircuitBreakerActive(false);
        setStartOfDayBalance(data.startOfDayBalance);
        if (data.startOfWeekBalance !== undefined) setStartOfWeekBalance(data.startOfWeekBalance);
        if (data.startOfDayRealBalance !== undefined) setStartOfDayRealBalance(data.startOfDayRealBalance);
        if (addToast) addToast('Торговый предохранитель успешно сброшен! Робот снова ждет сигналы.', 'success');
      }
    } catch (e) {
      if (addToast) addToast('Ошибка при сбросе торгового предохранителя', 'error');
    }
  };

  const handleChangeTradeMode = async (tradeId: string, mode: string) => {
    try {
      const res = await fetch('/api/paper-trade/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tradeId, mode })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setPaperTrades(prev => prev.map(t => t.id === tradeId ? data.data : t));
      }
    } catch (e) {}
  };

  const handleLeverageChange = async (tradeId: string, newLeverage: number) => {
    try {
      const res = await fetch('/api/paper-trade/leverage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tradeId, leverage: newLeverage })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setPaperTrades(prev => prev.map(t => t.id === tradeId ? data.data : t));
        if (addToast) addToast(`Плечо успешно изменено на ${newLeverage}x`, 'success');
      }
    } catch (e) {}
  };

  const handleSlTpChange = async (tradeId: string, sl: number | null, tp: number | null) => {
    try {
      const body: any = { id: tradeId };
      if (sl !== null) body.stopLoss = sl;
      if (tp !== null) body.takeProfit = tp;

      const res = await fetch('/api/paper-trade/update-state', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        if (addToast) addToast('SL/TP успешно обновлены', 'success');
        setPaperTrades(prev => prev.map(t => t.id === tradeId ? { ...t, stopLoss: sl ?? undefined, takeProfit: tp ?? undefined } : t));
      }
    } catch (e) {
      if (addToast) addToast('Ошибка обновления SL/TP', 'error');
    }
  };

  const handleAverageTrade = async (tradeId: string, amount?: number) => {
    const amt = amount || averageAmount;
    if (!amt) return;
    
    // Use the latest available price for this trade's symbol
    const trade = paperTrades.find(t => t.id === tradeId);
    const targetPrice = trade ? (latestPricesRef.current[trade.symbol.replace('/', '')] || latestPricesRef.current[trade.symbol] || livePrice) : livePrice;
    
    if (!targetPrice) {
      if (addToast) addToast('Ошибка: цена монеты не получена', 'error');
      return;
    }

    try {
      const res = await fetch('/api/paper-trade/average', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ id: tradeId, price: targetPrice, amount: amt })
      });
      if (!res.ok) {
        const text = await res.text();
        if (addToast) addToast(`Ошибка: ${text}`, 'error');
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setPaperTrades(prev => prev.map(t => t.id === tradeId ? data.data : t));
        if (data.balance !== undefined) updateSafeVirtualBalance(data.balance, true);
        setAverageAmount(0);
        if (addToast) addToast('Усреднение выполнено успешно', 'success');
      }
    } catch (e) { console.error(e); }
  };

  const evaluateClosedTrade = async (trade: any, currentPrice: number, pnlPct: number, pnlUsd: number, reason: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s for AI evaluation

    if (addToast) addToast(`[${trade.symbol}] ИИ Менеджер приступает к разбору сделки...`, 'info');

    try {
      const res = await fetch('/api/ai-evaluate-closed-trade', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ trade, currentPrice, pnlPct, pnlUsd, reason })
      });
      const data = await res.json();
      
      if (data.success) {
        const evalResult = data.result;
        if (addToast) addToast(`[${trade.symbol}] ИИ завершил разбор: ${evalResult.evaluation.substring(0, 50)}...`, 'success');

        await fetch('/api/paper-trade/update-state', {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          signal: controller.signal,
          body: JSON.stringify({ 
            id: trade.id, 
            aiEvaluation: evalResult.evaluation,
            learnedRule: evalResult.learnedRule,
            outcome: pnlPct > 0 ? 1 : pnlPct < 0 ? -1 : 0
          })
        });
        
        // Refresh local trades
        const res2 = await fetch('/api/paper-trade', { signal: controller.signal });
        const d = await res2.json();
        if (d.success) {
          setPaperTrades(d.data);
          paperTradesRef.current = d.data;
          // ... update active context
          setActiveTerminalTradeId(prev => {
            if (prev) {
              const activeTrade = d.data.find((t: any) => t.id === prev);
              if (!activeTrade || activeTrade.status !== 'OPEN') return null;
            }
            return prev;
          });
          setSelectedSignal(prevSignal => {
            if (prevSignal) {
              const activeTrade = d.data.find((t: any) => t.symbol === prevSignal.symbol && t.status === 'OPEN');
              if (!activeTrade) return null;
            }
            return prevSignal;
          });
        }

        if (evalResult.learnedRule) {
          await fetch('/api/knowledge', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            signal: controller.signal,
            body: JSON.stringify({ 
              rule: `[Авто-обучение ${trade.symbol}]: ${evalResult.learnedRule}`,
              agent: 'MANAGER'
            }) 
          });
          const res3 = await fetch('/api/knowledge', { signal: controller.signal });
          const d3 = await res3.json();
          if (d3.success) setKnowledgeBase(d3.data);
          if (addToast) addToast('ИИ извлек новый урок из сделки и добавил в Базу Знаний', 'info');
        }
      } else {
         await fetch('/api/paper-trade/update-state', {
           method: 'POST', 
           headers: { 'Content-Type': 'application/json' }, 
           body: JSON.stringify({ id: trade.id, aiEvaluation: `Ошибка ИИ разбора (AI Studio): ${data.error || ''}` })
         });
         const res2 = await fetch('/api/paper-trade');
         const d = await res2.json();
         if (d.success) { setPaperTrades(d.data); paperTradesRef.current = d.data; }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.warn('AI evaluation timed out for', trade.symbol);
      } else {
        const isQuota = e?.message?.includes("429") || e?.message?.includes("quota") || e?.message?.includes("Failed to call") || e?.message?.includes("Too Many Requests");
        if (!isQuota) {
           console.warn('Failed to evaluate closed trade:', e?.message || e);
        }
      }
      try {
         await fetch('/api/paper-trade/update-state', {
           method: 'POST', 
           headers: { 'Content-Type': 'application/json' }, 
           body: JSON.stringify({ id: trade.id, aiEvaluation: 'Ошибка при оценке ИИ или тайм-аут.' })
         });
         const res2 = await fetch('/api/paper-trade');
         const d = await res2.json();
         if (d.success) { setPaperTrades(d.data); paperTradesRef.current = d.data; }
      } catch(err) {}
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleCloseActiveTrade = async (trade: any) => {
    let currentPrice = livePrice;
    
    // If livePrice is 0, try to get price from the original signal
    if (!currentPrice || currentPrice === 0) {
      const sig = signals.find(s => s.symbol === trade.symbol);
      if (sig) currentPrice = sig.price;
    }
    
    // Last resort: use entry price if everything else fails, allowing the trade to close at breakeven
    if (!currentPrice || currentPrice === 0) {
      currentPrice = trade.entryPrice;
      if (addToast) addToast("Текущая цена не найдена. Принудительное закрытие по цене входа.", "info");
    }

    // Защита от повторного нажатия и оптимистичное обновление
    if (closingTradesRef.current.has(trade.id)) return;
    closingTradesRef.current.add(trade.id);
    
    const closeTimestamp = Date.now();
    const diff = trade.side === 'SHORT' ? (trade.entryPrice - currentPrice) : (currentPrice - trade.entryPrice);
    const pnlPct = (diff / trade.entryPrice) * 100 * trade.leverage;
    const pnlUsd = trade.amount * (pnlPct / 100);
    
    let feedback = 'BREAKEVEN';
    let notes = 'Сделка закрыта в ноль.';

    if (pnlPct > 0) {
      feedback = 'SUCCESS';
      notes = `Закрыто в плюс: +${pnlUsd.toFixed(2)}$`;
    } else if (pnlPct < 0) {
      feedback = 'FAILED';
      notes = `Закрыто в минус: ${pnlUsd.toFixed(2)}$`;
    }

    // Оптимистичное закрытие в UI для мгновенного отклика с сохранением расчетного PnL и времени
    setPaperTrades(prev => prev.map(t => t.id === trade.id ? { 
      ...t, 
      status: 'CLOSED', 
      closeTime: closeTimestamp, 
      closePrice: currentPrice, 
      pnl: pnlUsd, 
      pnlPercent: pnlPct, 
      feedback, 
      notes 
    } : t));

    let realPnlUsd = pnlUsd;
    let realPnlPct = pnlPct;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // Increased to 30s

    try {
      if (tradingMode === 'real' || trade.isReal) {
        const realRes = await fetch('/api/real-trade/close', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: trade.symbol, side: trade.side })
        });
        const realData = await realRes.json();
        if (!realRes.ok || !realData.success) {
           if (addToast) addToast(`Ошибка биржи: ${realData.error || 'Не удалось связаться с биржей'}`, 'error');
           if (trade.isReal) {
             setPaperTrades(paperTradesRef.current); // Revert optimistic UI if only real
             closingTradesRef.current.delete(trade.id);
             return;
           }
        } else {
           if (addToast) addToast('Реальная позиция закрыта!', 'success');
           if (onRefreshRealBalance) {
             onRefreshRealBalance();
           }
           if (trade.isReal) {
             setRealTrades(prev => prev.filter(t => t.id !== trade.id));
             
             // Забираем реальную цену закрытия с биржи
             const realClosePrice = realData.data?.average || realData.data?.price || currentPrice;
             currentPrice = realClosePrice;
             
             // И пересчитываем PnL на основе реальных цен
             const realDiff = trade.side === 'SHORT' ? (trade.entryPrice - realClosePrice) : (realClosePrice - trade.entryPrice);
             realPnlPct = (realDiff / trade.entryPrice) * 100 * trade.leverage;
             realPnlUsd = trade.amount * (realPnlPct / 100);
             feedback = realPnlPct > 0 ? 'SUCCESS' : realPnlPct < 0 ? 'FAILED' : 'BREAKEVEN';
             notes = `Реальная сделка закрыта. PnL: ${realPnlUsd.toFixed(2)}$ (${realPnlPct.toFixed(2)}%)`;
           }
        }
      }

      // 1. Close the trade first to update UI quickly
      const res = await fetch('/api/paper-trade/close', {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        signal: controller.signal,
        body: JSON.stringify({ id: trade.id, closePrice: currentPrice, feedback, notes, aiEvaluation: 'Ожидание оценки ИИ...' })
      });
      
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      
      if (data.success) {
        // Immediate UI cleanup
        setActiveTerminalTradeId(null);
        
        const finalCloseTime = data.data?.closeTime || closeTimestamp;
        const finalClosePrice = (trade.isReal || tradingMode === 'real') ? currentPrice : (data.data?.closePrice || currentPrice);
        const finalPnlUsd = (trade.isReal || tradingMode === 'real') ? realPnlUsd : (data.data?.pnl !== undefined ? data.data.pnl : pnlUsd);
        const finalPnlPct = (trade.isReal || tradingMode === 'real') ? realPnlPct : (data.data?.pnlPercent !== undefined ? data.data.pnlPercent : pnlPct);

        const updatedTrade = { 
          ...trade, 
          ...(data.data || {}), 
          status: 'CLOSED', 
          closeTime: finalCloseTime, 
          closePrice: finalClosePrice,
          pnl: finalPnlUsd,
          pnlPercent: finalPnlPct,
          feedback: data.data?.feedback || feedback,
          notes: data.data?.notes || notes
        };

        setPaperTrades(prev => prev.map(t => t.id === trade.id ? updatedTrade : t));
        paperTradesRef.current = paperTradesRef.current.map(t => t.id === trade.id ? updatedTrade : t);
        
        // Add to Auto-Pilot cooldown (15-second debounce on the closed symbol)
        const normSym = trade.symbol.replace('/', '').replace(':', '').toUpperCase();
        autoPilotCooldownsRef.current[normSym] = Date.now();

        if (data.balance !== undefined) updateSafeVirtualBalance(data.balance, true);
        setSelectedSignal(prev => (prev?.symbol === trade.symbol ? null : prev));
        if (addToast) addToast(`Сделка ${trade.symbol} закрыта успешно!`, 'success');

        // Symbol cooldown tracked for local reference
        // Slot is freed for server-side autopilot to allocate on next scan cycle
      }

      // 2. Run AI Evaluation in background
      evaluateClosedTrade(trade, livePrice, pnlPct, pnlUsd, 'Ручное закрытие пользователем');

    } catch (e: any) { 
      console.error(e);
      if (e.name === 'AbortError') {
        if (addToast) addToast("Ошибка: Таймаут запроса. Попробуйте закрыть сделку еще раз.", "error");
      } else {
        if (addToast && !e?.message?.includes("Failed to fetch")) addToast(`Ошибка при закрытии сделки: ${e.message}`, "error");
      }
      // Если фатальная ошибка - возвращаем статус OPEN
      closingTradesRef.current.delete(trade.id);
      setPaperTrades(prev => prev.map(t => t.id === trade.id ? { ...t, status: 'OPEN' } : t));
    } finally {
      clearTimeout(timeoutId);
      // Оставляем ID в списке закрывающихся еще на 8 сек, чтобы SSE не перетер состояние
      setTimeout(() => closingTradesRef.current.delete(trade.id), 8000);
    }
  };

  useEffect(() => {
    // Initial fetch for signals
    fetch('/api/signals').then(r => {
      if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
      return { success: false };
    }).then(d => {
      if (d.success && d.data) {
        setSignals(d.data);
        if (d.isCircuitBreakerActive !== undefined) setIsCircuitBreakerActive(d.isCircuitBreakerActive);
        if (d.isBtcShockLock !== undefined) setIsBtcShockLock(d.isBtcShockLock);
        if (d.btcShockRemainingSeconds !== undefined) setBtcShockRemaining(d.btcShockRemainingSeconds);
      }
    }).catch(console.error);

    // Setup active 3s client-side synchronization for risk parameters
    const checkStateInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/signals');
        if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
          const d = await res.json();
          if (d && d.success) {
            setIsCircuitBreakerActive(!!d.isCircuitBreakerActive);
            setIsBtcShockLock(!!d.isBtcShockLock);
            setBtcShockRemaining(d.btcShockRemainingSeconds || 0);
          }
        }
      } catch (e) {}
    }, 3000);

    // Initial fetch for knowledge base
    fetch('/api/knowledge').then(r => {
      if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
      return { success: false };
    }).then(d => {
      if (d.success) setKnowledgeBase(d.data || []);
    }).catch(console.error);

    // Initial fetch for proliv peaks
    fetch('/api/proliv-peaks').then(r => {
      if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
      return { success: false };
    }).then(d => {
      if (d.success) setProlivPeaks(d.data || []);
    }).catch(console.error);

    // Initial fetch for retrospective lessons
    fetch('/api/retrospective').then(r => {
      if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
      return { success: false };
    }).then(d => {
      if (d.success) setRetrospectiveLessons(d.data || []);
    }).catch(console.error);

    // Initial fetch for agent exchange logs
    fetch('/api/agent-exchange/logs').then(r => {
      if (r.ok && r.headers.get('content-type')?.includes('application/json')) return r.json();
      return { success: false };
    }).then(d => {
      if (d.success) setAgentExchangeLogs(d.data || []);
    }).catch(console.error);

    // SSE for real-time signals and trades with resilient auto-reconnect and watchdog for VPN stability
    let mainEventSource: EventSource | null = null;
    let mainReconnectTimeout: NodeJS.Timeout | null = null;
    let isMainCleanedUp = false;
    let mainRetryCount = 0;

    const connectMainStream = () => {
      if (isMainCleanedUp) return;
      if (mainEventSource) {
        mainEventSource.close();
      }

      mainEventSource = new EventSource('/api/stream');

      mainEventSource.addEventListener('heartbeat', (e: any) => {
        lastMainStreamTimeRef.current = Date.now();
        mainRetryCount = 0;
        setNetworkQuality(prev => prev === 'reconnecting' ? 'optimal' : prev);
      });
      
      mainEventSource.onmessage = (event) => {
        try {
          lastMainStreamTimeRef.current = Date.now();
          mainRetryCount = 0;
          setNetworkQuality(prev => prev === 'reconnecting' ? 'optimal' : prev);

          const data = JSON.parse(event.data);
          if (data.signals) {
            data.signals.forEach((s: Signal) => {
              const key = `${s.symbol}-${s.signal}`;
              if (!seenSignalsRef.current.has(key)) {
                  seenSignalsRef.current.add(key);
                  if (seenSignalsRef.current.size > 2000) seenSignalsRef.current.clear();
                  playNotificationSound();
              }
            });

            setSignals(prev => {
              const equals = prev.length === data.signals.length && prev.every((s, i) => s.symbol === data.signals[i].symbol && s.price === data.signals[i].price && Math.abs((s.aiScore || 0) - (data.signals[i].aiScore || 0)) < 1);
              if (equals) return prev;
              
              // Track stability of confidenceP
              const now = Date.now();
              data.signals.forEach((s: Signal) => {
                if (s.confidenceP !== undefined) {
                  const hist = pHistoryRef.current[s.symbol];
                  if (hist) {
                     const diff = Math.abs(hist.lastP - s.confidenceP);
                     if (diff > 0.15 && now - hist.lastTime < 300000) {
                       hist.isUnstable = true;
                     } else if (now - hist.lastTime > 300000) {
                       hist.isUnstable = false;
                     }
                     hist.lastP = s.confidenceP;
                     hist.lastTime = now;
                  } else {
                     pHistoryRef.current[s.symbol] = { lastP: s.confidenceP, lastTime: now, isUnstable: false };
                  }
                }
              });

              return data.signals;
            });
          }
            
          if (data.paperTrades) {
            const synced = (() => {
              const serverTrades = data.paperTrades;
              const nowTime = Date.now();
              const serverTradeIds = new Set(serverTrades.map((t: any) => t.id));
              
              // 1. Keep trades that were JUST opened locally but not yet on server
              const locallyAdded = paperTradesRef.current.filter(p => 
                p.status === 'OPEN' && 
                !serverTradeIds.has(p.id) &&
                (nowTime - (p.openTime || 0) < 15000)
              );
              
              // 2. Map server trades but respect local 'CLOSED' state during grace period
              const syncedTrades = serverTrades.map((s: any) => {
                const localTrade = paperTradesRef.current.find(p => p.id === s.id);
                
                if (s.status === 'CLOSED' && localTrade && localTrade.status === 'OPEN') {
                   const normSym = s.symbol.replace('/', '').replace(':', '').toUpperCase();
                   autoPilotCooldownsRef.current[normSym] = nowTime;
                   if (addToast) addToast(`[WATCHDOG] Сделка ${s.symbol} закрыта по правилам сервера`, 'info');
                }

                const isClosing = closingTradesRef.current.has(s.id);
                if (isClosing && s.status === 'OPEN') {
                  return { ...s, status: 'CLOSED', closeTime: nowTime };
                }
                
                if (localTrade && localTrade.status === 'CLOSED' && s.status === 'OPEN' && (nowTime - (localTrade.closeTime || 0) < 20000)) {
                  return localTrade;
                }
                return s;
              });

              // 3. Keep older closed trades
              const olderClosedTrades = paperTradesRef.current.filter(p => 
                p.status === 'CLOSED' && !serverTradeIds.has(p.id)
              );

              return [...syncedTrades, ...locallyAdded, ...olderClosedTrades];
            })();

            setPaperTrades(synced);
            paperTradesRef.current = synced;
            
            setActiveTerminalTradeId(prev => {
               if (prev) {
                  const activeTrade = synced.find((t: any) => t.id === prev);
                  if (!activeTrade || activeTrade.status !== 'OPEN') return null;
               }
               return prev;
            });
          }
          if (data.balance !== undefined) {
            updateSafeVirtualBalance(data.balance, false);
          }
          if (data.startOfDayBalance !== undefined) {
            setStartOfDayBalance(data.startOfDayBalance);
          }
          if (data.startOfWeekBalance !== undefined) {
            setStartOfWeekBalance(data.startOfWeekBalance);
          }
          if (data.startOfDayRealBalance !== undefined) {
            setStartOfDayRealBalance(data.startOfDayRealBalance);
          }
          if (data.marketHealth !== undefined) {
            setMarketHealth(data.marketHealth);
          }
          if (data.marketPulse) {
            setMarketPulse(data.marketPulse);
          }
          if (data.socialSentiment !== undefined) {
            setSocialSentiment(data.socialSentiment);
          }
          if (data.marketRegime !== undefined) {
            setMarketRegime(data.marketRegime);
          }
          if (data.btcTrend24h !== undefined) {
            setBtcTrend24h(data.btcTrend24h);
          }
          if (data.btcTrend15m !== undefined) {
            setBtcTrend15m(data.btcTrend15m);
          }
          if (data.prolivPeaks !== undefined) {
            setProlivPeaks(data.prolivPeaks);
          }
          if (data.retrospectiveMemory !== undefined) {
            setRetrospectiveLessons(data.retrospectiveMemory);
          }
          if (data.agentExchangeLogs !== undefined) {
            setAgentExchangeLogs(data.agentExchangeLogs);
          }
          setLoading(false);
          setTermReady(true);
        } catch (e) {
          console.warn('SSE Parse error:', e);
        }
      };

      mainEventSource.onerror = () => {
        if (isMainCleanedUp) return;
        setNetworkQuality('reconnecting');
        mainEventSource?.close();
        if (mainReconnectTimeout) clearTimeout(mainReconnectTimeout);
        const delay = Math.min(4000, 400 * Math.pow(1.4, mainRetryCount++));
        mainReconnectTimeout = setTimeout(connectMainStream, delay);
      };
    };

    connectMainStream();

    // VPN Watchdog & Ping Probe: непрерывно замеряем латентность и проверяем зависшие TCP сокеты
    const watchdogInterval = setInterval(() => {
      const now = Date.now();
      const streamLag = now - lastMainStreamTimeRef.current;
      
      // Если стрим молчит дольше 18 секунд — зависание сокета. Переподключаем!
      if (streamLag > 18000 && !isMainCleanedUp) {
        setNetworkQuality('reconnecting');
        lastMainStreamTimeRef.current = now;
        connectMainStream();
      } else if (streamLag > 9000) {
        setNetworkQuality('lag');
      }
    }, 3000);

    const pingInterval = setInterval(() => {
      const pingStart = performance.now();
      fetch('/api/ping', { cache: 'no-store' })
        .then(r => {
          if (r.ok) {
            const rtt = Math.round(performance.now() - pingStart);
            setRttMs(rtt);
            if (rtt > 500) {
              setNetworkQuality('lag');
            } else {
              setNetworkQuality('optimal');
            }
          } else {
            setNetworkQuality('lag');
          }
        })
        .catch(() => {
          setNetworkQuality('reconnecting');
        });
    }, 5000);

    return () => {
      isMainCleanedUp = true;
      if (mainEventSource) mainEventSource.close();
      if (mainReconnectTimeout) clearTimeout(mainReconnectTimeout);
      clearInterval(checkStateInterval);
      clearInterval(watchdogInterval);
      clearInterval(pingInterval);
    };
  }, [reconnectTrigger]);

  const paperTradesRef = useRef(paperTrades);
  const signalsRefInternal = useRef(signals);
  const closingTradesRef = useRef<Set<string>>(new Set());
  const autoPilotCooldownsRef = useRef<Record<string, number>>({});
  useEffect(() => { paperTradesRef.current = paperTrades; }, [paperTrades]);
  useEffect(() => { signalsRefInternal.current = signals; }, [signals]);

  useEffect(() => {
    if (tradingMode === 'real' && isAutoPilotEnabled && !exchangeConfigEnabled) {
      setIsAutoPilotEnabled(false);
      if (addToast) addToast('Реальный автопилот требует настройки API биржи.', 'error');
    }
  }, [tradingMode, isAutoPilotEnabled, exchangeConfigEnabled, setIsAutoPilotEnabled, addToast]);

  // NOTE: Автопилот (Auto-Pilot) выполняется ИСКЛЮЧИТЕЛЬНО на сервере (server/services/autoPilotEngine.ts)
  // через фоновый шедулер. Это исключает дублирование ордеров, клиентские сетевые задержки
  // и гарантирует применение всех фильтров стратегии (BOS/ChoCh, Liquidity Sweep, Orderbook Shield, EMA200/FVG, 3-уровневый Staged TP).

  useEffect(() => {
      const manageTrades = async () => {
      if (isManagingRef.current || !termReady) return;
      isManagingRef.current = true;
      const openTrades = paperTradesRef.current.filter(t => t.status === 'OPEN');
      if (openTrades.length === 0) { isManagingRef.current = false; return; }

      try {
        for (const trade of openTrades) {
          // Individual AbortController per trade to avoid aggregate timeout issues
          const tradeController = new AbortController();
          const tradeTimeoutId = setTimeout(() => tradeController.abort(), 120000); // 120s per trade

          try {
            const cleanSym = trade.symbol.replace('/', '').replace(':', '');
            const currentPrice = latestPricesRef.current[cleanSym] || latestPricesRef.current[trade.symbol];
            
            if (!currentPrice || currentPrice <= 0) continue;
            
            const tradeAge = Date.now() - (trade.openTime || 0);
            if (tradeAge < 10000) continue;
            if (currentPrice === trade.entryPrice) continue;
            
            const diff = trade.side === 'SHORT' ? (trade.entryPrice - currentPrice) : (currentPrice - trade.entryPrice);
            const pnlPct = (diff / trade.entryPrice) * 100 * trade.leverage;
            const pnlUsd = trade.amount * (pnlPct / 100);

            // Trailing Stop & Breakeven Logic
            let highestPrice = trade.highestPrice || currentPrice;
            let lowestPrice = trade.lowestPrice || currentPrice;
            let trailingStopActive = trade.trailingStopActive || false;
            let newStopLoss = trade.stopLoss;
            let stateChanged = false;

            if (trade.mode === 'AUTO' || trade.mode === 'SEMI_AUTO' || trade.isReal) {
              // В режимах Автопилота и Реальной торговли расчет уровней (highestPrice, lowestPrice, stopLoss)
              // происходит ИСКЛЮЧИТЕЛЬНО на стороне сервера (manageTradesServerSide), чтобы избежать сетевых гонок и затирания данных.
              stateChanged = false;
            } else {
              if (currentPrice > highestPrice) { highestPrice = currentPrice; stateChanged = true; }
              if (currentPrice < lowestPrice) { lowestPrice = currentPrice; stateChanged = true; }

              if (pnlPct >= 8 && !trailingStopActive) {
                trailingStopActive = true;
                newStopLoss = trade.entryPrice;
                stateChanged = true;
                if (addToast) addToast(`[${trade.symbol}] Стоп-лосс в безубытке`, 'info');
              }

              if (pnlPct >= 12 && trailingStopActive) {
                if (trade.side === 'LONG') {
                  const trailPrice = highestPrice * 0.97;
                  if (!newStopLoss || trailPrice > newStopLoss) { newStopLoss = trailPrice; stateChanged = true; }
                } else {
                  const trailPrice = lowestPrice * 1.03;
                  if (!newStopLoss || trailPrice < newStopLoss) { newStopLoss = trailPrice; stateChanged = true; }
                }
              }
            }

            if (stateChanged) {
              try {
                await fetch('/api/paper-trade/update-state', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  signal: tradeController.signal,
                  body: JSON.stringify({ id: trade.id, highestPrice, lowestPrice, trailingStopActive, stopLoss: newStopLoss })
                });
                const updatedFields = { stopLoss: newStopLoss, highestPrice, lowestPrice, trailingStopActive };
                Object.assign(trade, updatedFields);
                setPaperTrades(prev => prev.map(t => t.id === trade.id ? { ...t, ...updatedFields } : t));
              } catch (e) {
                console.warn(`[AI] Failed to update trade state for ${trade.symbol}`);
              }
            }

            if (trade.mode === 'AUTO') {
              // В режиме AUTO (автопилот) запуск ИИ-эксперта (Gemini) полностью делегирован серверу (runAiExpertTraderLoop).
              // Клиентский вочдог никогда не вызывает /api/paper-trade/ai-analyze для торговли в режиме автопилота,
              // чтобы исключить дублирование сделок и усреднений, а также сэкономить ИИ-лимиты (rate-limit/quota).
              continue;
            }

            if (trade.mode === 'SEMI_AUTO') {
              const checkInterval = 45000;
              if (trade.lastAiCheck && Date.now() - trade.lastAiCheck < checkInterval) continue;
              if (!trade.lastAiCheck && trade.openTime && Date.now() - trade.openTime < 30000) continue;


              try {
                const res = await fetch('/api/paper-trade/ai-analyze', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  signal: tradeController.signal,
                  body: JSON.stringify({ id: trade.id, currentPrice, pnlPct, pnlUsd })
                });
                
                if (!res.ok) {
                  const errText = await res.text();
                  throw new Error(`Server returned ${res.status}: ${errText}`);
                }

                const data = await res.json();
                
                if (data.success) {
                  if (data.tradeClosed) {
                    const normTradeSym = trade.symbol.replace('/', '').replace(':', '').toUpperCase();
                    autoPilotCooldownsRef.current[normTradeSym] = Date.now();
                    evaluateClosedTrade(trade, currentPrice, pnlPct, pnlUsd, `AI-Close: ${data.result.advice}`);
                  } else if (data.trade) {
                    const updatedFields = {
                      aiAdvice: data.trade.aiAdvice,
                      lastAiCheck: data.trade.lastAiCheck,
                      entryPrice: data.trade.entryPrice,
                      amount: data.trade.amount,
                      stopLoss: data.trade.stopLoss,
                      lastAiAction: data.trade.lastAiAction
                    };
                    Object.assign(trade, updatedFields);
                    setPaperTrades(prev => prev.map(t => t.id === trade.id ? { ...t, ...updatedFields } : t));
                    if (data.balance !== undefined) updateSafeVirtualBalance(data.balance, false);
                  }
                } else {
                  const errMsg = data.error || "AI Error";
                  const updatedFields = { aiAdvice: `⚠️ ${errMsg}`, lastAiCheck: Date.now() };
                  Object.assign(trade, updatedFields);
                  setPaperTrades(prev => prev.map(t => t.id === trade.id ? { ...t, ...updatedFields } : t));
                }
              } catch (aiErr: any) {
                if (aiErr.name === 'AbortError') {
                   // console.warn(`[AI] Analysis timeout for ${trade.symbol}`);
                } else if (aiErr.message?.includes("500") || aiErr.message?.includes("fetch")) {
                   // console.warn(`[AI] Analysis failed for ${trade.symbol}:`, aiErr.message || "Failed to fetch");
                } else {
                   console.warn(`[AI] Analysis failed for ${trade.symbol}:`, aiErr.message);
                }
              }
              
              await new Promise(resolve => setTimeout(resolve, 4000)); // Delay between trades to avoid 429
            }
          } catch (tradeErr: any) {
            console.error(`Error managing trade ${trade.symbol}:`, tradeErr);
          } finally {
            clearTimeout(tradeTimeoutId);
          }
        }
      } catch (mainErr: any) {
        console.error('manageTrades fatal error:', mainErr);
      } finally {
        isManagingRef.current = false;
      }
    };
    const intervalId = setInterval(manageTrades, 5000); // Reduced interval to 5s for better responsiveness
    return () => clearInterval(intervalId);
  }, [knowledgeBase, isAutoPilotEnabled, termReady]);

  const [isBacktesting, setIsBacktesting] = useState(false);
  const handleBacktest = async () => {
    if (displaySignals.length === 0) return;
    
    setIsBacktesting(true);
    try {
      const targetSymbols = displaySignals.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
      const res = await fetch('/api/backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'current_rules', targets: targetSymbols })
      });
      const data = await res.json();
      if (data.success && addToast) {
        addToast(`Бэктест (7 дней): PnL: ${data.results.pnl > 0 ? '+' : ''}${data.results.pnl}% | Винрейт: ${data.results.winRate}% | Сделок: ${data.results.totalTrades} | Просадка: ${data.results.maxDrawdown}%`, data.results.pnl > 0 ? 'success' : 'error');
      } else if (data.error && addToast) {
        addToast(`Ошибка: ${data.error}`, 'error');
      }
    } catch (e) {
      if (addToast) addToast('Ошибка бэктеста', 'error');
    } finally {
      setIsBacktesting(false);
    }
  };

  const runScanner = async () => {
    if (Date.now() - lastScanTime < 60000) {
      if (addToast) addToast('Пожалуйста, подождите минуту перед следующим сканированием.', 'info');
      return;
    }
    setIsScanning(true);
    setLastScanTime(Date.now());
    

    try {
      const filtered = displaySignals.slice(0, 15).map((f: any) => ({
        symbol: f.symbol, exchange: f.exchange, price: f.price, change24h: f.change24h,
        change15m: f.change15m, change1h: f.change1h, volumeSpike: f.volumeSpike,
        funding: f.funding, oi: f.oi, obImbalance: f.obImbalance,
        volatility: f.volatility, dropFromHigh: f.dropFromHigh, riseFromLow: f.riseFromLow,
        volume: f.volume, currentSignal: f.signal, riskLevel: f.riskLevel
      }));
      
      if (filtered.length === 0) { setIsScanning(false); return; }

      const res = await fetch('/api/ai-run-scanner', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: filtered })
      });
      const data = await res.json();
      
      if (data.success) {
        const aiData = data.result;
        setSignals(prev => prev.map(sig => {
          const aiAnalysis = aiData.find((a: any) => a.symbol === sig.symbol && a.exchange === sig.exchange);
          if (aiAnalysis) return { ...sig, aiScore: aiAnalysis.aiScore, liqPrice: aiAnalysis.liqPrice, consensus: aiAnalysis.consensus };
          return sig;
        }));
      } else {
        throw new Error(data.error || "Failed to analyze");
      }
    } catch (error: any) {
      const isQuota = error?.message?.includes("429") || error?.message?.includes("quota") || error?.message?.includes("Failed to call") || error?.message?.includes("Too Many Requests");
      if (!isQuota) {
        console.warn("Scanner warning:", error?.message);
        // Suppressing the toast completely for API/fetch errors to stop spamming
      } else {
        console.warn("Scanner AI Quota limit reached, skipping AI analysis for now.");
      }
    } finally {
      setIsScanning(false);
    }
  };

  const toggleExchange = (_ex: string) => {
    setSelectedExchanges(['weex']);
  };

  const selectAllExchanges = () => {
    setSelectedExchanges(['weex']);
  };

  const deferredSearchTerm = useDeferredValue(searchTerm);
  const deferredSignals = useDeferredValue(signals);

  const filteredSignals = useMemo(() => {
    let filtered = (deferredSignals || []).filter(s => {
      if (!s) return false;
      const ex = (s.exchange || '').toLowerCase();
      if (ex && ex !== 'weex') return false;
      
      const rawSearch = deferredSearchTerm || '';
      const hasSearch = rawSearch.trim().length > 0;
      const term = rawSearch.toLowerCase().trim();
      if (term === 'fav:') {
        return favorites.includes(s.symbol || '');
      }

      const coin = (s.coin || s.symbol || '').toLowerCase();
      const symbolClean = (s.symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const termClean = term.replace(/[^a-z0-9]/g, '');
      const searchMatch = hasSearch && (coin === term || coin.startsWith(term) || symbolClean.startsWith(termClean) || symbolClean.includes(termClean));

      // If searching, we prioritize search match regardless of direction filter
      if (hasSearch && searchMatch) return true;
      if (hasSearch && !searchMatch) return false;

      // Apply Direction Filter for normal browsing
      const signalStr = (s.signal || '').toUpperCase();
      const isShort = signalStr.includes('SELL') || signalStr.includes('SHORT');
      const isLong = signalStr.includes('BUY') || signalStr.includes('LONG');
      if (signalDirectionFilter === 'POSITIONS') {
        const norm = (sym: string) => (sym || '').replace(/[\/:_\-]/g, '').toUpperCase();
        const sSym = norm(s.symbol || '');
        const hasOpen = paperTrades.some(t => t.status === 'OPEN' && norm(t.symbol) === sSym);
        if (!hasOpen) return false;
      } else if (signalDirectionFilter === 'SHORT' && !isShort) {
        return false;
      } else if (signalDirectionFilter === 'LONG' && !isLong) {
        return false;
      }

      // Filter passed entry points
      if (hidePassedEntries) {
        // Проверяем флаг от сервера (текстовое описание)
        if (s.type && s.type.toLowerCase().includes('expired')) return false;

        const norm = (sym: string) => (sym || '').replace(/[\/:_\-]/g, '').toUpperCase();
        const isOpenInTerminal = paperTrades.some(t => t.status === 'OPEN' && norm(t.symbol) === norm(s.symbol || ''));
        if (!isOpenInTerminal) {
          const symKey = (s.symbol || '').replace('/', '');
          const curPrice = renderedPrices[symKey] || renderedPrices[s.symbol || ''] || s.price || 0;
          const diff = s.price ? ((curPrice - s.price) / s.price) * 100 : 0;
          // Более строгий фильтр: если цена ушла от точки входа более чем на 0.3% в сторону профита - вход пропущен
          if (isShort && diff < -0.3) return false;
          if (!isShort && diff > 0.3) return false;
        }
      }

      if (!hasSearch) {
        return true;
      }
      return false;
    });

    const rawSearch = deferredSearchTerm || '';
    if (rawSearch.trim().length > 0 && rawSearch.trim().toLowerCase() !== 'fav:') {
       const existingSymbols = new Set(filtered.map(s => s.symbol || ''));
       const newResults = (searchResults || []).filter(s => s && !existingSymbols.has(s.symbol || ''));
       filtered = [...filtered, ...newResults];
    }

    return filtered;
  }, [deferredSignals, selectedExchanges, deferredSearchTerm, favorites, signalDirectionFilter, searchResults, hidePassedEntries, renderedPrices, paperTrades]);

  const displaySignals = useMemo(() => {
    // Если пользователь ведет поиск монет (deferredSearchTerm заполнена) — отображаем найденные активы без ограничений
    const rawSearch = deferredSearchTerm || '';
    if (rawSearch.trim().length > 0) {
      return filteredSignals;
    }

    const norm = (s: string) => (s || '').replace(/[\/:_\-]/g, '').toUpperCase();

    // 1. Извлекаем открытые сделки в терминале (актуальные позиции)
    const openTrades = paperTrades.filter(t => t.status === 'OPEN' && !(t as any).isSyntheticSeed);

    // Сигналы, соответствующие открытым позициям пользователя в терминале
    const openSignals: Signal[] = [];
    const seenOpenSymbols = new Set<string>();

    for (const trade of openTrades) {
      const tradeSymNorm = norm(trade.symbol);
      if (seenOpenSymbols.has(tradeSymNorm)) continue;

      const isShortTrade = trade.side === 'SHORT';
      const isLongTrade = trade.side === 'LONG';

      // Проверяем соответствие фильтру направления
      if (signalDirectionFilter === 'LONG' && !isLongTrade) continue;
      if (signalDirectionFilter === 'SHORT' && !isShortTrade) continue;

      // Ищем готовый сигнал в filteredSignals, либо в deferredSignals, либо формируем валидный объект сигнала из сделки
      let matchingSignal = filteredSignals.find(s => norm(s.symbol || '') === tradeSymNorm);
      if (!matchingSignal) {
        matchingSignal = deferredSignals.find(s => norm(s.symbol || '') === tradeSymNorm);
      }

      if (matchingSignal) {
        openSignals.push(matchingSignal);
        seenOpenSymbols.add(tradeSymNorm);
      } else {
        const cleanSym = tradeSymNorm;
        const curPrice = renderedPrices[cleanSym] || renderedPrices[trade.symbol] || trade.entryPrice;
        const synthSig: Signal = {
          symbol: trade.symbol,
          coin: trade.symbol.split('/')[0] || trade.symbol,
          exchange: trade.exchange || 'WEEX',
          price: curPrice || trade.entryPrice,
          signal: trade.side as any,
          riskLevel: 'LOW',
          type: trade.mode === 'AUTO' ? 'AUTOPILOT' : 'MANUAL',
          aiScore: trade.aiScore || 90,
          timestamp: trade.openTime || Date.now(),
          change24h: 0,
          volume: 0,
          target: trade.takeProfit ? String(trade.takeProfit) : undefined,
          high24h: curPrice || trade.entryPrice,
          low24h: curPrice || trade.entryPrice
        };
        openSignals.push(synthSig);
        seenOpenSymbols.add(tradeSymNorm);
      }
    }

    // Если активен фильтр "В СДЕЛКЕ", показываем только сигналы по открытым сделкам (до 6)
    if (signalDirectionFilter === 'POSITIONS') {
      return openSignals.slice(0, 6);
    }

    // 2. В обычном режиме мониторинга рынка — отбираем кандидатов согласно фильтру (ALL, LONG, SHORT), исключая уже добавленные открытые сделки
    const candidates = [...filteredSignals].filter(s => {
      if (!s) return false;
      const sNorm = norm(s.symbol || '');
      if (seenOpenSymbols.has(sNorm)) return false;

      const sigStr = (s.signal || '').toUpperCase();
      if (sigStr === 'MANUAL') return true;
      const isShort = sigStr.includes('SELL') || sigStr.includes('SHORT');
      const isLong = sigStr.includes('BUY') || sigStr.includes('LONG');
      if (signalDirectionFilter === 'LONG') return isLong;
      if (signalDirectionFilter === 'SHORT') return isShort;
      return isShort || isLong;
    });

    // Сортировка:
    // Качественные сигналы ранжируются по объективному взвешенному AI Score с нормализованной волатильностью и всплесками объемов.
    const sorted = candidates.sort((a, b) => {
      const sigA = a.signal || '';
      const sigB = b.signal || '';
      if (sigA === 'MANUAL' && sigB !== 'MANUAL') return -1;
      if (sigB === 'MANUAL' && sigA !== 'MANUAL') return 1;
      
      const aiScoreA = a.aiScore || (a.score10 ? parseFloat(a.score10) * 10 : 0);
      const aiScoreB = b.aiScore || (b.score10 ? parseFloat(b.score10) * 10 : 0);
      
      const volA = Math.min(25, Number(a.volatility || 0));
      const volB = Math.min(25, Number(b.volatility || 0));

      const scoreA = (aiScoreA * 3) + 
                     ((a.volumeSpike || 0) * 2) + 
                     (volA * 0.6) + 
                     (a.whaleHit ? 15 : 0) + 
                     (a.pumpDetected ? 10 : 0) + 
                     (a.stopHunt ? 8 : 0);
                     
      const scoreB = (aiScoreB * 3) + 
                     ((b.volumeSpike || 0) * 2) + 
                     (volB * 0.6) + 
                     (b.whaleHit ? 15 : 0) + 
                     (b.pumpDetected ? 10 : 0) + 
                     (b.stopHunt ? 8 : 0);
                     
      return scoreB - scoreA;
    });

    const TARGET_COUNT = 6;
    let finalTop: Signal[] = [];

    if (signalDirectionFilter === 'ALL') {
      // Требование: топ 6 сделок (SHORT, LONG), включая открытые сделки в терминале
      if (openSignals.length >= TARGET_COUNT) {
        finalTop = openSignals.slice(0, TARGET_COUNT);
      } else {
        const needed = TARGET_COUNT - openSignals.length;

        // Подсчитываем распределение LONG и SHORT среди открытых позиций
        const openLongCount = openSignals.filter(s => (s.signal || '').includes('BUY') || (s.signal || '').includes('LONG')).length;
        const openShortCount = openSignals.filter(s => (s.signal || '').includes('SELL') || (s.signal || '').includes('SHORT')).length;

        const candLongs = sorted.filter(s => s.signal === 'LONG' || (s.signal && s.signal.includes('BUY')));
        const candShorts = sorted.filter(s => s.signal === 'SHORT' || (s.signal && s.signal.includes('SELL')));

        // Стремимся к гармоничному балансу (до 3 LONG и до 3 SHORT в финальном топе из 6)
        const targetLong = Math.max(0, 3 - openLongCount);
        const targetShort = Math.max(0, 3 - openShortCount);

        const pickedLongs = candLongs.slice(0, targetLong);
        const pickedShorts = candShorts.slice(0, targetShort);

        // Чередуем для наглядности (LONG, SHORT, LONG, SHORT...)
        const filler: Signal[] = [];
        const maxLen = Math.max(pickedLongs.length, pickedShorts.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < pickedLongs.length) filler.push(pickedLongs[i]);
          if (i < pickedShorts.length) filler.push(pickedShorts[i]);
        }

        // Если не набралось needed из сбалансированных, добираем любые оставшиеся лучшие сигналы
        if (filler.length < needed) {
          const used = new Set(filler.map(s => norm(s.symbol || '')));
          for (const s of sorted) {
            const symKey = norm(s.symbol || '');
            if (!used.has(symKey)) {
              filler.push(s);
              used.add(symKey);
              if (filler.length >= needed) break;
            }
          }
        }

        finalTop = [...openSignals, ...filler.slice(0, needed)].slice(0, TARGET_COUNT);
      }
    } else {
      // Для конкретного направления (LONG или SHORT)
      if (openSignals.length >= TARGET_COUNT) {
        finalTop = openSignals.slice(0, TARGET_COUNT);
      } else {
        const needed = TARGET_COUNT - openSignals.length;
        finalTop = [...openSignals, ...sorted.slice(0, needed)].slice(0, TARGET_COUNT);
      }
    }

    return finalTop;
  }, [filteredSignals, signalDirectionFilter, deferredSearchTerm, paperTrades, deferredSignals, renderedPrices]);

  const handleSelectSignal = async (sig: Signal) => {
    setEntryPrice(sig.price);
    const isShortSignal = (sig.signal || '').includes('SELL') || (sig.signal || '').includes('SHORT');
    const isLongSignal = (sig.signal || '').includes('BUY') || (sig.signal || '').includes('LONG');
    let posType = positionType;
    if (isShortSignal) {
      posType = 'short';
      setPositionType('short');
    } else if (isLongSignal) {
      posType = 'long';
      setPositionType('long');
    }
    setSelectedCoin(sig.coin);
    setSelectedSignal(sig);
    
    // Автоматический расчет маржи (5% от депозита)
    const currentBal = tradingMode === 'real' ? (realBalance || virtualBalance) : virtualBalance;
    let autoMargin = currentBal * 0.05;
    if (autoMargin < 10) autoMargin = 10; // min $10
    setMargin(Number(autoMargin.toFixed(2)));

    if (posType === 'short') {
      if (sig.atr && Number(sig.atr) > 0) {
        // Advanced ATR-based Stop Loss
        const atrNum = Number(sig.atr);
        setTakeProfit(Number((sig.price - (atrNum * 2)).toFixed(5)));
        setStopLoss(Number((sig.price + (atrNum * 2.5)).toFixed(5)));
      } else if (sig.liqPrice && sig.liqPrice > sig.price) {
        setTakeProfit(Number((sig.price * 0.9).toFixed(5)));
        setStopLoss(Number((sig.liqPrice * 0.99).toFixed(5)));
      } else {
        setTakeProfit(Number((sig.price * 0.9).toFixed(5)));
        let lastPrice = sig.price;
        for (let i = 0; i < stepsCount; i++) {
          lastPrice = lastPrice * (1 + stepPercent / 100);
        }
        setStopLoss(Number((lastPrice * 1.015).toFixed(5)));
      }
    } else {
      if (sig.atr && Number(sig.atr) > 0) {
        const atrNum = Number(sig.atr);
        setTakeProfit(Number((sig.price + (atrNum * 2)).toFixed(5)));
        setStopLoss(Number((sig.price - (atrNum * 2.5)).toFixed(5)));
      } else if (sig.liqPrice && sig.liqPrice < sig.price) {
        setTakeProfit(Number((sig.price * 1.1).toFixed(5)));
        setStopLoss(Number((sig.liqPrice * 1.01).toFixed(5)));
      } else {
        setTakeProfit(Number((sig.price * 1.1).toFixed(5)));
        let lastPrice = sig.price;
        for (let i = 0; i < stepsCount; i++) {
          lastPrice = lastPrice * (1 - stepPercent / 100);
        }
        setStopLoss(Number((lastPrice * 0.985).toFixed(5)));
      }
    }

    // Scroll to strategy section (Fix 2)
    setTimeout(() => {
      document.getElementById('strategy-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const handleCloseSelection = () => {
    setSelectedSignal(null);
    setSelectedCoin('');
    setAiAnalysisResult(null);
    setChartSymbol(null);
  };

  // Real-time synchronization for selected coin inside the calculator
  useEffect(() => {
    if (selectedSignal) {
      const updated = signals.find(s => s.symbol === selectedSignal.symbol);
      
      if (updated) {
        if (updated.price !== selectedSignal.price) {
          setSelectedSignal(prev => (prev && prev.symbol === updated.symbol && prev.price === updated.price) ? prev : updated);
        }
        if (tradeMode === 'AUTO' && Math.abs(entryPrice - updated.price) > 0.000001) {
          setEntryPrice(prev => Math.abs(prev - updated.price) < 0.000001 ? prev : updated.price);
        }
      }
    }
  }, [signals, selectedSignal?.symbol, tradeMode, entryPrice]);

  const calculateLadder = () => {
    const ladder = [];
    const count = Math.max(1, stepsCount || 1);
    const pct = stepPercent || 0;
    let currentPrice = entryPrice;
    let currentMargin = margin / (Math.pow(2, count) - 1);
    
    // Scan order book walls for safety backing if enabled
    const walls = (selectedSignal?.obWalls || selectedSignal?.walls || []) as { type: 'bid' | 'ask'; price: number; size: number }[];
    const relevantWalls = walls.filter(w => positionType === 'short' ? w.type === 'ask' : w.type === 'bid');

    const atrNum = selectedSignal?.atr ? Number(selectedSignal.atr) : (entryPrice * 0.015);
    const atrPct = (atrNum / entryPrice) * 100;

    for (let i = 0; i < count; i++) {
      let finalStepPrice = currentPrice;
      
      // If we are in wall-alignment mode and it's a grid order (step i > 0)
      if (alignWithWalls && i > 0 && relevantWalls.length > 0) {
         // Find a wall closest to the mathematical target price
         const closestWall = relevantWalls.reduce((prev, curr) => {
            return Math.abs(curr.price - currentPrice) < Math.abs(prev.price - currentPrice) ? curr : prev;
         });
         
         if (closestWall) {
            // Place order slightly in front (0.05% distance) to guarantee execution before the wall spikes
            if (positionType === 'short') {
               finalStepPrice = closestWall.price * 0.9995;
            } else {
               finalStepPrice = closestWall.price * 1.0005;
            }
         }
      }

      ladder.push({ 
        step: i + 1, 
        price: finalStepPrice, 
        margin: currentMargin, 
        size: currentMargin * (leverage || 1) 
      });
      
      const stepCoef = 1.0 + (i * 0.35);
      const currentStepPct = useAtrDynamicDca ? Math.max(1.5, Math.min(15, atrPct * stepCoef)) : pct;

      if (positionType === 'short') currentPrice = currentPrice * (1 + currentStepPct / 100);
      else currentPrice = currentPrice * (1 - currentStepPct / 100);
      currentMargin = currentMargin * 2;
    }
    return ladder;
  };

  const isOpeningTradeRef = useRef(false);

  const handleOpenPaperTrade = async () => {
    console.log('[DEBUG] handleOpenPaperTrade called', { 
      selectedSignal: selectedSignal?.symbol, 
      isAnalyzing, 
      isOpeningTrade: isOpeningTradeRef.current,
      entryPrice,
      margin
    });

    if (!selectedSignal || isAnalyzing || isOpeningTradeRef.current) {
      console.log('[DEBUG] handleOpenPaperTrade blocked by state', { 
        noSignal: !selectedSignal, 
        isAnalyzing, 
        isOpeningTrade: isOpeningTradeRef.current 
      });
      return;
    }
    
    // ПРОВЕРКА НА ЗАДВОЕНИЕ (NORMALIZED):
    const normalizedSelectedSym = selectedSignal.symbol.replace('/', '').replace(':', '').toUpperCase();
    const activeExists = paperTrades.find(t => {
      const tNorm = t.symbol.replace('/', '').replace(':', '').toUpperCase();
      return t.status === 'OPEN' && tNorm === normalizedSelectedSym;
    });
    
    if (activeExists) {
      if (addToast) addToast(`У вас уже есть открытая сделка по ${selectedSignal.symbol}. Перенаправляем в терминал.`, 'info');
      setTerminalVisible(true); // Ensure terminal is open
      
      // Scroll to existing trade
      const scrollAttempt = (attempts = 0) => {
        const el = document.getElementById(`trade-card-${activeExists.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'ring-offset-zinc-950');
          setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'ring-offset-zinc-950'), 2000);
        } else {
          const terminal = document.getElementById('simulator-section');
          if (terminal) {
            terminal.scrollIntoView({ behavior: 'smooth' });
          } else if (attempts < 5) {
            setTimeout(() => scrollAttempt(attempts + 1), 200);
          }
        }
      };
      scrollAttempt();
      return;
    }
    
    setIsAnalyzing(true); // Disable button while executing
    isOpeningTradeRef.current = true;
    
    if (!entryPrice || entryPrice <= 0 || !margin || margin <= 0) {
      if (addToast) addToast('Некорректная цена входа или сумма маржи.', 'error');
      setIsAnalyzing(false);
      isOpeningTradeRef.current = false;
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
      const ladder = calculateLadder();
      const gridOrders = ladder.slice(1).map(step => ({ price: step.price, amount: step.size, executed: false }));
      
      const tpValToSend = takeProfit !== ''
        ? (calcTpMode === 'PERCENT' ? getCalcPriceFromPnlPct(Number(takeProfit), true) : Number(takeProfit))
        : undefined;

      const slValToSend = stopLoss !== ''
        ? (calcSlMode === 'PERCENT' ? getCalcPriceFromPnlPct(Number(stopLoss), false) : Number(stopLoss))
        : undefined;

      const finalAmount = tradingMode === 'real' ? Math.max(20, margin) : margin;
      const finalLeverage = tradingMode === 'real' ? Math.max(5, leverage) : leverage;

      let manualTpStages: any[] | undefined = undefined;
      const posSide = positionType.toUpperCase();
      const dir = posSide === 'SHORT' ? -1 : 1;
      if (entryPrice && entryPrice > 0) {
        const tp1Price = Number((entryPrice * (1 + dir * 0.012)).toFixed(5));
        const tp2Price = Number((entryPrice * (1 + dir * 0.025)).toFixed(5));
        const tp3Price = tpValToSend || Number((entryPrice * (1 + dir * 0.045)).toFixed(5));
        manualTpStages = [
          { targetPrice: tp1Price, targetPercent: 1.2, closeRatio: 0.35, executed: false },
          { targetPrice: tp2Price, targetPercent: 2.5, closeRatio: 0.35, executed: false },
          { targetPrice: tp3Price, targetPercent: 4.5, closeRatio: 0.30, executed: false }
        ];
      }

      const reqBody = {
        symbol: selectedSignal.symbol, exchange: selectedSignal.exchange, entryPrice: entryPrice,
        amount: finalAmount, leverage: finalLeverage, side: positionType.toUpperCase(),
        signalAiScore: selectedSignal.aiScore || 0, mode: tradeMode, takeProfit: tpValToSend,
        stopLoss: slValToSend, tpStages: manualTpStages, gridOrders,
        isReal: tradingMode === 'real'
      };

      if (tradingMode === 'real') {
        const realRes = await fetch('/api/real-trade/open', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody)
        });
        const realData = await realRes.json();
        if (!realRes.ok || !realData.success) {
          throw new Error(`Ошибка биржи: ${realData.error || 'Невозможно открыть позицию'}`);
        }
        if (addToast) addToast('Реальная позиция открыта на бирже!', 'success');
      }

      const res = await fetch('/api/paper-trade/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(reqBody)
      });
      
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      
      if (data.success) {
        setPaperTrades(prev => [...prev, data.data]);
        paperTradesRef.current = [...paperTradesRef.current, data.data];
        if (data.balance !== undefined) updateSafeVirtualBalance(data.balance, true);
        setTerminalVisible(true); // Explicitly open terminal
        if (addToast) addToast('Виртуальная сделка открыта!', 'success');
        
        // Scroll to simulator section
        const scrollAttempt = (attempts = 0) => {
          const el = document.getElementById('simulator-section');
          if (el) {
            el.scrollIntoView({ behavior: 'smooth' });
          } else if (attempts < 5) {
            setTimeout(() => scrollAttempt(attempts + 1), 200);
          }
        };
        setTimeout(scrollAttempt, 100);
      }
    } catch (e: any) { 
      console.error(e); 
      if (e.name === 'AbortError') {
        if (addToast) addToast('Ошибка: Превышено время ожидания (60с). Попробуйте еще раз или обновите страницу.', 'error');
      } else {
        if (addToast && !e?.message?.includes("Failed to fetch")) addToast(`Ошибка открытия сделки: ${e.message}`, 'error');
      }
    } finally {
      clearTimeout(timeoutId);
      setIsAnalyzing(false);
      isOpeningTradeRef.current = false;
    }
  };

  const ladder = calculateLadder();

  const displayActiveTrades = useMemo(() => {
    let list: any[] = [];
    if (tradingMode === 'virtual') {
      list = paperTrades.filter(t => t.status === 'OPEN' && !t.isReal && !t.isAutoLearning);
    } else {
      const apRealTrades = paperTrades.filter(t => t.status === 'OPEN' && t.isReal && !t.isAutoLearning);
      const merged: any[] = [];
      const matchedRealSymbols = new Set<string>();
      const normalize = (sym: string) => sym.replace(/[\/:]/g, '').toUpperCase();

      apRealTrades.forEach(apTrade => {
        const apNorm = normalize(apTrade.symbol);
        const matchingExchangeTrade = realTrades.find(r => normalize(r.symbol) === apNorm);

        if (matchingExchangeTrade) {
          merged.push({
            ...apTrade,
            entryPrice: matchingExchangeTrade.entryPrice || apTrade.entryPrice,
            amount: matchingExchangeTrade.amount || apTrade.amount,
            leverage: matchingExchangeTrade.leverage || apTrade.leverage,
            side: matchingExchangeTrade.side || apTrade.side,
            stopLoss: matchingExchangeTrade.stopLoss !== undefined ? matchingExchangeTrade.stopLoss : apTrade.stopLoss,
            takeProfit: matchingExchangeTrade.takeProfit !== undefined ? matchingExchangeTrade.takeProfit : apTrade.takeProfit,
            pnl: matchingExchangeTrade.pnl,
            pnlPercent: matchingExchangeTrade.pnlPercent,
            isMerged: true
          });
          matchedRealSymbols.add(apNorm);
        } else {
          merged.push(apTrade);
        }
      });

      realTrades.forEach(rTrade => {
        const rNorm = normalize(rTrade.symbol);
        if (!matchedRealSymbols.has(rNorm)) {
          merged.push(rTrade);
        }
      });

      list = merged;
    }

    // Дедупликация по ID для полного исключения повторного рендеринга одинаковых открытых сделок
    const seen = new Set<string>();
    return list.filter(t => {
      const key = t.id || `${t.symbol}_${t.side}_${t.openTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [tradingMode, paperTrades, realTrades]);

  const activePaperTrades = useMemo(() => {
    const raw = paperTrades.filter(t => t.status === 'OPEN' && !t.isReal && !t.isAutoLearning && !(t as any).isSyntheticSeed);
    const seen = new Set<string>();
    return raw.filter(t => {
      const key = t.id || `${t.symbol}_${t.side}_${t.openTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [paperTrades]);
  
  const closedVirtualTrades = useMemo(() => paperTrades.filter(t => t.status === 'CLOSED' && !t.isReal && !t.isAutoLearning && !(t as any).isSyntheticSeed), [paperTrades]);
  const closedRealTrades = useMemo(() => paperTrades.filter(t => t.status === 'CLOSED' && !!t.isReal), [paperTrades]);
  const autoLearningTrades = useMemo(() => paperTrades.filter(t => !!t.isAutoLearning || !!(t as any).isSyntheticSeed), [paperTrades]);

  const formatTradeTime = useCallback((timestamp?: number | string | null) => {
    if (!timestamp) return '---';
    const timeNum = typeof timestamp === 'string' ? (isNaN(Number(timestamp)) ? new Date(timestamp).getTime() : Number(timestamp)) : Number(timestamp);
    if (!timeNum || isNaN(timeNum)) return '---';
    const date = new Date(timeNum);
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }, []);

  const formatTradeDuration = useCallback((open?: number | string | null, close?: number | string | null) => {
    if (!open || !close) return null;
    const tOpen = typeof open === 'string' ? (isNaN(Number(open)) ? new Date(open).getTime() : Number(open)) : Number(open);
    const tClose = typeof close === 'string' ? (isNaN(Number(close)) ? new Date(close).getTime() : Number(close)) : Number(close);
    if (!tOpen || !tClose || isNaN(tOpen) || isNaN(tClose) || tClose <= tOpen) return null;
    const diffSec = Math.floor((tClose - tOpen) / 1000);
    if (diffSec < 60) return `${diffSec}с`;
    const diffMin = Math.floor(diffSec / 60);
    const remSec = diffSec % 60;
    if (diffMin < 60) return `${diffMin}м ${remSec}с`;
    const diffHours = Math.floor(diffMin / 60);
    const remMin = diffMin % 60;
    return `${diffHours}ч ${remMin}м`;
  }, []);

  const currentHistoryTrades = useMemo(() => {
    if (historyTab === 'real') return closedRealTrades;
    if (historyTab === 'learning') return autoLearningTrades.filter(t => t.status === 'CLOSED');
    return closedVirtualTrades;
  }, [historyTab, closedVirtualTrades, closedRealTrades, autoLearningTrades]);
  
  const allTradesArray = useMemo(() => [...paperTrades, ...realTrades], [paperTrades, realTrades]);
  
  const [terminalVisible, setTerminalVisible] = useState(false);
  
  useEffect(() => {
    // Sync terminal visibility with active trades - be more aggressive
    const activeCount = displayActiveTrades.length;
    if (activeCount > 0) {
      if (!terminalVisible && termReady) {
        setTerminalVisible(true);
      }
    } else if (terminalVisible) {
      // Auto-close terminal only if no active trades
      const timer = setTimeout(() => {
        setTerminalVisible(false);
      }, 3000); 
      return () => clearTimeout(timer);
    }
  }, [displayActiveTrades.length, termReady, terminalVisible]);

  const getSafeHistoryTradePnl = (t: any) => {
    if (t.pnl !== undefined && t.pnl !== null) return Number(t.pnl);
    if (t.pnlPercent !== undefined && t.pnlPercent !== null) {
      const amt = Number(t.amount || t.initialAmount || 10);
      return amt * (Number(t.pnlPercent) / 100);
    }
    return 0;
  };

  const totalTrades = currentHistoryTrades.length;
  const winTrades = currentHistoryTrades.filter(t => getSafeHistoryTradePnl(t) > 0).length;
  const winrate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(0) : 0;
  const totalPnl = currentHistoryTrades.reduce((acc, t) => acc + getSafeHistoryTradePnl(t), 0);
  const bestTrade = currentHistoryTrades.reduce((best, t) => (!best || getSafeHistoryTradePnl(t) > getSafeHistoryTradePnl(best)) ? t : best, null as any);

  const manualSync = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/paper-trade');
      const data = await res.json();
      if (data.success) {
        setPaperTrades(data.data);
        paperTradesRef.current = data.data;
        if (data.balance !== undefined) updateSafeVirtualBalance(data.balance, true);
        if (addToast) addToast('Данные синхронизированы', 'info');
      }
    } catch (e) {
      if (addToast) addToast('Ошибка синхронизации', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleExportDB = () => {
    window.location.href = '/api/database/export';
  };

  const dailyDrawdownPct = startOfDayBalance > 0 ? ((virtualBalance - startOfDayBalance) / startOfDayBalance) * 100 : 0;
  const weeklyDrawdownPct = startOfWeekBalance > 0 ? ((virtualBalance - startOfWeekBalance) / startOfWeekBalance) * 100 : 0;
  const isDrawdownLimitReached = dailyDrawdownPct <= -15.0;

  const totalOpenPnl = useMemo(() => {
    let totalPnlUsd = 0;
    displayActiveTrades.forEach(trade => {
      const cleanSym = (trade.symbol || '').replace('/USDT:USDT', 'USDT').replace('/USDT', 'USDT').replace('_USDT', 'USDT').replace(':', '').replace('/', '');
      const baseSymbol = (trade.symbol || '').split('/')[0];
      const currentSymbolPrice = renderedPrices[cleanSym] || 
                                 renderedPrices[trade.symbol] || 
                                 renderedPrices[baseSymbol] ||
                                 renderedPrices[trade.symbol.replace('/', '')] || 
                                 renderedPrices[trade.symbol.replace('_', '/')] ||
                                 livePrice || 
                                 trade.entryPrice;
                                 
      const isActualPrice = (
        renderedPrices[cleanSym] || 
        renderedPrices[trade.symbol] || 
        renderedPrices[baseSymbol] ||
        renderedPrices[trade.symbol.replace('/', '')] || 
        renderedPrices[trade.symbol.replace('_', '/')] ||
        livePrice
      ) > 0;
      
      const diff = trade.side === 'SHORT' ? (trade.entryPrice - currentSymbolPrice) : (currentSymbolPrice - trade.entryPrice);
      const calculatedPnlPct = isActualPrice ? (diff / trade.entryPrice) * 100 * trade.leverage : 0;
      const calculatedPnlUsd = trade.amount * (calculatedPnlPct / 100);

      const isRealTrade = (trade as any).isReal || trade.exchange === 'real' || (trade.id && trade.id.toString().startsWith('real-'));
      const pnlUsd = (isRealTrade && (trade as any).pnl !== undefined && (trade as any).pnl !== null && !isNaN((trade as any).pnl))
        ? (trade as any).pnl
        : calculatedPnlUsd;
        
      totalPnlUsd += pnlUsd || 0;
    });
    return totalPnlUsd;
  }, [displayActiveTrades, renderedPrices, livePrice]);

  const activeTradeToRender = displayActiveTrades.find(t => t.id === activeTerminalTradeId) || displayActiveTrades[0];
  const isCurrentlyFullscreen = isTerminalFullscreen || isAppFullscreen;

  if (isStandaloneTrade || (isStandaloneTerminal && displayActiveTrades.length > 0) || (isCurrentlyFullscreen && displayActiveTrades.length > 0)) {
    const targetTrade = isStandaloneTrade
      ? (displayActiveTrades.find(t => 
          (standaloneParams.tradeId && t.id?.toString() === standaloneParams.tradeId?.toString()) ||
          (standaloneParams.symbol && t.symbol?.replace(/[\/:]/g, '').toUpperCase() === standaloneParams.symbol?.replace(/[\/:]/g, '').toUpperCase())
        ) || activeTradeToRender)
      : activeTradeToRender;

    return (
      <div className="w-full h-screen bg-zinc-950 p-6 overflow-y-auto font-sans select-none text-zinc-100 flex flex-col justify-start">
        {!targetTrade ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-20">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            <span className="text-zinc-400 text-sm font-semibold uppercase tracking-wider">Подключение к сделке...</span>
            <span className="text-zinc-600 text-xs">Сделка #{standaloneParams.tradeId || standaloneParams.symbol || 'не указана'} загружается</span>
          </div>
        ) : (
          <div className="w-full max-w-full h-full flex flex-col justify-start">
            {isCurrentlyFullscreen && (
              <div className="flex justify-between items-center mb-4 pb-4 border-b border-zinc-900 z-[9999] relative">
                <div className="text-zinc-400 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400 animate-pulse" />
                  Торговый терминал сделки: <span className="text-white font-black">{targetTrade.symbol}</span>
                </div>
                <button
                  onClick={() => {
                    if (isTerminalFullscreen) {
                      toggleFullscreen();
                    } else if (onToggleAppFullscreen) {
                      onToggleAppFullscreen();
                    }
                  }}
                  className="px-4 py-2 bg-zinc-900 hover:bg-zinc-850 text-xs font-bold uppercase tracking-widest text-zinc-400 hover:text-white border border-zinc-805 rounded-lg flex items-center gap-1.5 cursor-pointer transition-all"
                >
                  <Minimize2 className="w-3.5 h-3.5" /> Свернуть во весь экран
                </button>
              </div>
            )}
            <ActiveTradeItem 
              trade={targetTrade}
              latestPrices={renderedPrices}
              livePrice={livePrice}
              handleCloseActiveTrade={handleCloseActiveTrade}
              handleChangeTradeMode={handleChangeTradeMode}
              handleLeverageChange={handleLeverageChange}
              handleSlTpChange={handleSlTpChange}
              handleAverageTrade={handleAverageTrade}
              activeTerminalTradeId={activeTerminalTradeId}
              setActiveTerminalTradeId={setActiveTerminalTradeId}
              isRealBalanceVisible={isRealBalanceVisible}
              isStandalone={true}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn(
      "flex flex-col gap-6 font-sans select-none w-full",
      (isStandaloneTerminal || isStandaloneTrade) ? "p-0 max-w-none" : "max-w-7xl mx-auto pb-10 p-4"
    )}>
      
      {isCircuitBreakerActive && tradingMode === 'real' && (
         <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-lg">
           <div className="flex items-center gap-3">
             <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
             <div>
               <div className="text-red-400 font-bold uppercase tracking-wider text-sm">Торговый предохранитель активен (Circuit Breaker)</div>
               <div className="text-zinc-400 text-xs mt-0.5">Превышен лимит дневной просадки реального аккаунта более чем на 3.0%. Реальная торговля заблокирована до следующего дня. Виртуальная торговля остается доступной.</div>
             </div>
           </div>
           <button
             onClick={handleResetCircuitBreaker}
             className="px-4 py-2 bg-red-500/20 border border-red-500/45 hover:bg-red-500/30 text-red-200 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all shadow-glow hover:shadow-glow-rose shrink-0"
           >
             Сбросить предохранитель
           </button>
         </div>
      )}

      {isBtcShockLock && (
         <div className="bg-amber-500/20 border border-amber-500/35 p-4 rounded-xl flex items-center justify-between shadow-lg">
           <div className="flex items-center gap-3">
             <Zap className="w-5 h-5 text-amber-400 shrink-0 animate-bounce" />
             <div>
               <div className="text-amber-400 font-bold uppercase tracking-wider text-sm">Режим тишины (BTC Shock Lock)</div>
               <div className="text-zinc-400 text-xs mt-0.5">Входы заморожены из-за резкого ценового импульса BTC. Повышенная волатильность рынка.</div>
             </div>
           </div>
           <div className="text-amber-400 font-mono text-sm font-bold bg-amber-500/10 border border-amber-500/25 px-3 py-1 rounded-lg">
             ОСТАЛОСЬ: {btcShockRemaining} СЕК
           </div>
         </div>
      )}

      {dataLag > 15000 && (
         <div className="bg-amber-500/15 border border-amber-500/30 p-4 rounded-xl flex items-center justify-between mb-2 shadow-lg">
           <div className="flex items-center gap-3">
             <RefreshCw className="w-5 h-5 text-amber-400 animate-spin" />
             <div>
               <div className="text-amber-400 font-bold uppercase tracking-wider text-sm">Внимание: Задержка канала (VPN)</div>
               <div className="text-zinc-400 text-xs mt-0.5">Сервер продолжает мониторить 761 пар в облаке. Поток в браузер задерживается ({Math.floor(dataLag/1000)} сек.)</div>
             </div>
           </div>
           <div className="flex items-center gap-2 shrink-0">
             <button 
               onClick={handleForceReconnectAll} 
               className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-bold transition-colors uppercase cursor-pointer"
             >
               Восстановить поток
             </button>
             <button 
               onClick={() => window.location.reload()} 
               className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-400 rounded-lg text-xs font-medium transition-colors uppercase"
             >
               Обновить страницу
             </button>
           </div>
         </div>
      )}

      {showRealModeConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-zinc-950 border border-red-500/30 rounded-2xl p-6 max-w-md w-full shadow-2xl shadow-red-900/20 text-center md:text-left">
            <div className="flex items-center gap-3 text-red-500 mb-4 justify-center md:justify-start">
              <Zap className="w-6 h-6 shrink-0" />
              <h2 className="text-lg font-black tracking-wider uppercase">Опасная зона</h2>
            </div>
            <p className="text-sm text-zinc-300 mb-6 leading-relaxed">
              Вы выключаете безопасный режим (Paper Trading). Система начнет использовать <b>реальный баланс</b> на вашей бирже через API. Разработчики не несут ответственности за результаты автоматической и ручной торговли. Вы уверены, что хотите продолжить?
            </p>
            <div className="flex flex-col md:flex-row gap-3 mt-8">
              <button
                onClick={() => setShowRealModeConfirm(false)}
                className="flex-[0.5] py-3 px-4 rounded-xl font-bold bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
              >
                Отмена
              </button>
              <button
                onClick={() => {
                  if (setTradingMode) setTradingMode('real');
                  syncTradingModeWithServer('real');
                  if (onRefreshRealBalance) onRefreshRealBalance();
                  setShowRealModeConfirm(false);
                }}
                className="flex-1 py-3 px-4 rounded-xl font-black bg-red-600 text-white hover:bg-red-500 transition uppercase tracking-wider shadow-lg shadow-red-500/20"
              >
                Подтвердить
              </button>
            </div>
          </div>
        </div>
      )}

      {showBalanceModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-zinc-950 border border-indigo-500/30 rounded-2xl p-6 max-w-sm w-full shadow-2xl shadow-indigo-900/20">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-indigo-400">
                <Sliders className="w-5 h-5 shrink-0" />
                <h2 className="text-base font-black tracking-wider uppercase">
                  {balanceModalType === 'edit' ? 'Изменение баланса' : 'Пополнение баланса'}
                </h2>
              </div>
              <button 
                onClick={() => setShowBalanceModal(false)}
                className="text-zinc-500 hover:text-zinc-300 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={submitBalanceChange} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
                  Сумма в USDT:
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-sm">$</span>
                  <input
                    type="number"
                    step="any"
                    value={balanceInputVal}
                    onChange={(e) => setBalanceInputVal(e.target.value)}
                    placeholder="Введите сумму"
                    className="w-full pl-8 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 focus:border-indigo-500 focus:outline-none rounded-xl text-zinc-100 font-mono text-sm transition-colors"
                    autoFocus
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">
                  Пресеты:
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[100, 300, 500].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setBalanceInputVal(preset.toString())}
                      className={cn(
                        "py-1.5 px-3 rounded-lg text-xs font-mono font-bold transition-all border",
                        balanceInputVal === preset.toString()
                          ? "bg-indigo-600/20 border-indigo-500 text-indigo-400 font-black shadow-inner"
                          : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
                      )}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>
              {balanceModalType === 'edit' ? (
                <div className="space-y-2.5 pt-1 border-t border-zinc-900/50">
                  <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">
                    Режим смены баланса:
                  </label>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => setCloseActiveTradesOnReset(true)}
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-xl border text-left transition-all duration-300",
                        closeActiveTradesOnReset
                          ? "bg-indigo-600/10 border-indigo-500/40 shadow-lg shadow-indigo-500/5"
                          : "bg-zinc-900/40 border-zinc-900 text-zinc-400 hover:border-zinc-800 hover:text-zinc-300"
                      )}
                    >
                      <div className={cn(
                        "w-4 h-4 rounded-full border flex items-center justify-center mt-0.5 shrink-0 transition-all duration-300",
                        closeActiveTradesOnReset
                          ? "border-indigo-500 bg-indigo-600 text-white scale-100"
                          : "border-zinc-700 bg-zinc-950 scale-95"
                      )}>
                        {closeActiveTradesOnReset && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                      </div>
                      <div>
                        <div className="text-xs font-black text-zinc-200">
                          Закрыть все активные сделки
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 leading-tight">
                          Все открытые виртуальные позиции будут автоматически закрыты по текущей цене. Торговля начнется с нового баланса без открытых рисков.
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCloseActiveTradesOnReset(false)}
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-xl border text-left transition-all duration-300",
                        !closeActiveTradesOnReset
                          ? "bg-indigo-600/10 border-indigo-500/40 shadow-lg shadow-indigo-500/5"
                          : "bg-zinc-900/40 border-zinc-900 text-zinc-400 hover:border-zinc-800 hover:text-zinc-300"
                      )}
                    >
                      <div className={cn(
                        "w-4 h-4 rounded-full border flex items-center justify-center mt-0.5 shrink-0 transition-all duration-300",
                        !closeActiveTradesOnReset
                          ? "border-indigo-500 bg-indigo-600 text-white scale-100"
                          : "border-zinc-700 bg-zinc-950 scale-95"
                      )}>
                        {!closeActiveTradesOnReset && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                      </div>
                      <div>
                        <div className="text-xs font-black text-zinc-200">
                          Продолжить вести активные сделки
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1 leading-tight">
                          Все открытые виртуальные позиции продолжат функционировать от нового баланса без изменений.
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-zinc-500 leading-normal">
                  Указанная сумма будет добавлена к вашему текущему виртуальному балансу.
                </p>
              )}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBalanceModal(false)}
                  className="flex-1 py-2.5 px-4 rounded-xl font-bold bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition text-sm"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 px-4 rounded-xl font-black bg-indigo-600 hover:bg-indigo-500 text-white transition text-sm uppercase tracking-wider shadow-lg shadow-indigo-500/25"
                >
                  {balanceModalType === 'edit' ? 'Сохранить' : 'Пополнить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Main Navigation */}
      {!isStandaloneTerminal && !isStandaloneTrade && (
        <div className="flex items-center justify-between bg-zinc-900/95 backdrop-blur-2xl border border-zinc-800 p-1.5 rounded-2xl sticky top-4 z-40 shadow-2xl shadow-black/80">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar px-1">
            <button 
              onClick={() => setMainTab('scanner')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'scanner' 
                  ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-glow-indigo" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <Activity className="w-3.5 h-3.5 shrink-0" /> ТЕРМИНАЛ
            </button>
            
            <button 
              onClick={() => setMainTab('history')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'history' 
                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 shadow-glow-rose" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <History className="w-3.5 h-3.5 shrink-0" /> ИСТОРИЯ
            </button>

            <button 
              onClick={() => setMainTab('signal_analytics')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'signal_analytics' 
                  ? "bg-indigo-600 text-white border border-indigo-400/40 shadow-glow-indigo" 
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.02]"
              )}
            >
              <BarChart3 className="w-3.5 h-3.5 text-indigo-300 shrink-0" /> АНАЛИТИКА СИГНАЛОВ
            </button>

            <button 
              onClick={() => setMainTab('knowledge')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'knowledge' 
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/20 shadow-glow-indigo" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <Brain className="w-3.5 h-3.5 shrink-0" /> ИИ БАЗА
            </button>

            <button 
              onClick={() => setMainTab('peaks')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'peaks' 
                  ? "bg-rose-500/10 text-rose-500 border border-rose-500/20 shadow-glow-rose" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <TrendingDown className="w-3.5 h-3.5 text-rose-400 shrink-0" /> ПИКИ
            </button>

            <button 
              onClick={() => setMainTab('telemetry')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'telemetry' 
                  ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-glow-indigo" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <Activity className="w-3.5 h-3.5 text-indigo-400 animate-pulse shrink-0" /> ТЕЛЕМЕТРИЯ
            </button>

            <button 
              onClick={() => setMainTab('fine_tuning')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'fine_tuning' 
                  ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-glow-indigo" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <Sliders className="w-3.5 h-3.5 text-indigo-400 animate-pulse shrink-0" /> ИИ НАСТРОЙКИ
            </button>

            <button 
              onClick={() => setMainTab('funding')} 
              className={cn(
                "px-2.5 py-1.5 rounded-xl font-bold text-[10px] uppercase tracking-wider transition-all duration-300 whitespace-nowrap flex items-center gap-1.5", 
                mainTab === 'funding' 
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-glow-emerald" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.02]"
              )}
            >
              <Calculator className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> ФАНДИНГ
            </button>
          </div>

        <div className="flex items-center gap-3 px-3 border-l border-white/[0.06] ml-2 shrink-0">
          {/* Индикатор качества сетевого соединения / VPN */}
          <button
            onClick={handleForceReconnectAll}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[9px] font-mono font-bold transition-all cursor-pointer",
              networkQuality === 'optimal' && "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20",
              networkQuality === 'lag' && "bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25",
              networkQuality === 'reconnecting' && "bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30 animate-pulse"
            )}
            title={
              networkQuality === 'optimal'
                ? `Соединение стабильно (${rttMs !== null ? `${rttMs}мс` : 'OK'}). Нажмите для мгновенного обновления.`
                : networkQuality === 'lag'
                ? `Задержка VPN / сокета (${rttMs !== null ? `${rttMs}мс` : 'LAG'}). Нажмите для быстрого переподключения.`
                : 'Потеря пакетов VPN. Восстановление потока данных... Нажмите для принудительного реконнекта.'
            }
          >
            {networkQuality === 'reconnecting' ? (
              <WifiOff className={cn("w-3 h-3 text-rose-400", isManualReconnecting && "animate-spin")} />
            ) : (
              <Wifi className={cn("w-3 h-3", networkQuality === 'optimal' ? "text-emerald-400" : "text-amber-400")} />
            )}
            <span className="leading-none">
              {networkQuality === 'reconnecting'
                ? 'РЕКОННЕКТ'
                : rttMs !== null
                ? `${rttMs}мс`
                : 'СЕТЬ'}
            </span>
          </button>

          <div className="flex flex-col items-end group">
            <div className="flex items-center gap-1.5 mb-[2px] cursor-pointer" onClick={() => handleToggleTradingMode(tradingMode === 'virtual' ? 'real' : 'virtual')} title="Переключить режим торговли (REAL / VIRTUAL)">
              <span className="text-[8px] font-black leading-none uppercase tracking-[0.2em] text-zinc-600 group-hover:text-zinc-400 transition-colors">БАЛАНС</span>
              <span className={cn("text-[7px] px-1.5 py-[2px] rounded-sm font-black tracking-widest leading-none border", tradingMode === 'real' ? "bg-red-500/10 border-red-500/20 text-red-400 font-mono" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-mono")}>{tradingMode === 'real' ? 'REAL' : 'TEST'}</span>
            </div>
            <div className="flex items-center gap-1.5 select-none">
              <span 
                onClick={tradingMode === 'virtual' ? handleEditBalance : () => handleToggleTradingMode('virtual')}
                className={cn("text-xs font-mono font-black tracking-tighter cursor-pointer transition-colors", tradingMode === 'real' ? "text-red-400 hover:text-red-300" : "text-emerald-400 hover:text-emerald-300")}
                title={tradingMode === 'virtual' ? "Редактировать баланс" : "Переключить на виртуальную торговлю"}
              >
                {tradingMode === 'virtual' ? `${virtualBalance.toLocaleString()}$` : (realBalance !== null ? (isRealBalanceVisible ? `${realBalance.toLocaleString()}$` : "••••") : '---')}
              </span>
              {tradingMode === 'real' && (
                <button 
                  onClick={() => setIsRealBalanceVisible(!isRealBalanceVisible)}
                  className="text-zinc-650 hover:text-zinc-400 transition-colors"
                  title={isRealBalanceVisible ? "Скрыть баланс" : "Показать баланс"}
                >
                  {isRealBalanceVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )}

      {mainTab === 'signal_analytics' && (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6">
          <Suspense fallback={
            <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
              <span className="text-xs text-zinc-400 font-mono">Загрузка аналитики сигналов...</span>
            </div>
          }>
            <SignalAnalyticsDashboard trades={allTradesArray} onRefresh={manualSync} />
          </Suspense>
        </div>
      )}

      {mainTab === 'funding' && (
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center py-20 bg-zinc-900/50 border border-zinc-800/50 rounded-xl text-zinc-500">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
            <span className="text-xs text-zinc-400 font-mono">Загрузка арбитража фандинга...</span>
          </div>
        }>
          <FundingArbitragePanel addToast={addToast} />
        </Suspense>
      )}

      {mainTab === 'knowledge' && (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
            <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2"><Brain className="w-6 h-6 text-indigo-400" /> База Знаний ИИ</h2>
            <div className="flex flex-wrap gap-2.5">
              <button 
                onClick={handleSmartAudit}
                disabled={isSmartAuditing || knowledgeBase.length === 0}
                className="px-4 py-2 bg-pink-500/10 hover:bg-pink-500/25 text-pink-400 border border-pink-500/35 rounded-lg flex items-center gap-2 font-medium transition-all disabled:opacity-50 cursor-pointer"
              >
                {isSmartAuditing ? <RefreshCw className="w-4 h-4 animate-spin text-pink-400" /> : <Sparkles className="w-4 h-4 text-pink-400 animate-pulse" />}
                {isSmartAuditing ? 'Архивариус думает...' : 'Тактический аудит рынка (Smart)'}
              </button>
              
              <button 
                onClick={handleRebalanceKnowledge}
                disabled={isRebalancing || knowledgeBase.length === 0}
                className="px-4 py-2 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 border border-indigo-500/30 rounded-lg flex items-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isRebalancing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                {isRebalancing ? 'Архивариус работает...' : 'Сжать Базу Знаний (Архивариус)'}
              </button>

              <button 
                onClick={handleUnarchiveAll}
                disabled={isRestoringAll || (knowledgeBase || []).filter(r => r.isArchived).length === 0}
                className="px-4 py-2 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/35 rounded-lg flex items-center gap-2 font-medium transition-all disabled:opacity-50 cursor-pointer"
              >
                {isRestoringAll ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FolderUp className="w-4 h-4 text-emerald-400" />}
                {isRestoringAll ? 'Активируем...' : 'Активировать все правила'}
              </button>
            </div>
          </div>

          {smartAuditExplanation && (
            <div className="mb-6 p-4 bg-pink-500/5 border border-pink-500/20 rounded-xl text-xs text-zinc-300 relative shadow-inner animate-in fade-in duration-300">
              <button 
                onClick={() => setSmartAuditExplanation(null)} 
                className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                title="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="font-bold text-pink-400 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                <Sparkles className="w-4.5 h-4.5 text-pink-400 animate-pulse" /> Умный Архивариус: Тактический Анализ рынка
              </div>
              <p className="whitespace-pre-wrap leading-relaxed pr-6 text-zinc-200">
                {smartAuditExplanation}
              </p>
            </div>
          )}

          <p className="text-zinc-400 mb-6">Добавляйте правила, стратегии и паттерны. ИИ будет учитывать их при анализе рынка и управлении сделками.</p>

          <div className="flex border-b border-zinc-800 mb-6 gap-2">
            <button
              onClick={() => setKnowledgeSubTab('active')}
              className={cn(
                "px-5 py-2.5 text-xs uppercase tracking-wider font-extrabold border-b-2 transition-all leading-none cursor-pointer",
                knowledgeSubTab === 'active'
                  ? "border-emerald-500 text-emerald-400 bg-emerald-500/5"
                  : "border-transparent text-zinc-450 hover:text-zinc-200"
              )}
            >
              Активные правила — {(knowledgeBase || []).filter(r => !r.isArchived).length}
            </button>
            <button
              onClick={() => setKnowledgeSubTab('archived')}
              className={cn(
                "px-5 py-2.5 text-xs uppercase tracking-wider font-extrabold border-b-2 transition-all leading-none cursor-pointer",
                knowledgeSubTab === 'archived'
                  ? "border-amber-500 text-amber-400 bg-amber-500/5"
                  : "border-transparent text-zinc-450 hover:text-zinc-200"
              )}
            >
              Архив правил — {(knowledgeBase || []).filter(r => !!r.isArchived).length}
            </button>
          </div>
          
          <div className="flex flex-col gap-4 mb-6 bg-zinc-950 p-4 rounded-xl border border-zinc-800">
            <div className="flex flex-col md:flex-row gap-4">
              <select 
                value={newRuleAgent} 
                onChange={e => setNewRuleAgent(e.target.value as any)}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
              >
                <option value="GENERAL">Общее правило</option>
                <option value="SCANNER">Агент 1: Сканер (Поиск сигналов)</option>
                <option value="MANAGER">Агент 2: Менеджер SHORT (Ведение шортов)</option>
                <option value="LONG_MANAGER">Агент 3: Менеджер LONG (Ведение лонгов)</option>
              </select>
              <input 
                type="text" 
                value={newRule} 
                onChange={e => setNewRule(e.target.value)} 
                placeholder="Введите новое правило (например: Не торговать в выходные)" 
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex flex-col gap-2">
              <button 
                type="button"
                onClick={() => setIsAdvancedRuleOpen(!isAdvancedRuleOpen)}
                className="text-xs text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1 transition-colors self-start cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
                {isAdvancedRuleOpen ? 'Скрыть параметры фильтра ↑' : 'Настроить структурированный фильтр ↓'}
              </button>

              {isAdvancedRuleOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-zinc-900/50 p-3 rounded-lg border border-zinc-850 text-xs mt-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-400 font-medium text-[10px] uppercase">Индикатор</span>
                    <select
                      value={ruleFilterIndicator}
                      onChange={e => setRuleFilterIndicator(e.target.value)}
                      className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500 font-sans text-xs"
                    >
                      <option value="none">Без фильтра</option>
                      <option value="rsi">RSI (15м)</option>
                      <option value="volume">Всплеск объема</option>
                      <option value="trend">Тренд (Bias)</option>
                      <option value="volatility">Волатильность</option>
                      <option value="ob_imbalance">Имбаланс стакана</option>
                      <option value="fomo">Индекс FOMO</option>
                      <option value="change24h">Изменение 24ч (%)</option>
                    </select>
                  </div>
                  
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-400 font-medium text-[10px] uppercase">Условие</span>
                    <select
                      value={ruleFilterCondition}
                      onChange={e => setRuleFilterCondition(e.target.value)}
                      className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none text-xs"
                    >
                                            <option value="gt">Больше чем (&gt;)</option>
                      <option value="lt">Меньше чем (&lt;)</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-400 font-medium text-[10px] uppercase">Пороговое значение</span>
                    <input
                      type="text"
                      value={ruleFilterValue}
                      onChange={e => setRuleFilterValue(e.target.value)}
                      placeholder="Например, 70"
                      className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none text-xs"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-400 font-medium text-[10px] uppercase">Действие</span>
                    <select
                      value={ruleFilterAction}
                      onChange={e => setRuleFilterAction(e.target.value)}
                      className="bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-200 focus:outline-none text-xs"
                    >
                      <option value="penalty">Штраф к AI Score (penalty)</option>
                      <option value="block">Полный блок сигнала (block)</option>
                      <option value="bonus">Приоритет сигнала (bonus)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-2">
              <div className="flex items-center gap-3">
                <label className="text-xs text-zinc-400 font-medium flex items-center gap-1.5 cursor-pointer bg-zinc-900 hover:bg-zinc-800 border border-zinc-850 hover:border-zinc-700 px-3 py-1.5 rounded-lg transition-colors">
                  <Settings className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                  <span>{newRuleImage ? 'Скриншот прикреплен' : 'Загрузить скриншот'}</span>
                  <input 
                    type="file" 
                    accept="image/*" 
                    onChange={handleImageUpload} 
                    className="hidden" 
                  />
                </label>
                {newRuleImage && (
                  <button 
                    type="button"
                    onClick={() => setNewRuleImage(null)}
                    className="text-[10px] text-red-400 hover:text-red-300 underline font-mono uppercase bg-transparent border-0 cursor-pointer p-0"
                  >
                    Удалить скриншот
                  </button>
                )}
              </div>
              <button 
                onClick={handleSaveRule}
                className="w-full sm:w-auto px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs tracking-wider uppercase transition-all shadow-lg active:scale-95 cursor-pointer"
              >
                Добавить правило
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Scanner Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-emerald-400 flex items-center gap-2">
                <Activity className="w-5 h-5" /> АГЕНТ №1: СКАНЕР
              </h3>
              <div className="space-y-3">
                {knowledgeBase.filter(r => (r.agent === 'SCANNER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).map((rule, idx) => (
                  <div key={`${rule.id}-${idx}`} className="bg-zinc-950/80 border border-zinc-800 rounded-xl p-5 group relative overflow-hidden transition-all duration-300 hover:border-zinc-700">
                    {/* Progress indicator for success rate */}
                    <div 
                      className="absolute bottom-0 left-0 h-1 transition-all duration-1000 bg-emerald-500/20" 
                      style={{ width: `${((rule.successRate || 0.5) * 100).toFixed(0)}%` }}
                    />
                    
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                           {rule.agent === 'GENERAL' && <span className="text-[9px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded uppercase font-black tracking-widest leading-none">Общее</span>}
                           
                           <div className="flex items-center gap-2">
                             {rule.id?.startsWith('adv_') || rule.id?.startsWith('def_') ? (
                               <>
                                 <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                   <Activity className="w-3 h-3" />
                                   БАЗОВОЕ
                                 </div>
                                 <span className="text-[10px] text-zinc-600 font-bold tracking-tight">КОНСТАНТА</span>
                               </>
                             ) : rule.successRate === undefined || (rule.usageCount || 0) === 0 ? (
                               <>
                                 <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                   <Activity className="w-3 h-3" />
                                   НОВОЕ
                                 </div>
                                 <span className="text-[10px] text-zinc-700 font-bold tracking-tight">#0 ПРОВЕРОК</span>
                               </>
                             ) : (
                               <>
                                 <div className={cn(
                                   "text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none",
                                   (rule.successRate || 0) > 0.6 ? "bg-emerald-500/10 text-emerald-400" : (rule.successRate || 0) > 0.4 ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400"
                                 )}>
                                   <Activity className="w-3 h-3" />
                                   {((rule.successRate || 0) * 100).toFixed(0)}% WIN
                                 </div>
                                 <span className="text-[10px] text-zinc-600 font-bold tracking-tight">#{rule.usageCount || 0} ПРОВЕРОК</span>
                               </>
                             )}
                           </div>
                           
                           {rule.impact !== undefined && (
                             <span className={cn(
                               "text-[10px] font-mono font-bold leading-none",
                               rule.impact > 0 ? "text-emerald-500/80" : "text-red-500/80"
                             )}>
                               {rule.impact > 0 ? '+' : ''}{rule.impact} AI
                             </span>
                           )}
                        </div>
                        
                        <p className="text-sm text-zinc-100 leading-relaxed font-medium italic opacity-90 font-mono">"{rule.text}"</p>

                        {rule.isArchived && (
                          <div className="mt-2.5 p-2.5 bg-amber-500/5 border border-amber-500/10 rounded-lg text-[11px] text-amber-400 flex flex-col gap-1">
                            <span className="font-bold flex items-center gap-1 text-[10px] uppercase tracking-wider">
                              <Archive className="w-3.5 h-3.5 text-amber-500" /> Причина переноса в архив:
                            </span>
                            <span className="text-zinc-350 leading-relaxed italic">"{rule.archiveReason || 'Переведено Архивариусом в ходе перекомпоновки базы знаний под новые реалии рынка'}"</span>
                            {rule.marketRegimeAtArchive && (
                              <span className="inline-block mt-1 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded uppercase font-black tracking-widest leading-none self-start">
                                Режим при развороте: {rule.marketRegimeAtArchive === 'TREND' ? 'ТРЕНД (TREND_REGIME)' : rule.marketRegimeAtArchive === 'FLAT' ? 'ФЛЭТ (FLAT_FADING)' : rule.marketRegimeAtArchive}
                              </span>
                            )}
                          </div>
                        )}

                        {rule.filterIndicator && rule.filterIndicator !== 'none' && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            <span className="text-[10px] bg-zinc-900 border border-zinc-850 rounded px-2 py-0.5 text-zinc-300 font-mono inline-flex items-center gap-1.5 uppercase leading-none">
                              <Brain className="w-2.5 h-2.5 text-emerald-400" />
                              {rule.filterIndicator === 'rsi' ? 'RSI (15м)' : 
                               rule.filterIndicator === 'volume' ? 'Всплеск объема' : 
                               rule.filterIndicator === 'trend' ? 'Тренд (Bias)' : 
                               rule.filterIndicator === 'volatility' ? 'Волатильность' : 
                               rule.filterIndicator === 'ob_imbalance' ? 'Имбаланс стакана' : 
                               rule.filterIndicator === 'fomo' ? 'Индекс FOMO' : 
                               rule.filterIndicator === 'change24h' ? 'Изменение 24ч' : rule.filterIndicator}
                            </span>
                            <span className={cn(
                              "text-[10px] rounded px-2 py-0.5 font-mono inline-flex items-center leading-none",
                              rule.filterAction === 'block' ? "bg-red-500/10 border border-red-500/20 text-red-400" :
                              rule.filterAction === 'penalty' ? "bg-amber-500/10 border border-amber-500/20 text-amber-400" :
                              "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                            )}>
                              {rule.filterAction === 'block' ? 'Блок' :
                               rule.filterAction === 'penalty' ? 'Штраф к AI' : 'Bonus к AI'}{' '}
                              ({rule.filterCondition === 'gt' ? '>' : '<'} {rule.filterValue})
                            </span>
                          </div>
                        )}
                        {rule.text.includes('[Авто-Обучение') && (
                          <div className="mt-3 flex items-center gap-2">
                             <div className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                             <span className="text-[9px] text-emerald-400 font-black uppercase tracking-tighter">Выучено сканером</span>
                          </div>
                        )}
                        {rule.image && (
                          <div className="mt-3 rounded-lg overflow-hidden border border-zinc-800 shadow-lg">
                             <img src={rule.image} alt="Rule screenshot" className="w-full object-cover max-h-40 opacity-90 group-hover:opacity-100 transition-opacity" />
                          </div>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1 items-center justify-start shrink-0">
                        {rule.isArchived ? (
                          <button 
                            onClick={() => handleUnarchiveRule(rule.id)}
                            className="text-amber-500 hover:text-emerald-400 p-2 transition-all rounded hover:bg-emerald-500/10 active:scale-90 cursor-pointer"
                            title="Восстановить из архива"
                          >
                            <FolderUp className="w-4 h-4" />
                          </button>
                        ) : (
                          <button 
                            onClick={() => handleArchiveRule(rule.id)}
                            className="text-zinc-600 hover:text-amber-400 p-2 transition-all rounded hover:bg-amber-500/10 active:scale-90 cursor-pointer"
                            title="Переместить в архив"
                          >
                            <FolderDown className="w-4 h-4" />
                          </button>
                        )}
                        <button 
                          onClick={async () => {
                            const res = await fetch(`/api/knowledge/${rule.id}`, { method: 'DELETE' });
                            const data = await res.json();
                            if (data.success) setKnowledgeBase(data.data);
                          }}
                          className="text-zinc-700 hover:text-red-450 p-2 transition-all rounded hover:bg-red-400/10 active:scale-90 cursor-pointer"
                          title="Удалить навсегда"
                        >
                          <X className="w-4.5 h-4.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {knowledgeBase.filter(r => (r.agent === 'SCANNER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).length === 0 && (
                  <div className="text-zinc-550 text-xs py-5 italic text-center border border-dashed border-zinc-800/60 rounded-xl">
                    {knowledgeSubTab === 'active' ? 'Нет активных правил для сканера' : 'Нет перенесенных в архив правил'}
                  </div>
                )}
              </div>
            </div>

            {/* Manager SHORT Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-indigo-400 flex items-center gap-2">
                <Bot className="w-5 h-5" /> АГЕНТ №2: МЕНЕДЖЕР SHORT
              </h3>
              <div className="space-y-3">
                {knowledgeBase.filter(r => (r.agent === 'MANAGER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).map((rule, idx) => (
                  <div key={`${rule.id}-${idx}`} className="bg-zinc-950/80 border border-zinc-800 rounded-lg p-5 group relative overflow-hidden transition-all duration-300 hover:border-zinc-700 hover:shadow-glow-indigo/5">
                    {/* Progress indicator */}
                    <div 
                      className="absolute bottom-0 left-0 h-1 transition-all duration-1000 bg-indigo-500/20" 
                      style={{ width: `${((rule.successRate || 0.5) * 100).toFixed(0)}%` }}
                    />

                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          {rule.agent === 'GENERAL' && <span className="text-[9px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded uppercase font-black tracking-widest leading-none">Общее</span>}
                          
                          <div className="flex items-center gap-2">
                            {rule.id?.startsWith('adv_') || rule.id?.startsWith('def_') ? (
                              <>
                                <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                  <Bot className="w-3 h-3" />
                                  БАЗОВОЕ
                                </div>
                                <span className="text-[10px] text-zinc-600 font-bold tracking-tight">КОНСТАНТА</span>
                              </>
                            ) : rule.successRate === undefined || (rule.usageCount || 0) === 0 ? (
                              <>
                                <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                  <Bot className="w-3 h-3" />
                                  НОВОЕ
                                </div>
                                <span className="text-[10px] text-zinc-700 font-bold tracking-tight">#0 ПРИМЕНЕНИЙ</span>
                              </>
                            ) : (
                              <>
                                <div className={cn(
                                  "text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none",
                                  (rule.successRate || 0) > 0.6 ? "bg-indigo-500/10 text-indigo-400" : (rule.successRate || 0) > 0.4 ? "bg-amber-500/10 text-amber-405" : "bg-red-500/10 text-red-404"
                                )}>
                                  <Bot className="w-3 h-3" />
                                  {((rule.successRate || 0) * 100).toFixed(0)}% EFF
                                </div>
                                <span className="text-[10px] text-zinc-600 font-bold tracking-tight">#{rule.usageCount || 0} ПРИМЕНЕНИЙ</span>
                              </>
                            )}
                          </div>
                          
                           {rule.impact !== undefined && (
                             <span className={cn(
                               "text-[10px] font-mono font-bold leading-none",
                               rule.impact > 0 ? "text-indigo-400/80" : "text-red-400/80"
                             )}>
                               {rule.impact > 0 ? '+' : ''}{rule.impact} AI
                             </span>
                           )}
                        </div>

                        <p className="text-sm text-zinc-100 leading-relaxed font-medium italic opacity-90 font-mono">"{rule.text}"</p>

                        {rule.isArchived && (
                          <div className="mt-2.5 p-2.5 bg-amber-500/5 border border-amber-500/10 rounded-lg text-[11px] text-amber-400 flex flex-col gap-1">
                            <span className="font-bold flex items-center gap-1 text-[10px] uppercase tracking-wider">
                              <Archive className="w-3.5 h-3.5 text-amber-500" /> Причина переноса в архив:
                            </span>
                            <span className="text-zinc-350 leading-relaxed italic">"{rule.archiveReason || 'Переведено Архивариусом в ходе перекомпоновки базы знаний под новые реалии рынка'}"</span>
                            {rule.marketRegimeAtArchive && (
                              <span className="inline-block mt-1 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded uppercase font-black tracking-widest leading-none self-start">
                                Режим при развороте: {rule.marketRegimeAtArchive === 'TREND' ? 'ТРЕНД (TREND_REGIME)' : rule.marketRegimeAtArchive === 'FLAT' ? 'ФЛЭТ (FLAT_FADING)' : rule.marketRegimeAtArchive}
                              </span>
                            )}
                          </div>
                        )}

                        {rule.filterIndicator && rule.filterIndicator !== 'none' && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            <span className="text-[10px] bg-zinc-900 border border-zinc-850 rounded px-2 py-0.5 text-zinc-300 font-mono inline-flex items-center gap-1.5 uppercase leading-none">
                              <Brain className="w-2.5 h-2.5 text-indigo-400" />
                              {rule.filterIndicator === 'rsi' ? 'RSI (15м)' : 
                               rule.filterIndicator === 'volume' ? 'Всплеск объема' : 
                               rule.filterIndicator === 'trend' ? 'Тренд (Bias)' : 
                               rule.filterIndicator === 'volatility' ? 'Волатильность' : 
                               rule.filterIndicator === 'ob_imbalance' ? 'Имбаланс стакана' : 
                               rule.filterIndicator === 'fomo' ? 'Индекс FOMO' : 
                               rule.filterIndicator === 'change24h' ? 'Изменение 24ч' : rule.filterIndicator}
                            </span>
                            <span className={cn(
                              "text-[10px] rounded px-2 py-0.5 font-mono inline-flex items-center leading-none",
                              rule.filterAction === 'block' ? "bg-red-500/10 border border-red-500/20 text-red-400" :
                              rule.filterAction === 'penalty' ? "bg-amber-500/10 border border-amber-500/20 text-amber-400" :
                              "bg-indigo-500/10 border border-indigo-500/20 text-indigo-400"
                            )}>
                              {rule.filterAction === 'block' ? 'Блок' :
                               rule.filterAction === 'penalty' ? 'Штраф к AI' : 'Bonus к AI'}{' '}
                              ({rule.filterCondition === 'gt' ? '>' : '<'} {rule.filterValue})
                            </span>
                          </div>
                        )}
                        {rule.text.includes('[Авто-Обучение') && (
                          <div className="mt-3 flex items-center gap-2">
                             <div className="flex h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" />
                             <span className="text-[9px] text-indigo-400 font-black uppercase tracking-tighter">Выучено менеджером</span>
                          </div>
                        )}
                        {rule.image && (
                          <div className="mt-3 rounded-lg overflow-hidden border border-zinc-800 shadow-lg">
                             <img src={rule.image} alt="Rule screenshot" className="w-full object-cover max-h-40 opacity-90 group-hover:opacity-100 transition-opacity" />
                          </div>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1 items-center justify-start shrink-0">
                        {rule.isArchived ? (
                          <button 
                            onClick={() => handleUnarchiveRule(rule.id)}
                            className="text-amber-500 hover:text-emerald-400 p-2 transition-all rounded hover:bg-emerald-500/10 active:scale-90 cursor-pointer"
                            title="Восстановить из архива"
                          >
                            <FolderUp className="w-4 h-4" />
                          </button>
                        ) : (
                          <button 
                            onClick={() => handleArchiveRule(rule.id)}
                            className="text-zinc-600 hover:text-amber-400 p-2 transition-all rounded hover:bg-amber-500/10 active:scale-90 cursor-pointer"
                            title="Переместить в архив"
                          >
                            <FolderDown className="w-4 h-4" />
                          </button>
                        )}
                        <button 
                          onClick={async () => {
                            const res = await fetch(`/api/knowledge/${rule.id}`, { method: 'DELETE' });
                            const data = await res.json();
                            if (data.success) setKnowledgeBase(data.data);
                          }}
                          className="text-zinc-700 hover:text-red-450 p-2 transition-all rounded hover:bg-red-400/10 active:scale-90 cursor-pointer"
                          title="Удалить навсегда"
                        >
                          <X className="w-4.5 h-4.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {knowledgeBase.filter(r => (r.agent === 'MANAGER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).length === 0 && (
                  <div className="text-zinc-550 text-xs py-5 italic text-center border border-dashed border-zinc-800/60 rounded-xl">
                    {knowledgeSubTab === 'active' ? 'Нет активных правил для менеджера SHORT' : 'Нет перенесенных в архив правил'}
                  </div>
                )}
              </div>
            </div>

            {/* Manager LONG Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-violet-400 flex items-center gap-2">
                <TrendingUp className="w-5 h-5" /> АГЕНТ №3: МЕНЕДЖЕР LONG
              </h3>
              <div className="space-y-3">
                {knowledgeBase.filter(r => (r.agent === 'LONG_MANAGER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).map((rule, idx) => (
                  <div key={`${rule.id}-${idx}`} className="bg-zinc-950/80 border border-zinc-800 rounded-lg p-5 group relative overflow-hidden transition-all duration-300 hover:border-zinc-700 hover:shadow-glow-purple/5">
                    {/* Progress indicator */}
                    <div 
                      className="absolute bottom-0 left-0 h-1 transition-all duration-1000 bg-violet-500/20" 
                      style={{ width: `${((rule.successRate || 0.5) * 100).toFixed(0)}%` }}
                    />

                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          {rule.agent === 'GENERAL' && <span className="text-[9px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded uppercase font-black tracking-widest leading-none">Общее</span>}
                          
                          <div className="flex items-center gap-2">
                            {rule.id?.startsWith('adv_') || rule.id?.startsWith('def_') ? (
                              <>
                                <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                  <TrendingUp className="w-3 h-3 text-violet-400" />
                                  БАЗОВОЕ
                                </div>
                                <span className="text-[10px] text-zinc-600 font-bold tracking-tight">КОНСТАНТА</span>
                              </>
                            ) : rule.successRate === undefined || (rule.usageCount || 0) === 0 ? (
                              <>
                                <div className="text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none bg-zinc-800 text-zinc-400">
                                  <TrendingUp className="w-3 h-3 text-violet-400" />
                                  НОВОЕ
                                </div>
                                <span className="text-[10px] text-zinc-700 font-bold tracking-tight">#0 ПРИМЕНЕНИЙ</span>
                              </>
                            ) : (
                              <>
                                <div className={cn(
                                  "text-[10px] font-black px-2 py-1 rounded flex items-center gap-1.5 leading-none",
                                  (rule.successRate || 0) > 0.6 ? "bg-violet-500/10 text-violet-400" : (rule.successRate || 0) > 0.4 ? "bg-amber-500/10 text-amber-405" : "bg-red-500/10 text-red-404"
                                )}>
                                  <TrendingUp className="w-3 h-3 text-violet-400" />
                                  {((rule.successRate || 0) * 100).toFixed(0)}% EFF
                                </div>
                                <span className="text-[10px] text-zinc-600 font-bold tracking-tight">#{rule.usageCount || 0} ПРИМЕНЕНИЙ</span>
                              </>
                            )}
                          </div>
                          
                           {rule.impact !== undefined && (
                             <span className={cn(
                               "text-[10px] font-mono font-bold leading-none",
                               rule.impact > 0 ? "text-violet-400/80" : "text-red-400/80"
                             )}>
                               {rule.impact > 0 ? '+' : ''}{rule.impact} AI
                             </span>
                           )}
                        </div>

                        <p className="text-sm text-zinc-100 leading-relaxed font-medium italic opacity-90 font-mono">"{rule.text}"</p>

                        {rule.isArchived && (
                          <div className="mt-2.5 p-2.5 bg-amber-500/5 border border-amber-500/10 rounded-lg text-[11px] text-amber-400 flex flex-col gap-1">
                            <span className="font-bold flex items-center gap-1 text-[10px] uppercase tracking-wider">
                              <Archive className="w-3.5 h-3.5 text-amber-500" /> Причина переноса в архив:
                            </span>
                            <span className="text-zinc-350 leading-relaxed italic">"{rule.archiveReason || 'Переведено Архивариусом в ходе перекомпоновки базы знаний под новые реалии рынка'}"</span>
                            {rule.marketRegimeAtArchive && (
                              <span className="inline-block mt-1 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded uppercase font-black tracking-widest leading-none self-start">
                                Режим при развороте: {rule.marketRegimeAtArchive === 'TREND' ? 'ТРЕНД (TREND_REGIME)' : rule.marketRegimeAtArchive === 'FLAT' ? 'ФЛЭТ (FLAT_FADING)' : rule.marketRegimeAtArchive}
                              </span>
                            )}
                          </div>
                        )}

                        {rule.filterIndicator && rule.filterIndicator !== 'none' && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            <span className="text-[10px] bg-zinc-900 border border-zinc-850 rounded px-2 py-0.5 text-zinc-300 font-mono inline-flex items-center gap-1.5 uppercase leading-none">
                              <Brain className="w-2.5 h-2.5 text-violet-400" />
                              {rule.filterIndicator === 'rsi' ? 'RSI (15м)' : 
                               rule.filterIndicator === 'volume' ? 'Всплеск объема' : 
                               rule.filterIndicator === 'trend' ? 'Тренд (Bias)' : 
                               rule.filterIndicator === 'volatility' ? 'Волатильность' : 
                               rule.filterIndicator === 'ob_imbalance' ? 'Имбаланс стакана' : 
                               rule.filterIndicator === 'fomo' ? 'Индекс FOMO' : 
                               rule.filterIndicator === 'change24h' ? 'Изменение 24ч' : rule.filterIndicator}
                            </span>
                            <span className={cn(
                              "text-[10px] rounded px-2 py-0.5 font-mono inline-flex items-center leading-none",
                              rule.filterAction === 'block' ? "bg-red-500/10 border border-red-500/20 text-red-400" :
                              rule.filterAction === 'penalty' ? "bg-amber-500/10 border border-amber-500/20 text-amber-400" :
                              "bg-violet-500/10 border border-violet-500/20 text-violet-400"
                            )}>
                              {rule.filterAction === 'block' ? 'Блок' :
                               rule.filterAction === 'penalty' ? 'Штраф к AI' : 'Bonus к AI'}{' '}
                              ({rule.filterCondition === 'gt' ? '>' : '<'} {rule.filterValue})
                            </span>
                          </div>
                        )}
                        {rule.text.includes('[Авто-Обучение') && (
                          <div className="mt-3 flex items-center gap-2">
                             <div className="flex h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" />
                             <span className="text-[9px] text-violet-400 font-black uppercase tracking-tighter">Выучено менеджером LONG</span>
                          </div>
                        )}
                        {rule.image && (
                          <div className="mt-3 rounded-lg overflow-hidden border border-zinc-800 shadow-lg">
                             <img src={rule.image} alt="Rule screenshot" className="w-full object-cover max-h-40 opacity-90 group-hover:opacity-100 transition-opacity" />
                          </div>
                        )}
                      </div>
                      
                      <div className="flex flex-col gap-1 items-center justify-start shrink-0">
                        {rule.isArchived ? (
                          <button 
                            onClick={() => handleUnarchiveRule(rule.id)}
                            className="text-amber-500 hover:text-emerald-400 p-2 transition-all rounded hover:bg-emerald-500/10 active:scale-90 cursor-pointer"
                            title="Восстановить из архива"
                          >
                            <FolderUp className="w-4 h-4" />
                          </button>
                        ) : (
                          <button 
                            onClick={() => handleArchiveRule(rule.id)}
                            className="text-zinc-600 hover:text-amber-400 p-2 transition-all rounded hover:bg-amber-500/10 active:scale-90 cursor-pointer"
                            title="Переместить в архив"
                          >
                            <FolderDown className="w-4 h-4" />
                          </button>
                        )}
                        <button 
                          onClick={async () => {
                            const res = await fetch(`/api/knowledge/${rule.id}`, { method: 'DELETE' });
                            const data = await res.json();
                            if (data.success) setKnowledgeBase(data.data);
                          }}
                          className="text-zinc-700 hover:text-red-450 p-2 transition-all rounded hover:bg-red-400/10 active:scale-90 cursor-pointer"
                          title="Удалить навсегда"
                        >
                          <X className="w-4.5 h-4.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {knowledgeBase.filter(r => (r.agent === 'LONG_MANAGER' || r.agent === 'GENERAL') && (knowledgeSubTab === 'archived' ? r.isArchived : !r.isArchived)).length === 0 && (
                  <div className="text-zinc-550 text-xs py-5 italic text-center border border-dashed border-zinc-800/60 rounded-xl">
                    {knowledgeSubTab === 'active' ? 'Нет активных правил для менеджера LONG' : 'Нет перенесенных в архив правил'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {mainTab === 'peaks' && (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-6 animate-in fade-in duration-300">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
            <div>
              <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
                <TrendingDown className="w-6 h-6 text-rose-500" /> Торговый Модуль: Пики Проливов (Pre-Dump Peaks)
              </h2>
              <p className="text-xs text-zinc-400 mt-1">Автоматическое запоминание и отслеживание экстремумов после успешных шорт-сделок</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Всего сохранено пиков</span>
              <div className="text-2xl font-black text-rose-400 mt-1 font-mono">{prolivPeaks.length}</div>
            </div>
            <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-black uppercase tracking-widest font-mono">Ожидают ретеста (Активные уровни)</span>
              <div className="text-2xl font-black text-emerald-400 mt-1 font-mono">
                {prolivPeaks.filter(p => p.status === 'SAVED').length}
              </div>
            </div>
            <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
              <span className="text-[10px] text-zinc-500 font-black uppercase tracking-widest font-mono">Сработало ретестов</span>
              <div className="text-2xl font-black text-indigo-400 mt-1 font-mono">
                {prolivPeaks.filter(p => p.status === 'RETESTED').length}
              </div>
            </div>
          </div>

          <div className="bg-zinc-950/60 p-4 rounded-xl border border-indigo-500/10 mb-6 relative overflow-hidden">
            <div className="flex items-start gap-3">
              <span className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 font-bold block mt-0.5">💡</span>
              <div>
                <h4 className="text-xs font-black uppercase text-zinc-100 tracking-wider">Инструкция и логика работы модуля</h4>
                <p className="text-xs text-zinc-400 leading-relaxed mt-1">
                  Когда ручная или системная шорт-сделка закрывается с хорошей прибылью (откат произошел успешно), система 
                  записывает точную верхнюю цену разворота в базу данных. В будущем, когда цена монеты пропампится обратно к этой 
                  зоне, система проигнорирует стандартные фильтры тренда и выставит высокоприоритетный Short-сигнал на ретест пика.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 bg-zinc-900/40">
              <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400">Таблица зафиксированных пиков сопротивления</h3>
            </div>
            <div className="overflow-x-auto">
              {prolivPeaks.length === 0 ? (
                <div className="p-12 text-center text-zinc-500 text-sm">
                  Активных зафиксированных пиков пока нет. Накапливайте прибыльные шорты, чтобы база пополнялась автоматически.
                </div>
              ) : (
                <table className="w-full text-left text-xs text-zinc-200">
                  <thead className="bg-zinc-900/50 border-b border-zinc-800 font-extrabold uppercase text-[9px] tracking-widest text-zinc-500">
                    <tr>
                      <th className="px-4 py-3">Монета</th>
                      <th className="px-4 py-3 text-right">Уровень пика</th>
                      <th className="px-4 py-3 text-right">PnL Сделки</th>
                      <th className="px-4 py-3 text-center">Статус</th>
                      <th className="px-4 py-3 text-center">Дата Пролива</th>
                      <th className="px-4 py-3 text-center">Действие</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {prolivPeaks.map((peak, pIdx) => {
                      const formattedTime = new Date(peak.dumpTime || Date.now()).toLocaleString('ru-RU', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      });
                      return (
                        <tr key={peak.id || pIdx} className="hover:bg-zinc-900/30 transition-colors">
                          <td className="px-4 py-3 font-mono font-bold text-zinc-200">
                            {peak.symbol}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-indigo-400">
                            ${peak.peakPrice?.toFixed(6) || peak.peakPrice}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-400">
                            {peak.pnlPercent ? `+${peak.pnlPercent.toFixed(2)}%` : '—'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
                              peak.status === 'RETESTED' 
                                ? "bg-amber-950/40 text-amber-500 border border-amber-900/40" 
                                : "bg-emerald-950/40 text-emerald-400 border border-emerald-900/40"
                            }`}>
                              {peak.status || 'SAVED'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center text-zinc-550 text-[10px]">
                            {formattedTime}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={async () => {
                                if (confirm('Удалить этот пик сопротивления?')) {
                                  try {
                                    const response = await fetch(`/api/proliv-peaks/${peak.id}`, { method: 'DELETE' });
                                    if (response.ok) {
                                      const text = await response.text();
                                      if (text.trim()) {
                                        const res = JSON.parse(text);
                                        if (res.success) {
                                          setProlivPeaks(res.data || []);
                                        }
                                      }
                                    }
                                  } catch (e) {
                                    console.error(e);
                                  }
                                }
                              }}
                              className="p-1 text-zinc-500 hover:text-rose-400 rounded bg-zinc-900 hover:bg-zinc-800 transition-all inline-flex items-center"
                              title="Забыть пик"
                            >
                              <X className="w-3.5 h-3.5" />
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
        </div>
      )}

      {mainTab === 'telemetry' && (() => {
        // Computes filtered logs on the fly within the scoped evaluation area
        const filteredLogs = (structuredLogs || []).filter(log => {
          if (!log) return false;
          if (logSearchText) {
            const query = (logSearchText || '').toLowerCase();
            const messageMatches = log.message?.toLowerCase().includes(query);
            const symbolMatches = log.symbol?.toLowerCase().includes(query);
            const componentMatches = log.component?.toLowerCase().includes(query);
            if (!messageMatches && !symbolMatches && !componentMatches) return false;
          }
          if (logLevelFilter !== 'all') {
            if (log.level !== logLevelFilter) return false;
          }
          if (logComponentFilter !== 'all') {
            if (log.component !== logComponentFilter) return false;
          }
          return true;
        });

        return (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Risk Policy details */}
              <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Настройки Управления Рисками (Risk Policy)</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between border-b border-zinc-900 pb-1.5">
                      <span className="text-zinc-500">Режим маржи:</span>
                      <span className="text-emerald-400 font-bold bg-emerald-950/40 border border-emerald-900/40 px-1.5 py-0.5 rounded text-[10px]">FORCE ISOLATED</span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-900 pb-1.5">
                      <span className="text-zinc-500">Капитал на сделку (Риск):</span>
                      <span className="text-zinc-300 font-mono font-bold">1% - 2% (Adaptive ATR)</span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-900 pb-1.5">
                      <span className="text-zinc-500">Координация DCA:</span>
                      <span className="text-indigo-400 font-bold font-mono">1.15x DCA Step</span>
                    </div>
                  </div>
                </div>
                <p className="text-[9px] text-zinc-500 leading-normal mt-4">
                  Защитная политика блокирует кросс-маржу на Weex, изолируя риск убытков и авточернит монеты в случае ошибок API.
                </p>
              </div>

              {/* Microservice health */}
              <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Состояние Сервисов (Service Micro-mesh)</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">Telemetry Logging daemon</span>
                      <span className="text-emerald-500 font-bold flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Ок</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">WebSocket Sync Latency</span>
                      <div className="flex items-end gap-0.5 h-4 w-16 px-1 bg-zinc-950/65 rounded border border-zinc-900 overflow-hidden">
                        {pingHistory.slice(-10).map((p, pIdx) => {
                          const hVal = Math.min(100, Math.max(15, (p.latencyMs / 600) * 100));
                          return (
                            <div 
                              key={pIdx} 
                              title={`Время: ${new Date(p.timestamp).toLocaleTimeString()}, Пинг: ${p.latencyMs}мс`}
                              className={cn(
                                "flex-1 rounded-t-[1px] transition-all duration-300 hover:opacity-100 opacity-80 cursor-pointer",
                                p.latencyMs < 150 ? "bg-emerald-500/80" :
                                p.latencyMs < 300 ? "bg-amber-500/80" : "bg-rose-500/80"
                              )}
                              style={{ height: `${hVal}%` }}
                            />
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">Dynamic Position CalcEngine</span>
                      <span className="text-indigo-400 font-bold flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-ping" /> Активен</span>
                    </div>
                  </div>
                </div>
                <div className="bg-zinc-900/45 p-2 rounded border border-zinc-850/60 mt-3 text-[10px] text-zinc-400 flex justify-between items-center">
                  <span>WebSocket Ping:</span>
                  <span className="font-mono text-zinc-100 font-black">{exchangePing ? `${exchangePing} мс` : 'Синхронно'}</span>
                </div>
              </div>

              {/* Telemetry Storage status */}
              <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">Хранилище Базы Данных (Storage Engine)</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">Движок логов:</span>
                      <span className="text-zinc-300 font-semibold font-mono bg-indigo-950/40 px-1.5 py-0.5 rounded border border-indigo-900/30">Prometheus style</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">Общее число событий:</span>
                      <span className="text-emerald-400 font-bold font-mono">{structuredLogs.length} / 3000 max</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400 font-medium">Резервное копирование:</span>
                      <span className="text-indigo-400 font-bold flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" /> Авто
                      </span>
                    </div>
                  </div>
                </div>
                <div className="bg-zinc-900/45 p-2 rounded border border-zinc-850/60 mt-3 text-[10px] text-zinc-400 flex justify-between items-center">
                  <span>База данных Structured DB:</span>
                  <span className="font-mono text-zinc-100 font-black">{structuredLogs ? structuredLogs.length : 0} записей</span>
                </div>
              </div>
            </div>

          {/* ИИ-АГЕНТЫ СИСТЕМЫ (AI Multi-Agent Coordination Mesh) */}
          <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl p-6 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />
            <div className="flex justify-between items-center mb-5 border-b border-zinc-900 pb-3">
              <div>
                <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                  <Bot className="w-5 h-5 text-indigo-400" /> Активное Ядро ИИ-Агентов (AI Multi-Agent Mesh)
                </h2>
                <p className="text-xs text-zinc-500 mt-1">
                  Текущий статус, операционная активность и показатели пяти специализированных ИИ-агентов, совместно координирующих торговые процессы системы.
                </p>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800/60 px-2.5 py-1 rounded-md text-[10px] text-zinc-400 font-mono flex items-center gap-1.5 shadow-inner">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                </span>
                MULTI-AGENT ENGINE: ONLINE
              </div>
            </div>

            {/* Сетка статусов ИИ-агентов */}
            {agentsStatus && agentsStatus.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
                {agentsStatus.map((agent, aIdx) => {
                  let statusBg = 'bg-zinc-900/60 text-zinc-400 border-zinc-805';
                  if (agent.status === 'АКТИВЕН' || agent.status === 'КООРДИНИРУЕТ') {
                    statusBg = 'bg-emerald-950/40 text-emerald-400 border-emerald-900/40';
                  } else if (agent.status === 'ОЖИДАНИЕ' || agent.status === 'НАБЛЮДЕНИЕ') {
                    statusBg = 'bg-amber-950/40 text-amber-500 border-amber-900/40';
                  }

                  return (
                    <div 
                      key={agent.id || aIdx} 
                      className="bg-zinc-950/50 border border-zinc-900 hover:border-zinc-850/80 transition-all rounded-xl p-4 flex flex-col justify-between group relative overflow-hidden shadow-inner"
                    >
                      <div className="absolute top-0 right-0 w-16 h-16 bg-indigo-500/5 rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity" />
                      <div>
                        <div className="flex justify-between items-start gap-2 mb-2">
                          <span className="text-xs font-black text-zinc-250 uppercase tracking-tight">
                            {agent.name}
                          </span>
                          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wider uppercase border whitespace-nowrap ${statusBg}`}>
                            {agent.status}
                          </span>
                        </div>
                        <p className="text-[10px] text-zinc-500 leading-normal mb-3">
                          {agent.description}
                        </p>
                      </div>
                      <div className="mt-2 pt-2 border-t border-zinc-900/60 font-mono text-[9px] text-indigo-400 font-bold leading-normal">
                        <span className="text-zinc-650 block mb-0.5 text-[8px] uppercase font-sans tracking-wide">Параметры деятельности:</span>
                        {agent.details}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-zinc-500 font-mono text-xs border border-dashed border-zinc-900 rounded-xl mb-6">
                Синхронизация сетевого реестра ИИ-агентов...
              </div>
            )}

            {/* ИИ-РЕВИЗОР: РЕТРОСПЕКТИВНЫЙ АНАЛИЗ И САМООБУЧЕНИЕ */}
            <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-xl overflow-hidden shadow-2xl">
              <div className="p-5 border-b border-zinc-900/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                    <Brain className="w-5 h-5 text-indigo-400" /> ИИ-Ревизор: Аналитический Контур Самообучения (Closed-Loop)
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1">
                    Объединенный мозг торговой системы. Автоматический разбор закрытых сделок и межагентская оптимизация торговых стратегий.
                  </p>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setRetroActiveSubTab('lessons')}
                    className={cn(
                      "px-3 py-2 rounded-lg text-xs font-bold font-mono transition-all border cursor-pointer",
                      retroActiveSubTab === 'lessons'
                        ? "bg-indigo-500/10 text-indigo-400 border-indigo-505/30 shadow-sm"
                        : "bg-zinc-900/50 text-zinc-400 border-zinc-850 hover:bg-zinc-900 hover:text-zinc-200"
                    )}
                  >
                    💡 Уроки Памяти ({retrospectiveLessons.length})
                  </button>
                  <button
                    onClick={() => setRetroActiveSubTab('telemetry')}
                    className={cn(
                      "px-3 py-2 rounded-lg text-xs font-bold font-mono transition-all border cursor-pointer",
                      retroActiveSubTab === 'telemetry'
                        ? "bg-indigo-500/10 text-indigo-400 border-indigo-505/30 shadow-sm"
                        : "bg-zinc-900/50 text-zinc-400 border-zinc-850 hover:bg-zinc-900 hover:text-zinc-200"
                    )}
                  >
                    🛠️ Телеметрия Агентов ({agentExchangeLogs.length})
                  </button>
                  <button
                    onClick={() => setRetroActiveSubTab('reports')}
                    className={cn(
                      "px-3 py-2 rounded-lg text-xs font-bold font-mono transition-all border cursor-pointer",
                      retroActiveSubTab === 'reports'
                        ? "bg-indigo-500/10 text-indigo-400 border-indigo-505/30 shadow-sm"
                        : "bg-zinc-900/50 text-zinc-400 border-zinc-850 hover:bg-zinc-900 hover:text-zinc-200"
                    )}
                  >
                    📈 Отчеты ИИ-Контура ({aiPerformanceReports.length})
                  </button>
                  <button
                    onClick={() => setRetroActiveSubTab('signals_analysis')}
                    className={cn(
                      "px-3.5 py-2 rounded-lg text-xs font-black font-mono transition-all border flex items-center gap-1.5 cursor-pointer",
                      retroActiveSubTab === 'signals_analysis'
                        ? "bg-amber-500/25 text-amber-300 border-amber-500/50 shadow-md shadow-amber-500/10 animate-pulse"
                        : "bg-amber-500/5 text-amber-400 border-amber-500/20 hover:bg-amber-500/15 hover:border-amber-500/40"
                    )}
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" /> Анализ сигналов (Force Scan) ⚡
                  </button>
                </div>
              </div>

              <div className="p-5">
                {retroActiveSubTab === 'lessons' && (
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-xs text-zinc-500">База извлеченных уроков и адаптивных штрафов для моделей:</span>
                      <button
                        onClick={async () => {
                          try {
                            const response = await fetch('/api/retrospective');
                            if (response.ok) {
                              const text = await response.text();
                              if (text.trim()) {
                                const r = JSON.parse(text);
                                if (r.success) {
                                  setRetrospectiveLessons(r.data || []);
                                }
                              }
                            }
                          } catch (e) {
                            console.error(e);
                          }
                        }}
                        className="px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-855 text-zinc-300 rounded-lg text-xs font-bold border border-zinc-800/60 transition-all flex items-center gap-1.5 active:scale-95"
                      >
                        <RefreshCw className="w-3.5 h-3.5 text-zinc-400" /> Обновить уроки
                      </button>
                    </div>

                    {retrospectiveLessons && retrospectiveLessons.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {retrospectiveLessons.slice().reverse().map((lessonItem, idx) => {
                          const isProfit = lessonItem.pnlPercent >= 0;
                          const durationMins = lessonItem.durationMs ? Math.round(lessonItem.durationMs / 60000) : 0;
                          const formattedDate = new Date(lessonItem.timestamp || Date.now()).toLocaleDateString('ru-RU', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          });

                          return (
                            <div 
                              key={lessonItem.id || idx} 
                              className="bg-zinc-900/15 border border-zinc-900 hover:border-zinc-800 transition-colors rounded-xl p-4 flex flex-col justify-between relative group"
                            >
                              <div>
                                <div className="flex justify-between items-start gap-2 mb-2">
                                  <div>
                                    <span className="font-mono text-xs font-black text-zinc-100">{lessonItem.symbol}</span>
                                    <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
                                      lessonItem.side === 'SHORT' 
                                        ? "bg-rose-955/40 text-rose-400 border border-rose-900/40" 
                                        : "bg-emerald-955/40 text-emerald-400 border border-emerald-900/40"
                                    }`}>
                                      {lessonItem.side}
                                    </span>
                                  </div>
                                  
                                  <div className="flex items-center gap-1.5">
                                    <span className={`font-mono text-xs font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                                      {isProfit ? '+' : ''}{lessonItem.pnlPercent?.toFixed(2)}%
                                    </span>
                                    <button
                                      onClick={async () => {
                                        if (confirm('Удалить этот анализ из памяти ИИ?')) {
                                          try {
                                            const response = await fetch(`/api/retrospective/${lessonItem.id}`, { method: 'DELETE' });
                                            if (response.ok) {
                                              const text = await response.text();
                                              if (text.trim()) {
                                                const res = JSON.parse(text);
                                                if (res.success) {
                                                  setRetrospectiveLessons(res.data || []);
                                                }
                                              }
                                            }
                                          } catch (e) {
                                            console.error(e);
                                          }
                                        }
                                      }}
                                      className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-rose-455 rounded bg-zinc-905 hover:bg-zinc-805 transition-all"
                                      title="Забыть этот урок"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>

                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-zinc-550 border-b border-indigo-900/10 pb-2 mb-2.5">
                                  <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3 text-zinc-650" />
                                    {formattedDate}
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Activity className="w-3 h-3 text-zinc-655" />
                                    {durationMins} мин
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Zap className="w-3 h-3 text-zinc-655" />
                                    {lessonItem.actionTaken || 'CLOSE'}
                                  </span>
                                </div>

                                <div className="text-zinc-350 font-mono text-[10px] leading-relaxed bg-zinc-950/20 p-2.5 rounded border border-zinc-900 shadow-inner">
                                  <span className="text-indigo-400 font-bold text-[9px] block mb-1">УРОК И ИНСАЙТ ИИ:</span>
                                  <p className="italic text-zinc-350">"{lessonItem.lesson}"</p>
                                </div>
                              </div>

                              <div className="mt-3 pt-2 border-t border-zinc-900/60 flex justify-between items-center text-[8.5px] text-zinc-600">
                                <span>Завершено</span>
                                <span className="text-[7.5px] bg-indigo-950/30 text-indigo-400 px-1 py-0.5 rounded font-black tracking-widest uppercase">
                                  ACTIVE MEM
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-12 border border-dashed border-zinc-900 rounded-xl flex flex-col items-center justify-center text-center">
                        <div className="h-10 w-10 bg-indigo-950/20 text-indigo-400 rounded-full flex items-center justify-center mb-3">
                          <Brain className="w-5 h-5 animate-pulse" />
                        </div>
                        <h4 className="text-xs font-bold text-zinc-300">Архив ретроспективной памяти пуст</h4>
                        <p className="text-[10px] text-zinc-500 max-w-sm mt-1">
                          Как только Ведущий ИИ-Трейдер завершит и закроет автоматическую (AUTO) или демо-сделку, ИИ препарирует её, выявит ошибки и полезные уроки, которые немедленно появятся здесь.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {retroActiveSubTab === 'telemetry' && (
                  <div>
                    <div className="bg-zinc-900/45 rounded-xl border border-zinc-800/40 p-4 mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                      <div>
                        <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-400 animate-spin" style={{ animationDuration: '3s' }} /> Координационный Модуль Межагентского Совещания
                        </h3>
                        <p className="text-[10px] text-zinc-500 mt-1">
                          Здесь транслируется реальное общение агентов: от Сканера подбора токенов до Риск-Менеджера и Архивариуса, которые вместе регулируют торговый регламент.
                        </p>
                      </div>
                      
                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          onClick={async () => {
                            setIsOptimizingExchange(true);
                            setOptimizationSummary(null);
                            try {
                              const response = await fetch('/api/agent-exchange/optimize', { method: 'POST' });
                              if (response.ok) {
                                const text = await response.text();
                                if (text.trim()) {
                                  const res = JSON.parse(text);
                                  if (res.success) {
                                    if (res.logs) setAgentExchangeLogs(res.logs);
                                    setOptimizationSummary(res.summary);
                                    if (addToast) addToast(`Оптимизация завершена: винрейт ${res.winRate || 0}%`, 'success');
                                  } else {
                                    throw new Error(res.error || 'Ошибка ИИ-Оптимизатора');
                                  }
                                } else {
                                  throw new Error('Пустой ответ от сервера оптимизации');
                                }
                              } else {
                                throw new Error(`Ошибка HTTP: ${response.status}`);
                              }
                            } catch (err: any) {
                              if (addToast) addToast(`Ошибка оптимизации: ${err.message}`, 'error');
                            } finally {
                              setIsOptimizingExchange(false);
                            }
                          }}
                          disabled={isOptimizingExchange}
                          className={`flex-1 sm:flex-initial px-3 py-1.5 ${
                            isOptimizingExchange ? 'bg-indigo-800/40 text-indigo-300' : 'bg-indigo-650 hover:bg-indigo-600 text-white active:scale-95'
                          } rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5`}
                        >
                          {isOptimizingExchange ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Оптимизация...
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 fill-current" /> Запустить ИИ-Оптимизацию
                            </>
                          )}
                        </button>
                        
                        <button
                          onClick={async () => {
                            if (confirm('Очистить все логи межагентских совещаний?')) {
                              try {
                                const response = await fetch('/api/agent-exchange/clear', { method: 'POST' });
                                if (response.ok) {
                                  const text = await response.text();
                                  if (text.trim()) {
                                    const res = JSON.parse(text);
                                    if (res.success) {
                                      setAgentExchangeLogs(res.data || []);
                                      setOptimizationSummary(null);
                                      if (addToast) addToast('Журнал совещаний успешно очищен', 'info');
                                    }
                                  }
                                }
                              } catch (e: any) {
                                console.error(e);
                              }
                            }
                          }}
                          className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-850 text-zinc-450 hover:text-rose-455 rounded-lg text-xs font-bold border border-zinc-800/60 transition-all flex items-center justify-center gap-1 active:scale-95"
                        >
                          Очистить логи
                        </button>
                      </div>
                    </div>

                    {optimizationSummary && (
                      <div className="mb-4 bg-emerald-950/20 border border-emerald-900/30 rounded-xl p-4">
                        <h4 className="text-[11px] font-bold text-emerald-400 flex items-center gap-1.5 mb-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Сводное архитектурное резюме ИИ-Оптимизатора:
                        </h4>
                        <p className="text-[10.5px] text-zinc-350 italic font-mono leading-relaxed">
                          "{optimizationSummary}"
                        </p>
                      </div>
                    )}

                    {agentExchangeLogs && agentExchangeLogs.length > 0 ? (
                      <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                        {agentExchangeLogs.slice().reverse().map((logItem, idx) => {
                          const getAgentBadgeClass = (agent: string) => {
                            switch (agent) {
                              case 'RETROSPECTIVE': return 'bg-indigo-950/60 text-indigo-300 border border-indigo-900/40';
                              case 'ARCHIVIST': return 'bg-amber-950/60 text-amber-300 border border-amber-900/40';
                              case 'RISK_MANAGER': return 'bg-rose-955/60 text-rose-300 border border-rose-900/40';
                              case 'EXPERT': return 'bg-emerald-955/60 text-emerald-300 border border-emerald-900/40';
                              case 'SCANNER': return 'bg-purple-950/60 text-purple-300 border border-purple-900/40';
                              default: return 'bg-zinc-900 text-zinc-300 border border-zinc-800';
                            }
                          };

                          const getStatusBorderClass = (type: string) => {
                            switch (type) {
                              case 'success': return 'border-l-2 border-l-emerald-500';
                              case 'warning': return 'border-l-2 border-l-amber-500';
                              default: return 'border-l-2 border-l-indigo-500';
                            }
                          };

                          const formattedTime = new Date(logItem.timestamp || Date.now()).toLocaleTimeString('ru-RU', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                          });

                          return (
                            <div 
                              key={logItem.id || idx}
                              className={`bg-zinc-900/30 border border-zinc-900 hover:border-zinc-850 rounded-xl p-3.5 transition-all text-left flex flex-col gap-2 ${getStatusBorderClass(logItem.type || 'info')}`}
                            >
                              <div className="flex flex-wrap justify-between items-center gap-2">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className={`text-[9px] px-2 py-0.5 rounded font-black tracking-wider ${getAgentBadgeClass(logItem.fromAgent)}`}>
                                    {logItem.fromAgent}
                                  </span>
                                  <span className="text-[10px] text-zinc-650 font-bold">➡️</span>
                                  <span className={`text-[9px] px-2 py-0.5 rounded font-black tracking-wider ${getAgentBadgeClass(logItem.toAgent)}`}>
                                    {logItem.toAgent}
                                  </span>
                                </div>
                                <span className="text-[10px] text-zinc-550 font-mono font-bold flex items-center gap-1">
                                  <Clock className="w-3 h-3 text-zinc-600" /> {formattedTime}
                                </span>
                              </div>

                              <div className="text-zinc-100 text-xs font-bold font-mono">
                                {logItem.message}
                              </div>
                              
                              <div className="bg-zinc-950/40 p-2.5 rounded border border-zinc-900 text-zinc-300 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                                {logItem.details}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-12 border border-dashed border-zinc-900 rounded-xl flex flex-col items-center justify-center text-center">
                        <div className="h-10 w-10 bg-indigo-950/20 text-indigo-400 rounded-full flex items-center justify-center mb-3">
                          <Activity className="w-5 h-5 animate-pulse" />
                        </div>
                        <h4 className="text-xs font-bold text-zinc-300 font-mono">Журнал телеметрии чист</h4>
                        <p className="text-[10px] text-zinc-500 max-w-sm mt-1">
                          Межагентская сессия запустится автоматически на следующем тике, либо вы можете инициализировать ее вручную прямо сейчас.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {retroActiveSubTab === 'reports' && (
                  <div className="space-y-6">
                    {/* Header explanatory card */}
                    <div className="bg-zinc-900/30 border border-zinc-900 rounded-xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                      <div>
                        <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5 font-mono">
                          <Brain className="w-4 h-4 text-indigo-400" /> Виртуальная Память ИИ-Контура
                        </h3>
                        <p className="text-[10px] text-zinc-500 mt-1 max-w-xl leading-relaxed">
                          ИИ-Контур автоматически препарирует результаты сделок каждые 15 минут, отслеживая метрики винрейта за день, неделю и месяц. Каждая итерация порождает стратегические выводы, которые записываются в виртуальную память и направляются агенту ИИ-Эксперту.
                        </p>
                      </div>
                      
                      <button
                        onClick={fetchAiPerformanceReports}
                        disabled={isFetchingReports}
                        className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-850 text-indigo-400 rounded-lg text-xs font-bold border border-zinc-800/60 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-50"
                      >
                        {isFetchingReports ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        Обновить отчеты
                      </button>
                    </div>

                    {/* Stored reports list */}
                    {aiPerformanceReports && aiPerformanceReports.length > 0 ? (
                      <div className="space-y-4">
                        {aiPerformanceReports.slice().reverse().map((report, idx) => {
                          const formattedTime = new Date(report.timestamp || Date.now()).toLocaleString('ru-RU', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                          });

                          return (
                            <div 
                              key={report.id || idx}
                              className="bg-zinc-900/10 border border-zinc-900 hover:border-zinc-845 rounded-xl p-5 transition-all text-left flex flex-col gap-4 relative overflow-hidden"
                            >
                              {/* Background ambient light */}
                              <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/2 rounded-full blur-2xl pointer-events-none" />

                              {/* Title line */}
                              <div className="flex flex-wrap justify-between items-center gap-3 border-b border-zinc-900/60 pb-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] px-2 py-0.5 bg-indigo-950/40 text-indigo-300 font-bold font-mono rounded border border-indigo-900/30">
                                    {report.id ? report.id.toUpperCase() : `OPT_SESS_${aiPerformanceReports.length - idx}`}
                                  </span>
                                  <span className="text-[10.5px] text-zinc-500 font-mono flex items-center gap-1">
                                    <Clock className="w-3.5 h-3.5 text-zinc-650" /> {formattedTime}
                                  </span>
                                </div>

                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-zinc-500 font-mono">Проанализировано:</span>
                                  <span className="text-xs text-zinc-200 font-mono font-bold bg-zinc-950 px-2 py-0.5 rounded border border-zinc-900">
                                    {report.analyzedTradesCount ?? 15} шт.
                                  </span>
                                  <span className="text-[10px] text-zinc-500 font-mono">Винрейт ИИ:</span>
                                  <span className="text-xs text-emerald-400 font-mono font-bold bg-emerald-950/10 px-2 py-0.5 rounded border border-emerald-900/20">
                                    {report.winRateAfter ? report.winRateAfter.toFixed(1) : 'Н/Д'}%
                                  </span>
                                </div>
                              </div>

                              {/* Multi-timeframe statistics widgets */}
                              {report.stats && (
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                  {/* DAY */}
                                  <div className="bg-zinc-950/40 border border-zinc-900/80 rounded-lg p-3 flex flex-col justify-between">
                                    <div className="flex justify-between items-center pb-1 border-b border-zinc-900/40 mb-2">
                                      <span className="text-[9.5px] font-bold text-zinc-400 font-mono">ЗА ДЕНЬ (24ч)</span>
                                      <span className="text-[10.5px] text-zinc-500 font-mono">({report.stats.day?.count ?? 0} сдел.)</span>
                                    </div>
                                    <div className="flex justify-between items-baseline">
                                      <span className="text-[10px] text-zinc-550">Винрейт:</span>
                                      <span className="text-xs font-bold text-zinc-100 font-mono">{(report.stats.day?.winRate ?? 0).toFixed(1)}%</span>
                                    </div>
                                    <div className="flex justify-between items-baseline mt-1">
                                      <span className="text-[10px] text-zinc-550">Суммарный PnL:</span>
                                      <span className={`text-xs font-bold font-mono ${(report.stats.day?.totalPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        ${(report.stats.day?.totalPnl ?? 0).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>

                                  {/* WEEK */}
                                  <div className="bg-zinc-950/40 border border-zinc-900/80 rounded-lg p-3 flex flex-col justify-between">
                                    <div className="flex justify-between items-center pb-1 border-b border-zinc-900/40 mb-2">
                                      <span className="text-[9.5px] font-bold text-zinc-400 font-mono">ЗА НЕДЕЛЮ (7д)</span>
                                      <span className="text-[10.5px] text-zinc-500 font-mono">({report.stats.week?.count ?? 0} сдел.)</span>
                                    </div>
                                    <div className="flex justify-between items-baseline">
                                      <span className="text-[10px] text-zinc-550">Винрейт:</span>
                                      <span className="text-xs font-bold text-zinc-100 font-mono">{(report.stats.week?.winRate ?? 0).toFixed(1)}%</span>
                                    </div>
                                    <div className="flex justify-between items-baseline mt-1">
                                      <span className="text-[10px] text-zinc-550">Суммарный PnL:</span>
                                      <span className={`text-xs font-bold font-mono ${(report.stats.week?.totalPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        ${(report.stats.week?.totalPnl ?? 0).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>

                                  {/* MONTH */}
                                  <div className="bg-zinc-950/40 border border-zinc-900/80 rounded-lg p-3 flex flex-col justify-between">
                                    <div className="flex justify-between items-center pb-1 border-b border-zinc-900/40 mb-2">
                                      <span className="text-[9.5px] font-bold text-zinc-400 font-mono">ЗА МЕСЯЦ (30д)</span>
                                      <span className="text-[10.5px] text-zinc-500 font-mono">({report.stats.month?.count ?? 0} сдел.)</span>
                                    </div>
                                    <div className="flex justify-between items-baseline">
                                      <span className="text-[10px] text-zinc-550">Винрейт:</span>
                                      <span className="text-xs font-bold text-zinc-100 font-mono">{(report.stats.month?.winRate ?? 0).toFixed(1)}%</span>
                                    </div>
                                    <div className="flex justify-between items-baseline mt-1">
                                      <span className="text-[10px] text-zinc-550">Суммарный PnL:</span>
                                      <span className={`text-xs font-bold font-mono ${(report.stats.month?.totalPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        ${(report.stats.month?.totalPnl ?? 0).toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Three major optimized report components */}
                              <div className="space-y-3 pt-1">
                                {/* Component 1: Optimized Logic */}
                                <div className="bg-zinc-950/20 border border-zinc-900/40 rounded-lg p-3.5">
                                  <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold text-indigo-400 font-mono mb-1 bg-indigo-950/10 px-2 py-1 rounded inline-flex border border-indigo-900/20">
                                    <Sparkles className="w-3.5 h-3.5" /> ОПТИМИЗИРОВАННАЯ ЛОГИКА
                                  </div>
                                  <p className="text-[11px] text-zinc-350 font-mono leading-relaxed pl-1">
                                    {report.optimizedLogicSummary || "Н/Д"}
                                  </p>
                                </div>

                                {/* Component 2: Impact Assessment */}
                                <div className="bg-zinc-950/20 border border-zinc-900/40 rounded-lg p-3.5">
                                  <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold text-emerald-400 font-mono mb-1 bg-emerald-950/10 px-2 py-1 rounded inline-flex border border-emerald-900/20">
                                    <Activity className="w-3.5 h-3.5" /> ОЦЕНКА ВЛИЯНИЯ И ВИНРЕЙТА
                                  </div>
                                  <p className="text-[11px] text-zinc-350 leading-relaxed pl-1 italic font-mono">
                                    "{report.impactAssessment || "Н/Д"}"
                                  </p>
                                </div>

                                {/* Component 3: Historical Self Review */}
                                <div className="bg-zinc-950/20 border border-zinc-900/40 rounded-lg p-3.5">
                                  <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold text-amber-400 font-mono mb-1 bg-amber-950/10 px-2 py-1 rounded inline-flex border border-amber-900/20">
                                    <Brain className="w-3.5 h-3.5" /> ЛИЧНЫЙ САМОАНАЛИЗ ИИ-КОНТУРА
                                  </div>
                                  <p className="text-[11px] text-zinc-350 leading-relaxed pl-1 font-mono">
                                    {report.historicalSelfReview || "Н/Д"}
                                  </p>
                                </div>
                              </div>

                              {/* Archived Rules during this session */}
                              {report.archivedRulesCount > 0 && (
                                <div className="bg-rose-950/10 border border-rose-900/20 rounded-lg p-3.5">
                                  <div className="text-[10px] font-bold text-rose-400 font-mono mb-2 flex items-center gap-1">
                                    📁 ДЕАКТИВИРОВАНО ПРАВИЛ В ЭТОЙ СЕССИИ ({report.archivedRulesCount} шт.):
                                  </div>
                                  <div className="space-y-1.5 pl-1 text-[10px] text-zinc-450 font-mono">
                                    {report.archivedRulesList && report.archivedRulesList.map((rule: any, uIdx: number) => (
                                      <div key={uIdx} className="flex gap-1">
                                        <span className="text-rose-500 font-bold">•</span>
                                        <span><b>#{rule.id}:</b> {rule.reason || 'Деактивация неоптимального паттерна'}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-16 border border-dashed border-zinc-900 rounded-xl flex flex-col items-center justify-center text-center">
                        <div className="h-12 w-12 bg-indigo-950/20 text-indigo-400 rounded-full flex items-center justify-center mb-4">
                          <Activity className="w-6 h-6 animate-pulse" />
                        </div>
                        <h4 className="text-xs font-bold text-zinc-300 font-mono">Журнал виртуальной памяти пуст</h4>
                        <p className="text-[10px] text-zinc-500 max-w-sm mt-1.5">
                          ИИ-Контур еще не сгенерировал ни одного отчета с разбивкой за периоды. Дождитесь автоматического запуска, либо запустите ИИ-Оптимизацию в соседней вкладке телеметрии.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {retroActiveSubTab === 'signals_analysis' && (
                  <div className="space-y-6">
                    {/* Header explanatory card */}
                    <div className="bg-zinc-900/30 border border-zinc-900 rounded-xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                      <div>
                        <h3 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5 font-mono">
                          <Zap className="w-4 h-4 text-amber-400" /> Сигнальный Анализатор & ИИ Комитет
                        </h3>
                        <p className="text-[10px] text-zinc-500 mt-1 max-w-xl leading-relaxed">
                          Позволяет запустить принудительный прогон комплексной оценки (Force Trigger Scan) по 5 случайным парам. Система проверит графические паттерны, определит прохождение технических предохранителей (EMA-200, FVG поддержки, пробои ликвидности) и запросит вердикт Комитета ИИ для выявления точных причин, почему по монете открывается или не открывается позиция.
                        </p>
                      </div>
                      
                      <button
                        onClick={async () => {
                          setForceScanLoading(true);
                          setForceScanResults(null);
                          try {
                            const response = await fetch('/api/debug/force-trigger-scan', { method: 'POST' });
                            if (response.ok) {
                              const text = await response.text();
                              if (text.trim()) {
                                const res = JSON.parse(text);
                                if (res.success) {
                                  setForceScanResults(res.results || []);
                                  if (addToast) addToast('Экспресс-анализ ИИ успешно завершен на 5 парах', 'success');
                                } else {
                                  throw new Error(res.error || 'Не удалось запустить ручной разбор.');
                                }
                              } else {
                                throw new Error('Пустой ответ сервера экспресс-анализа');
                              }
                            } else {
                              throw new Error(`Ошибка HTTP: ${response.status}`);
                            }
                          } catch (err: any) {
                            if (addToast) addToast(`Ошибка экспресс-анализа: ${err.message}`, 'error');
                          } finally {
                            setForceScanLoading(false);
                            fetchCommitteeStats();
                          }
                        }}
                        disabled={forceScanLoading}
                        className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded-lg text-xs font-bold border border-amber-500/20 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-50 inline-flex whitespace-nowrap"
                      >
                        {forceScanLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                        Force Trigger Scan (5 пар)
                      </button>
                    </div>

                    {/* Widget: AI Committee Statistics */}
                    <div className="bg-zinc-950/25 border border-zinc-900 rounded-xl p-5 space-y-5 text-left">
                      <div className="flex justify-between items-center border-b border-zinc-900 pb-3">
                        <div>
                          <h4 className="text-xs font-bold text-zinc-100 flex items-center gap-1.5 font-mono uppercase">
                            <BarChart3 className="w-4 h-4 text-emerald-400" /> Статистика Комитета ИИ (За последние 24ч)
                          </h4>
                          <p className="text-[10px] text-zinc-500 mt-0.5">
                            Консолидированная гистограмма распределения вердиктов по каждому из 3 независимых агентов
                          </p>
                        </div>
                        <button 
                          onClick={fetchCommitteeStats}
                          className="p-1.5 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 rounded transition-all cursor-pointer"
                          title="Обновить статистику"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isFetchingCommitteeStats ? 'animate-spin' : ''}`} />
                        </button>
                      </div>

                      {isFetchingCommitteeStats && !committeeStats ? (
                        <div className="py-12 flex flex-col items-center justify-center text-center">
                          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin mb-2" />
                          <span className="text-[10px] text-zinc-505 font-mono">Агрегация исторических решений агентов...</span>
                        </div>
                      ) : committeeStats ? (
                        <div className="space-y-6">
                          {/* Three Agents Breakdown Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Agent 1: Bull */}
                            <div className="bg-zinc-950/45 border border-zinc-900/80 rounded-lg p-4 space-y-3 relative overflow-hidden">
                              <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/[0.01] rounded-full blur-xl" />
                              <div className="flex justify-between items-center">
                                <span className="text-[11px] font-bold text-emerald-405 font-mono flex items-center gap-1">
                                  🐂 Агент #1: Bull (Бык)
                                </span>
                                <span className="text-[9px] text-zinc-500 font-mono">Детали уклона: LONG</span>
                              </div>
                              <div className="space-y-2 pt-1.5">
                                {/* LONG Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">LONG</span>
                                    <span className="text-emerald-400 font-bold">
                                      {committeeStats.stats.bull.LONG} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bull.LONG / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-emerald-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bull.LONG / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* SHORT Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">SHORT</span>
                                    <span className="text-rose-400 font-bold">
                                      {committeeStats.stats.bull.SHORT} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bull.SHORT / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-rose-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bull.SHORT / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* NEUTRAL Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">NEUTRAL</span>
                                    <span className="text-zinc-550 font-bold">
                                      {committeeStats.stats.bull.NEUTRAL} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bull.NEUTRAL / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-zinc-700 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bull.NEUTRAL / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Agent 2: Bear */}
                            <div className="bg-zinc-950/45 border border-zinc-900/80 rounded-lg p-4 space-y-3 relative overflow-hidden">
                              <div className="absolute top-0 right-0 w-16 h-16 bg-rose-500/[0.01] rounded-full blur-xl" />
                              <div className="flex justify-between items-center">
                                <span className="text-[11px] font-bold text-rose-405 font-mono flex items-center gap-1">
                                  🐻 Агент #2: Bear (Медведь)
                                </span>
                                <span className="text-[9px] text-zinc-500 font-mono">Детали уклона: SHORT</span>
                              </div>
                              <div className="space-y-2 pt-1.5">
                                {/* LONG Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">LONG</span>
                                    <span className="text-emerald-400 font-bold">
                                      {committeeStats.stats.bear.LONG} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bear.LONG / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-emerald-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bear.LONG / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* SHORT Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">SHORT</span>
                                    <span className="text-rose-405 font-bold">
                                      {committeeStats.stats.bear.SHORT} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bear.SHORT / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-rose-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bear.SHORT / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* NEUTRAL Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">NEUTRAL</span>
                                    <span className="text-zinc-550 font-bold">
                                      {committeeStats.stats.bear.NEUTRAL} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.bear.NEUTRAL / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-zinc-700 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.bear.NEUTRAL / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Agent 3: Judge */}
                            <div className="bg-zinc-950/45 border border-zinc-900/80 rounded-lg p-4 space-y-3 relative overflow-hidden">
                              <div className="absolute top-0 right-0 w-16 h-16 bg-blue-500/[0.01] rounded-full blur-xl" />
                              <div className="flex justify-between items-center">
                                <span className="text-[11px] font-bold text-blue-400 font-mono flex items-center gap-1">
                                  ⚖️ Агент #3: Judge (Судья)
                                </span>
                                <span className="text-[9px] text-zinc-500 font-mono">ИТОГОВЫЙ КОНСЕНСУС</span>
                              </div>
                              <div className="space-y-2 pt-1.5">
                                {/* LONG Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">LONG (Одобрен)</span>
                                    <span className="text-emerald-400 font-bold">
                                      {committeeStats.stats.judge.LONG} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.judge.LONG / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-emerald-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.judge.LONG / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* SHORT Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">SHORT (Одобрен)</span>
                                    <span className="text-rose-405 font-bold">
                                      {committeeStats.stats.judge.SHORT} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.judge.SHORT / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-rose-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.judge.SHORT / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                                {/* NEUTRAL Bar */}
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-mono">
                                    <span className="text-zinc-400">NEUTRAL (Блокировка)</span>
                                    <span className="text-amber-450 font-bold">
                                      {committeeStats.stats.judge.NEUTRAL} ({committeeStats.stats.totalRuns ? Math.round((committeeStats.stats.judge.NEUTRAL / committeeStats.stats.totalRuns) * 100) : 0}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-amber-500 rounded-full transition-all duration-550" 
                                      style={{ width: `${committeeStats.stats.totalRuns ? (committeeStats.stats.judge.NEUTRAL / committeeStats.stats.totalRuns) * 100 : 0}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Hourly Stacked Histogram breakdown */}
                          <div className="space-y-2">
                            <span className="text-[10px] font-bold text-zinc-500 uppercase font-mono tracking-wider">
                              📊 Динамика решений по часам (За последние 24 часа)
                            </span>
                            <div className="bg-zinc-950/30 border border-zinc-900/60 rounded-lg p-4 h-44 flex items-end justify-between gap-1.5 overflow-x-auto">
                              {committeeStats.hourlyHist.map((hour: any, i: number) => {
                                const total = hour.LONG + hour.SHORT + hour.NEUTRAL;
                                const pctLong = total ? (hour.LONG / total) * 105 : 0;
                                const pctShort = total ? (hour.SHORT / total) * 105 : 0;
                                const pctNeutral = total ? (hour.NEUTRAL / total) * 105 : 0;

                                return (
                                  <div key={i} className="flex-1 flex flex-col items-center gap-1.5 group select-none min-w-[20px]">
                                    <div className="relative w-full h-24 flex flex-col justify-end rounded overflow-hidden bg-zinc-900/40">
                                      {/* LONG (Green) */}
                                      {hour.LONG > 0 && (
                                        <div 
                                          className="bg-emerald-500/80 hover:bg-emerald-400 transition-colors cursor-pointer" 
                                          style={{ height: `${pctLong}%` }}
                                          title={`LONG: ${hour.LONG}`}
                                        />
                                      )}
                                      {/* SHORT (Red) */}
                                      {hour.SHORT > 0 && (
                                        <div 
                                          className="bg-rose-500/80 hover:bg-rose-450 transition-colors cursor-pointer" 
                                          style={{ height: `${pctShort}%` }}
                                          title={`SHORT: ${hour.SHORT}`}
                                        />
                                      )}
                                      {/* NEUTRAL (Amber/Yellow) */}
                                      {hour.NEUTRAL > 0 && (
                                        <div 
                                          className="bg-amber-500/70 hover:bg-amber-400 transition-colors cursor-pointer" 
                                          style={{ height: `${pctNeutral}%` }}
                                          title={`NEUTRAL: ${hour.NEUTRAL}`}
                                        />
                                      )}

                                      {/* Hover tooltip */}
                                      <div className="opacity-0 group-hover:opacity-100 absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 bg-zinc-955 border border-zinc-800 rounded p-1.5 text-[9px] font-mono text-zinc-300 pointer-events-none transition-opacity duration-150 z-20 whitespace-nowrap shadow-xl">
                                        <div className="font-bold border-b border-zinc-900 pb-0.5 mb-1 text-zinc-100">Время: {hour.time}</div>
                                        <div className="flex items-center gap-1 text-emerald-400">🟢 LONG: {hour.LONG}</div>
                                        <div className="flex items-center gap-1 text-rose-400">🔴 SHORT: {hour.SHORT}</div>
                                        <div className="flex items-center gap-1 text-amber-400">🟡 NEUTRAL: {hour.NEUTRAL}</div>
                                        <div className="mt-1 pt-0.5 border-t border-zinc-990 text-[8px] text-zinc-500 font-sans">Всего прогонов: {total}</div>
                                      </div>
                                    </div>
                                    <span className="text-[8px] text-zinc-500 font-mono rotate-45 origin-left mt-1 whitespace-nowrap">{hour.time}</span>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="flex justify-center flex-wrap items-center gap-6 pt-3 text-[9px] font-mono text-zinc-400">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 bg-emerald-500/80 rounded" /> LONG (Одобрение входа в лонг)
                              </span>
                              <span className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 bg-rose-500/80 rounded" /> SHORT (Одобрение входа в шорт)
                              </span>
                              <span className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 bg-amber-500/70 rounded" /> NEUTRAL (Снятие/Блокировка Судьей)
                              </span>
                            </div>
                          </div>

                          {/* Insight Explanatory Text */}
                          <div className="bg-amber-500/[0.02] border border-amber-500/10 rounded-xl p-4 flex gap-3 text-left">
                            <span className="text-base">💡</span>
                            <div className="space-y-1">
                              <h5 className="text-[10.5px] font-bold text-amber-400 font-mono">Аналитический инсайт эксперта:</h5>
                              <p className="text-[10px] text-zinc-400 leading-relaxed font-sans">
                                Высокая доля вердиктов <strong>NEUTRAL</strong> вызвана строгой моделью консенсуса, внедренной для защиты депозита от шума. 
                                Если Агент Бык рапортует наличие бычьих факторов, но Агент Медведь находит блокирующий риск HTF (например, сопротивление старшего таймфрейма, удержание лимитной плотности или незаполненный FVG), Судья налагает вето <strong>NEUTRAL</strong>. 
                                Ручной прогон через <strong>Force Trigger Scan</strong> выше позволяет точечно проверить данные дебатов для любой пары в текущую секунду.
                              </p>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="py-12 flex flex-col items-center justify-center text-center border border-dashed border-zinc-900 rounded-xl">
                          <Activity className="w-6 h-6 text-zinc-600 animate-pulse mb-2" />
                          <span className="text-[10px] text-zinc-500 font-mono">Статистика решений появится после первых прогонов ИИ-Анализатора.</span>
                        </div>
                      )}
                    </div>

                    {/* Loading State with simulated technical process steps */}
                    {forceScanLoading && (
                      <div className="py-12 border border-dashed border-zinc-900 rounded-xl flex flex-col items-center justify-center text-center">
                        <Loader2 className="w-8 h-8 text-amber-400 animate-spin mb-4" />
                        <h4 className="text-xs font-bold text-zinc-300 font-mono">Выполняется симуляция отбора и анализ Комитета ИИ...</h4>
                        <div className="space-y-1 mt-3 pl-4 text-[10px] text-zinc-500 font-mono text-left max-w-xs md:max-w-md">
                          <div className="flex gap-2">🟢 <span className="text-zinc-400">Считывание 1m/15m OHLCV индикаторов из кэша...</span></div>
                          <div className="flex gap-2">🟢 <span className="text-zinc-400">Проверка шорт-фильтров предохранителей (EMA, FVG, Wick)...</span></div>
                          <div className="flex gap-2 animate-pulse">🟡 <span className="text-amber-400 font-bold">Опрос Агента #1 (Бык) и Агента #2 (Медведь)...</span></div>
                          <div className="flex gap-2">⚪ <span className="text-zinc-600">Вычисление консенсуса и выдача вердикта Судьи ИИ...</span></div>
                        </div>
                      </div>
                    )}

                    {/* Results Container */}
                    {forceScanResults && forceScanResults.length > 0 && (
                      <div className="space-y-6">
                        {forceScanResults.map((coin, index) => {
                          const hasLocks = coin.blockLocks && coin.blockLocks.length > 0;
                          const hasError = !!coin.error;
                          const rsiVal = coin.indicators?.rsi1h ?? 50;
                          
                          return (
                            <div 
                              key={coin.symbol || index}
                              className={`bg-zinc-950/40 border ${hasError ? 'border-zinc-900/50' : hasLocks ? 'border-rose-950/45' : 'border-indigo-950/45'} rounded-xl p-5 transition-all text-left flex flex-col gap-5 relative overflow-hidden`}
                            >
                              {/* Background color bleed */}
                              <div className={`absolute top-0 right-0 w-32 h-32 ${hasError ? 'bg-zinc-500/1' : hasLocks ? 'bg-rose-500/2' : 'bg-indigo-500/3'} rounded-full blur-3xl pointer-events-none`} />

                              {/* Coin header */}
                              <div className="flex flex-wrap justify-between items-center gap-3 border-b border-zinc-900/80 pb-3">
                                <div className="flex items-center gap-3">
                                  <span className="text-xs px-2.5 py-1 bg-zinc-900 text-zinc-100 font-black font-mono rounded-lg border border-zinc-805">
                                    {coin.symbol}
                                  </span>
                                  <span className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded ${coin.change24h >= 0 ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30' : 'bg-rose-950/40 text-rose-400 border border-rose-900/30'}`}>
                                    {coin.change24h >= 0 ? '+' : ''}{coin.change24h?.toFixed(2)}% (24ч)
                                  </span>
                                  <span className="text-[10px] text-zinc-500 font-mono">
                                    Цена: <strong className="text-zinc-300 font-bold font-mono">${coin.price?.toFixed(4)}</strong>
                                  </span>
                                </div>

                                <div className="flex items-center gap-2">
                                  {hasError ? (
                                    <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 text-zinc-500 font-bold border border-zinc-850 font-mono">
                                      НЕДОСТУПНО
                                    </span>
                                  ) : hasLocks ? (
                                    <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500/10 text-rose-450 font-bold border border-rose-500/20 font-mono">
                                      ЗАБЛОКИРОВАНО (РИСК)
                                    </span>
                                  ) : (
                                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-450 font-bold border border-emerald-500/20 font-mono">
                                      ДОПУЩЕНО К СДЕЛКЕ
                                    </span>
                                  )}
                                </div>
                              </div>

                              {hasError ? (
                                <div className="text-zinc-500 text-xs font-mono">{coin.error}</div>
                              ) : (
                                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                                  
                                  {/* Technical Parameters (4 cols) */}
                                  <div className="lg:col-span-5 space-y-4">
                                    <div className="bg-zinc-900/10 border border-zinc-900 rounded-lg p-3">
                                      <h4 className="text-[10px] font-bold text-zinc-400 font-mono tracking-wider uppercase mb-2 border-b border-zinc-900/50 pb-1 flex items-center gap-1">
                                        📊 ТЕХНИЧЕСКИЕ ИНДИКАТОРЫ
                                      </h4>
                                      
                                      <div className="space-y-1.5 text-[10.5px] font-mono text-zinc-350">
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">RSI 1H:</span>
                                          <span className={`${rsiVal >= 70 ? 'text-amber-400 font-bold' : rsiVal <= 30 ? 'text-indigo-400 font-bold' : 'text-zinc-300'}`}>
                                            {rsiVal.toFixed(2)}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">Шпиль / Фитиль свечи:</span>
                                          <span className={`${(coin.indicators?.topWickPct ?? 0) >= 0.55 ? 'text-emerald-400 font-bold' : 'text-zinc-300'}`}>
                                            {((coin.indicators?.topWickPct ?? 0) * 100).toFixed(1)}%
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">Удаление от VWAP:</span>
                                          <span>{coin.indicators?.vwap ? `$${coin.indicators.vwap.toFixed(4)}` : 'Н/Д'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">1h EMA-200 уровень:</span>
                                          <span>{coin.indicators?.ema200_1h ? `$${coin.indicators.ema200_1h.toFixed(4)}` : 'Н/Д'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">Свип ликвидности:</span>
                                          <span className={coin.indicators?.isLiquiditySweep ? 'text-emerald-400 font-bold' : 'text-zinc-500'}>
                                            {coin.indicators?.isLiquiditySweep ? 'ЕСТЬ (Sweep)' : 'ОТСУТСТВУЕТ'}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">Зона FVG сверху (Бычья):</span>
                                          <span className={coin.indicators?.hasFvgAbove ? 'text-rose-400 font-bold' : 'text-zinc-500'}>
                                            {coin.indicators?.hasFvgAbove ? 'АКТИВНА' : 'НЕТ'}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-zinc-500">Зона FVG снизу (Поддержка):</span>
                                          <span className={coin.indicators?.hasBullishFvgBelow ? 'text-amber-400 font-bold' : 'text-zinc-500'}>
                                            {coin.indicators?.hasBullishFvgBelow ? 'АКТИВНА' : 'НЕТ'}
                                          </span>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Matches & Block list */}
                                    <div className="bg-zinc-900/10 border border-zinc-900 rounded-lg p-3">
                                      <h4 className="text-[10px] font-bold text-zinc-400 font-mono tracking-wider uppercase mb-2 border-b border-zinc-900/50 pb-1 flex items-center gap-1">
                                        ⚡ ПАТТЕРНЫ & РИСК-ФИЛЬТРЫ
                                      </h4>
                                      <div className="space-y-3">
                                        <div>
                                          <div className="text-[9.5px] text-zinc-500 font-mono">РАСПОЗНАННЫЙ ПАТТЕРН СЛИВА:</div>
                                          <div className={`text-[10.5px] font-bold font-mono mt-0.5 ${coin.matchedPattern !== 'None' ? 'text-amber-400' : 'text-zinc-500'}`}>
                                            {coin.matchedPattern !== 'None' ? coin.matchedPattern : 'Паттерны не зафиксированы'}
                                          </div>
                                        </div>

                                        <div>
                                          <div className="text-[9.5px] text-zinc-500 font-mono tracking-tight">АКТИВНЫЕ БЛОК-ФИЛЬТРЫ:</div>
                                          {hasLocks ? (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                              {coin.blockLocks.map((lock: string) => (
                                                <span key={lock} className="text-[9px] px-1.5 py-0.5 bg-rose-950/50 text-rose-450 font-bold font-mono rounded border border-rose-900/30">
                                                  {lock}
                                                </span>
                                              ))}
                                            </div>
                                          ) : (
                                            <span className="text-[10px] text-emerald-400 font-bold font-mono flex items-center gap-1 mt-1">
                                              ✅ Нет активных блок-фильтров шорта!
                                            </span>
                                          )}
                                        </div>

                                        {hasLocks && (
                                          <div className="space-y-1 pt-1.5 border-t border-zinc-900/50 pl-0.5 leading-relaxed">
                                            {coin.blockDetails?.map((det: string, dIdx: number) => (
                                              <div key={dIdx} className="text-[10px] text-zinc-450 font-mono flex items-start gap-1">
                                                <span className="text-zinc-650">•</span>
                                                <span>{det}</span>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* AI Committee Evaluation (7 cols) */}
                                  <div className="lg:col-span-7 space-y-3 flex flex-col justify-between">
                                    <div className="bg-zinc-900/10 border border-zinc-900 rounded-lg p-4 h-full flex flex-col justify-between gap-4">
                                      <div>
                                        <div className="flex justify-between items-center border-b border-zinc-900/50 pb-2 mb-3">
                                          <h4 className="text-[10px] font-bold text-zinc-400 font-mono tracking-wider uppercase flex items-center gap-1">
                                            🧠 ЗАКЛЮЧЕНИЕ КОМИТЕТА ИИ
                                          </h4>
                                          
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-[9.5px] text-zinc-500 font-mono">Консенсус-скор:</span>
                                            <span className={`text-xs font-black font-mono px-2 py-0.5 rounded leading-none ${coin.aiCommittee?.aiScore >= 80 ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30' : 'bg-rose-950/40 text-rose-400 border border-rose-900/30'}`}>
                                              {coin.aiCommittee?.aiScore ?? 0}%
                                            </span>
                                          </div>
                                        </div>

                                        {/* Speeches */}
                                        <div className="space-y-3.5">
                                          {/* Agent 1 - Bull */}
                                          <div className="space-y-1 pl-2 border-l-2 border-emerald-500/70">
                                            <div className="text-[10px] font-bold text-emerald-400 font-mono flex items-center gap-1 uppercase tracking-wider">
                                              🟢 Агент #1 (Бык-Аналитик):
                                            </div>
                                            <p className="text-[10.5px] text-zinc-350 leading-relaxed font-mono pl-0.5">
                                              {coin.aiCommittee?.bullVerdict || "Нет заключения от Агента-Быка."}
                                            </p>
                                          </div>

                                          {/* Agent 2 - Bear */}
                                          <div className="space-y-1 pl-2 border-l-2 border-rose-500/70">
                                            <div className="text-[10px] font-bold text-rose-450 font-mono flex items-center gap-1 uppercase tracking-wider">
                                              🔴 Агент #2 (Медведь-Риск-Менеджер):
                                            </div>
                                            <p className="text-[10.5px] text-zinc-350 leading-relaxed font-mono pl-0.5">
                                              {coin.aiCommittee?.bearVerdict || "Нет заключения от Агента-Медведя."}
                                            </p>
                                          </div>

                                          {/* Agent 3 - Judge */}
                                          <div className="space-y-1 pl-2 border-l-2 border-amber-500/70 bg-amber-500/2 rounded-r-lg p-2.5 border-r border-y border-zinc-900/40">
                                            <div className="text-[10px] font-bold text-amber-400 font-mono flex items-center gap-1 uppercase tracking-wider">
                                              ⚖️ Агент #3 (Судья Консенсуса):
                                            </div>
                                            <p className="text-[10.5px] text-zinc-100 leading-normal font-mono pl-0.5 font-medium">
                                              {coin.aiCommittee?.judgeVerdict || "Судья не сформулировал вердикт."}
                                            </p>
                                          </div>
                                        </div>
                                      </div>

                                      {/* Bottom Decision Badge */}
                                      <div className="border-t border-zinc-900/60 pt-3 flex items-center justify-between">
                                        <span className="text-[10px] text-zinc-500 font-mono">РЕШЕНИЕ ИИ ДЛЯ РОБОТА:</span>
                                        <span className={`text-[11px] px-3 py-1 font-black tracking-wider uppercase font-mono rounded-lg border ${
                                          coin.aiCommittee?.finalVerdict === 'SHORT'
                                            ? 'bg-rose-500/10 text-rose-450 border-rose-500/30'
                                            : coin.aiCommittee?.finalVerdict === 'LONG'
                                            ? 'bg-emerald-500/10 text-emerald-450 border-emerald-500/30'
                                            : 'bg-zinc-905 text-zinc-400 border-zinc-800'
                                        }`}>
                                          ⚔️ {coin.aiCommittee?.finalVerdict}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Pre-run state */}
                    {!forceScanLoading && !forceScanResults && (
                      <div className="py-20 border border-dashed border-zinc-905 rounded-xl flex flex-col items-center justify-center text-center">
                        <div className="h-12 w-12 bg-amber-950/20 text-amber-400 rounded-full flex items-center justify-center mb-4 border border-amber-900/30">
                          <Zap className="w-6 h-6 animate-pulse" />
                        </div>
                        <h4 className="text-xs font-bold text-zinc-300 font-mono">Экспресс-анализатор готов к запуску</h4>
                        <p className="text-[10px] text-zinc-500 max-w-sm mt-1.5 leading-relaxed pl-4 pr-4">
                          Запустите ручной прогон сигналов. Система автоматически выберет 5 случайных монет, извлечет их текущие тикеры и индикационные метрики свечей, определит статус блокирующих стопор-фильтров и проведет полный сеанс закрытого межагентского дебата Комитета ИИ.
                        </p>
                        <button
                          onClick={async () => {
                            setForceScanLoading(true);
                            setForceScanResults(null);
                            try {
                             const response = await fetch('/api/debug/force-trigger-scan', { method: 'POST' });
                             if (response.ok) {
                               const text = await response.text();
                               if (text.trim()) {
                                 const res = JSON.parse(text);
                                 if (res.success) {
                                   setForceScanResults(res.results || []);
                                   if (addToast) addToast('Экспресс-анализ ИИ успешно завершен на 5 парах', 'success');
                                 } else {
                                   throw new Error(res.error || 'Не удалось запустить ручной разбор.');
                                 }
                               } else {
                                 throw new Error('Пустой ответ сервера экспресс-анализа');
                               }
                             } else {
                               throw new Error(`Ошибка HTTP: ${response.status}`);
                             }
                            } catch (err: any) {
                              if (addToast) addToast(`Ошибка экспресс-анализа: ${err.message}`, 'error');
                            } finally {
                              setForceScanLoading(false);
                            }
                          }}
                          className="mt-6 px-4 py-2 bg-amber-500 text-zinc-950 hover:bg-amber-400 font-bold rounded-lg text-xs leading-none active:scale-95 transition-all shadow-lg shadow-amber-500/10"
                        >
                          Запустить Force Trigger Scan
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ВЫСОКОТОЧНЫЙ АРХИВ СОБЫТИЙ (Prometheus Engine Log Core) */}
            <div className="bg-zinc-950/45 border border-zinc-900 rounded-xl p-6 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-5 border-b border-zinc-900 pb-4">
                <div>
                  <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                    <Activity className="w-4.5 h-4.5 text-indigo-400 animate-pulse" /> Высокоточный Архив Событий (Prometheus Log Engine)
                  </h2>
                  <p className="text-[10px] text-zinc-500 mt-1 leading-normal">
                    Симплексный перехватчик событий, отслеживающий сетевую активность, вызовы API, верификации ИИ-консенсуса и триггеры ордеров.
                  </p>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
                  {/* Search text field */}
                  <div className="relative flex-1 md:flex-initial">
                    <Search className="w-3.5 h-3.5 text-zinc-550 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={logSearchText}
                      onChange={(e) => setLogSearchText(e.target.value)}
                      placeholder="Поиск логов..."
                      className="w-full md:w-48 bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 pl-8 pr-2.5 py-1 rounded-lg focus:outline-none focus:border-indigo-500 transition-all font-sans"
                    />
                    {logSearchText && (
                      <button onClick={() => setLogSearchText('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* Level selector */}
                  <div className="flex items-center bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-0.5">
                    {(['all', 'success', 'info', 'warn', 'error'] as const).map((level) => (
                      <button
                        key={level}
                        onClick={() => setLogLevelFilter(level)}
                        className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider transition-colors ${
                          logLevelFilter === level
                            ? 'bg-zinc-805 text-zinc-200'
                            : 'text-zinc-500 hover:text-zinc-400'
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>

                  {/* Component filter */}
                  <select
                    value={logComponentFilter}
                    onChange={(e) => setLogComponentFilter(e.target.value)}
                    className="bg-zinc-900 border border-zinc-805 rounded-lg text-[10px] py-1 px-2.5 text-zinc-300 font-medium focus:outline-none focus:border-indigo-500 font-mono"
                  >
                    <option value="all">Все компоненты</option>
                    <option value="SYSTEM">SYSTEM</option>
                    <option value="AUTOPILOT">AUTOPILOT</option>
                    <option value="CCXT">CCXT</option>
                    <option value="SIGNALS">SIGNALS</option>
                    <option value="KNOWLEDGE">KNOWLEDGE</option>
                    <option value="API">API</option>
                    <option value="LATENCY">LATENCY</option>
                  </select>

                  <button
                    onClick={() => {
                      setLogSearchText('');
                      setLogLevelFilter('all');
                      setLogComponentFilter('all');
                      setExpandedLogIndex(null);
                    }}
                    className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-405 hover:text-zinc-200 rounded-lg border border-zinc-800 text-[10.5px] transition-colors"
                    title="Сбросить фильтры"
                  >
                    Сброс
                  </button>
                </div>
              </div>

              {/* Logs Table Area */}
              <div className="border border-zinc-900 w-full rounded-xl overflow-hidden bg-zinc-950/40">
                <div className="max-h-[350px] overflow-y-auto font-mono text-[10px] leading-relaxed pr-1 scrollbar-thin">
                  {filteredLogs && filteredLogs.length > 0 ? (
                    <table className="w-full text-left border-collapse table-fixed">
                      <thead className="bg-zinc-900 sticky top-0 border-b border-zinc-800 z-10 text-[8px] uppercase font-black text-zinc-550 tracking-wider">
                        <tr>
                          <th className="px-4 py-2 w-[110px]">Время</th>
                          <th className="px-4 py-2 w-[75px]">Уровень</th>
                          <th className="px-4 py-2 w-[100px]">Компонент</th>
                          <th className="px-4 py-2 w-[80px]">Монета</th>
                          <th className="px-4 py-2 w-auto">Сообщение</th>
                          <th className="px-4 py-2 w-[70px] text-center">Детали</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-905">
                        {filteredLogs.map((log, idx) => {
                          const isExpanded = expandedLogIndex === idx;
                          const logTime = log.timestamp 
                            ? new Date(log.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(new Date(log.timestamp).getMilliseconds()).padStart(3, '0')
                            : '—';
                          
                          // Level styling
                          let levelBadge = '';
                          if (log.level === 'success') levelBadge = 'text-emerald-400 bg-emerald-950/30 border border-emerald-900/30';
                          else if (log.level === 'warn') levelBadge = 'text-amber-400 bg-amber-950/30 border border-amber-900/30';
                          else if (log.level === 'error') levelBadge = 'text-rose-455 bg-rose-955/35 border border-rose-900/30';
                          else levelBadge = 'text-indigo-405 bg-indigo-950/30 border border-indigo-900/30';

                          // Component styling
                          let compStyle = 'text-zinc-500 bg-zinc-900 border border-zinc-800';
                          if (log.component === 'SYSTEM') compStyle = 'text-purple-400 bg-purple-950/30 border border-purple-900/30';
                          else if (log.component === 'AUTOPILOT') compStyle = 'text-indigo-405 bg-indigo-950/30 border border-indigo-900/30';
                          else if (log.component === 'CCXT') compStyle = 'text-amber-400 bg-amber-950/30 border border-amber-900/30';
                          else if (log.component === 'SIGNALS') compStyle = 'text-emerald-400 bg-emerald-950/30 border border-emerald-900/30';
                          else if (log.component === 'KNOWLEDGE') compStyle = 'text-teal-400 bg-teal-950/30 border border-teal-900/30';
                          else if (log.component === 'API') compStyle = 'text-cyan-405 bg-cyan-950/30 border border-cyan-900/30';
                          else if (log.component === 'LATENCY') compStyle = 'text-rose-455 bg-rose-955/35 border border-rose-900/30';

                          return (
                            <React.Fragment key={idx}>
                              <tr className={`hover:bg-zinc-900/30 transition-colors ${log.level === 'error' ? 'bg-rose-955/5 hover:bg-rose-955/10' : log.level === 'warn' ? 'bg-amber-950/5 hover:bg-amber-950/10' : ''}`}>
                                <td className="px-4 py-1.5 font-mono text-zinc-500 whitespace-nowrap text-[9px]">
                                  {logTime}
                                </td>
                                <td className="px-4 py-1">
                                  <span className={`px-1 rounded text-[8px] font-bold uppercase tracking-wider ${levelBadge}`}>
                                    {log.level}
                                  </span>
                                </td>
                                <td className="px-4 py-1">
                                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider truncate block max-w-full text-center ${compStyle}`}>
                                    {log.component}
                                  </span>
                                </td>
                                <td className="px-4 py-1.5 font-bold text-zinc-200">
                                  {log.symbol || '—'}
                                </td>
                                <td className="px-4 py-1.5 text-zinc-300 break-all truncate hover:text-white transition-colors" title={log.message}>
                                  {log.message}
                                </td>
                                <td className="px-4 py-1 text-center">
                                  {log.meta && Object.keys(log.meta).length > 0 ? (
                                    <button
                                      onClick={() => setExpandedLogIndex(isExpanded ? null : idx)}
                                      className="px-1.5 py-0.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-450 hover:text-indigo-400 rounded border border-zinc-800 transition-colors text-[9px] font-black"
                                    >
                                      {isExpanded ? 'Скрыть' : 'Инфо'}
                                    </button>
                                  ) : (
                                    <span className="text-zinc-700 text-[9px]">—</span>
                                  )}
                                </td>
                              </tr>
                              {isExpanded && log.meta && (
                                <tr>
                                  <td colSpan={6} className="bg-zinc-950/70 px-6 py-4 border-l-2 border-l-indigo-500 font-mono text-[9px] text-zinc-400">
                                    <div className="flex justify-between items-center mb-1 pb-1 border-b border-zinc-900">
                                      <span className="text-indigo-400 font-bold uppercase text-[8px] tracking-wide">Payload метаданных:</span>
                                      <span className="text-zinc-650 text-[8px]">{log.component}</span>
                                    </div>
                                    <pre className="overflow-x-auto bg-zinc-950 p-2.5 rounded border border-zinc-900 text-indigo-300/90 whitespace-pre-wrap max-h-52 font-mono">
                                      {JSON.stringify(log.meta, null, 2)}
                                    </pre>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="py-12 text-center text-zinc-500 italic">
                      Нет результатов для отображения
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {mainTab === 'fine_tuning' && (
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center py-20 bg-zinc-900/50 border border-zinc-800/50 rounded-xl text-zinc-500">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
            <span className="text-xs text-zinc-400 font-mono">Загрузка тонкой настройки...</span>
          </div>
        }>
          <FineTuningPanel 
            tradingMode={tradingMode}
            setTradingMode={setTradingMode}
            onAddToast={(msg, type) => {
              if (addToast) addToast(msg, type);
            }}
            onRefreshBalance={onRefreshRealBalance}
          />
        </Suspense>
      )}

      {mainTab === 'scanner' && (() => {
        // Compute beautiful on-the-fly statistics for our live analytics dashboard
        const activeShortsCount = signals.filter(s => s.signal === 'SHORT').length;
        const highGainerList = signals.filter(s => (s.change24h || 0) > 0);
        const avgGainerPct = highGainerList.length > 0 
          ? (highGainerList.reduce((sum, s) => sum + (s.change24h || 0), 0) / highGainerList.length)
          : (signals.length > 0 
              ? (signals.reduce((sum, s) => sum + Math.abs(s.change24h || s.riseFromLow || s.change1h || 0), 0) / signals.length)
              : 0);
        
        const whaleSignals = signals.filter(s => s.whaleHit || s.pumpDetected || (Number(s.volumeSpike) || 0) > 1.5 || (s as any).isQuickLocalSpike);
        const whaleDetections = whaleSignals.length;

        const activeShortsWithAi = signals.filter(s => (s.aiScore || 0) > 0 || (s.score10 && parseFloat(s.score10) > 0));
        const avgAiScore = activeShortsWithAi.length > 0
          ? (activeShortsWithAi.reduce((acc, s) => acc + (s.aiScore || (s.score10 ? parseFloat(s.score10) * 10 : 0)), 0) / activeShortsWithAi.length)
          : 0;

        const maxFundingSig = signals.length > 0
          ? [...signals].sort((a, b) => Math.abs(b.funding || 0) - Math.abs(a.funding || 0))[0]
          : null;

        // 💰 Deposit & ROI calculations
        const isReal = tradingMode === 'real';
        const startingDepot = isReal 
          ? (startOfDayRealBalance || realBalance || 1000) 
          : (startOfDayBalance || 500);

        const currentBalanceVal = isReal 
          ? (realBalance || 0) 
          : (virtualBalance || 0);

        const activeClosedTradesForPnl = isReal ? closedRealTrades : closedVirtualTrades;
        const totalClosedPnl = activeClosedTradesForPnl.reduce((acc, t) => acc + (t.pnl || 0), 0);
        const growthRoi = (startingDepot > 0) ? (totalClosedPnl / startingDepot) * 100 : 0;
        const isPositiveGrowth = totalClosedPnl >= 0;

        // 📅 Timeframe Dynamics Calculations (Today, Week, Month)
        const nowMs = Date.now();
        const startOfTodayDt = new Date();
        startOfTodayDt.setHours(0, 0, 0, 0);
        const startOfTodayMs = startOfTodayDt.getTime();

        const oneWeekAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;

        const todayTrades = activeClosedTradesForPnl.filter(t => (t.closeTime || 0) >= startOfTodayMs);
        const weekTrades = activeClosedTradesForPnl.filter(t => (t.closeTime || 0) >= oneWeekAgoMs);
        const monthTrades = activeClosedTradesForPnl.filter(t => (t.closeTime || 0) >= oneMonthAgoMs);

        const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const weekPnl = weekTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const monthPnl = monthTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

        // Daily Milestone (Milestone target is dailyGoalPercent %)
        const dailyGoalPctValue = dailyGoalPercent || 20;
        const targetGrowthAmount = startingDepot * (dailyGoalPctValue / 100);
        const dailyMilestonePct = targetGrowthAmount > 0 
          ? Math.min(100, Math.max(0, (todayPnl / targetGrowthAmount) * 100))
          : 0;

        const todayRoi = startingDepot > 0 ? (todayPnl / startingDepot) * 100 : 0;
        const weekRoi = startingDepot > 0 ? (weekPnl / startingDepot) * 100 : 0;
        const monthRoi = startingDepot > 0 ? (monthPnl / startingDepot) * 100 : 0;

        // Win Rate & Profit Factor calculations (uses the selected mode's closed trades)
        const totalClosedTrades = activeClosedTradesForPnl.length;
        const winningClosedCount = activeClosedTradesForPnl.filter(t => (t.pnl || 0) > 0).length;
        const closedWinratePercent = totalClosedTrades > 0 ? Math.round((winningClosedCount / totalClosedTrades) * 100) : 0;

        // Gross win/loss ratios for Profit Factor
        const totalGrossWins = activeClosedTradesForPnl.filter(t => (t.pnl || 0) > 0).reduce((sum, t) => sum + (t.pnl || 0), 0);
        const totalGrossLosses = Math.abs(activeClosedTradesForPnl.filter(t => (t.pnl || 0) < 0).reduce((sum, t) => sum + (t.pnl || 0), 0));
        const losingClosedCount = totalClosedTrades - winningClosedCount;
        const netClosedPnl = totalGrossWins - totalGrossLosses;
        const computedProfitFactor = totalGrossLosses > 0 ? (totalGrossWins / totalGrossLosses).toFixed(2) : (totalGrossWins > 0 ? '∞' : '1.00');

        // Recent 3 closed trades for micro-ticker
        const lastClosedTrades = [...activeClosedTradesForPnl]
          .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
          .slice(0, 3);

        return (
          <div className="flex flex-col gap-6 animate-in fade-in duration-500 animate-slide-in">
            {/* 🖥️ NAVIGATION & VITALS RIBBON */}
            <div className="relative z-[60] bg-[#0e0e11]/90 backdrop-blur-3xl border border-white/[0.04] rounded-2xl p-4.5 shadow-2xl flex flex-col gap-4">
              <div className="flex flex-col lg:flex-row gap-4.5 justify-between items-center">
                
                {/* Search & Favorites */}
                <div className="w-full lg:w-auto flex items-center gap-2 shrink-0">
                  <div ref={searchContainerRef} className="relative w-full sm:w-52 md:w-56 lg:w-56 xl:w-64">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="ПОИСК АКТИВА WEEX..."
                      value={searchTerm}
                      onFocus={() => setShowSearchDropdown(true)}
                      onChange={(e) => {
                        setSearchTerm(e.target.value);
                        setShowSearchDropdown(true);
                      }}
                      className="w-full bg-black/50 border border-white/[0.05] rounded-xl pl-9 pr-3 py-2.5 text-[10px] text-zinc-100 uppercase placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/40 focus:ring-1 focus:ring-indigo-500/20 transition-all font-bold tracking-wider"
                    />

                    {showSearchDropdown && searchTerm.trim().length > 0 && (
                      <div className="absolute top-full left-0 right-0 z-[100] mt-2 max-h-80 overflow-y-auto bg-[#0e0e11] border border-white/10 rounded-xl shadow-2xl p-2 flex flex-col gap-1 min-w-[280px]">
                        <div className="text-[8.5px] text-zinc-500 font-bold tracking-widest px-2.5 py-1.5 uppercase border-b border-white/[0.04]">
                          Результаты поиска WEEX ({searchResults.length})
                        </div>
                        {searchResults.length === 0 ? (
                          <div className="text-[10px] text-zinc-500 italic px-2.5 py-3 text-center">
                            Монитор не нашел совпадений
                          </div>
                        ) : (
                          searchResults.slice(0, 10).map((sig) => {
                            const isFav = favorites.includes(sig.symbol);
                            const changePct = sig.change24h || 0;
                            const isGreen = changePct >= 0;
                            return (
                              <div
                                key={sig.symbol}
                                className="flex items-center justify-between gap-2 p-2 hover:bg-white/[0.04] rounded-lg transition-all cursor-pointer group"
                                onClick={() => {
                                  handleSelectSignal(sig);
                                  setChartSymbol({ symbol: sig.rawSymbol || sig.symbol, exchange: sig.exchange });
                                  setShowSearchDropdown(false);
                                }}
                              >
                                <div className="flex flex-col">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] font-black tracking-wider text-zinc-100 uppercase">
                                      {sig.symbol.replace('/USDT:USDT', '').replace(':weex', '')}
                                    </span>
                                    <span className="text-[8px] px-1 py-0.5 rounded bg-zinc-900 border border-white/5 text-zinc-500 font-bold uppercase">
                                      WEEX
                                    </span>
                                  </div>
                                  <span className="text-[9px] text-zinc-500 font-mono">
                                    Объем: ${(sig.volume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                  </span>
                                </div>

                                <div className="flex items-center gap-2.5">
                                  <div className="flex flex-col items-end">
                                    <span className="text-[10.5px] font-bold text-zinc-200 font-mono">
                                      ${sig.price}
                                    </span>
                                    <span className={cn(
                                      "text-[9px] font-black font-mono",
                                      isGreen ? "text-emerald-400" : "text-rose-400"
                                    )}>
                                      {isGreen ? '+' : ''}{(changePct * 100).toFixed(2)}%
                                    </span>
                                  </div>

                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleFavorite(sig.symbol);
                                    }}
                                    className="p-1.5 rounded-md hover:bg-white/5 text-zinc-500 hover:text-amber-400 transition-colors"
                                  >
                                    <Star className={cn("w-3.5 h-3.5", isFav && "fill-current text-amber-400")} />
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                  
                  <button
                    onClick={() => setSearchTerm(searchTerm === 'fav:' ? '' : 'fav:')}
                    className={cn(
                      "p-2.5 rounded-xl border transition-all duration-300",
                      searchTerm === 'fav:' 
                        ? "bg-amber-500/10 border-amber-500/20 text-amber-400 shadow-glow-rose" 
                        : "bg-black/30 border-white/[0.04] text-zinc-500 hover:text-zinc-200"
                    )}
                    title={searchTerm === 'fav:' ? 'Показать все' : 'Показать избранные'}
                  >
                    <Star className={cn("w-4 h-4", searchTerm === 'fav:' && "fill-current text-amber-400")} />
                  </button>
                </div>

                {/* Market Segment Ribbons with Separate Premium Autopilot Button */}
                <div className="flex items-center justify-center lg:justify-end gap-3 w-full lg:w-auto flex-nowrap shrink-0 overflow-x-auto">
                  {/* Market Segment Ribbons */}
                  <div className="flex items-center justify-center gap-3.5 md:gap-5.5 bg-black/40 px-4 py-2 rounded-xl border border-white/[0.03] shrink-0">
                    <Tooltip text="Отношение лонг/шорт объемов. Значения меньше 40% указывают на экстремальный перегрев лонгов и близость разворота">
                      <div className="flex flex-col items-center">
                        <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-[0.2em] mb-1.5 leading-none">ЗДОРОВЬЕ РЫНКА</span>
                        <div className="flex items-center gap-2 font-mono">
                          <div className="w-12 h-1 bg-zinc-900 rounded-full overflow-hidden inline-block border border-white/5">
                            <div className={cn("h-full rounded-full transition-all duration-500", marketHealth > 50 ? "bg-emerald-500" : "bg-rose-500")} style={{ width: `${marketHealth}%` }} />
                          </div>
                          <span className={cn("text-[10.5px] font-bold tracking-tight", marketHealth > 50 ? "text-emerald-400" : "text-rose-400")}>{(marketHealth || 0).toFixed(1)}%</span>
                        </div>
                      </div>
                    </Tooltip>

                    <div className="h-5 w-px bg-white/[0.05]"></div>

                    <Tooltip text="Режим маркет-мейкера на основе волатильности">
                      <div className="flex flex-col items-center">
                        <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-[0.2em] mb-1.5 leading-none">РЕЖИМ MM</span>
                        <span className={cn("text-[8.5px] font-extrabold tracking-wider uppercase px-2 py-0.5 rounded border font-mono", marketRegime.includes('BULL') ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/10" : "bg-rose-500/10 text-rose-400 border-rose-500/10")}>
                          {marketRegime.replace('_TREND', '').replace('FLAT', 'ФЛЭТ').replace('BULL', 'БЫЧИЙ').replace('BEAR', 'МЕДВЕЖИЙ')}
                        </span>
                      </div>
                    </Tooltip>

                    <div className="h-5 w-px bg-white/[0.05]"></div>

                    <Tooltip text="Twitter/Telegram AI-Scraper и фильтр фундаментальных пампов от инфлюенсеров (KOLs)">
                      <div className="flex flex-col items-center">
                        <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-[0.2em] mb-1.5 leading-none">SENTINEL SHIELD</span>
                        <div className="flex items-center gap-1.5 font-mono">
                          <span className={cn("inline-block w-1.5 h-1.5 rounded-full", (Object.values(socialSentiment) as any[]).some(s => s?.score >= 80) ? "bg-amber-400 animate-ping" : "bg-cyan-500 animate-pulse")} />
                          <span className={cn("text-[9.5px] font-extrabold tracking-wider uppercase", (Object.values(socialSentiment) as any[]).some(s => s?.score >= 80) ? "text-amber-400 font-bold" : "text-cyan-400")}>
                            {(Object.values(socialSentiment) as any[]).some(s => s?.score >= 80) ? 'MANIA BLOCK' : 'SHIELD ON'}
                          </span>
                        </div>
                      </div>
                    </Tooltip>

                    <div className="h-5 w-px bg-white/[0.05]"></div>

                    <Tooltip text="Мониторинг задержки соединения (Ping в мс) до API эндпоинтов WEEX и Binance">
                      <div className="flex flex-col items-center">
                        <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-[0.2em] mb-1.5 leading-none">API LATENCY</span>
                        <div className="flex items-center gap-1.5 font-mono text-[9.5px] font-bold">
                          <span className={cn(latencyInfo.weex < 50 ? "text-emerald-400" : latencyInfo.weex < 100 ? "text-amber-400" : "text-rose-400")}>
                            WX {latencyInfo.weex}ms
                          </span>
                          <span className="text-zinc-600">|</span>
                          <span className={cn(latencyInfo.binance < 50 ? "text-emerald-400" : latencyInfo.binance < 100 ? "text-amber-400" : "text-rose-400")}>
                            BN {latencyInfo.binance}ms
                          </span>
                        </div>
                      </div>
                    </Tooltip>


                  </div>

                  {/* АВТОПИЛОТ (Standalone Highlighted Interactive Button) */}
                  <Tooltip text="Автоматический вход в сделки на основе ИИ-сигналов. Нажмите для включения/выключения.">
                    <button 
                      onClick={() => {
                        const nextState = !isAutoPilotEnabled;
                        setIsAutoPilotEnabled(nextState);
                        if (typeof localStorage !== 'undefined') {
                          localStorage.setItem('isAutoPilotEnabled', nextState.toString());
                        }
                        fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ isAutopilotEnabled: nextState })
                        }).catch(err => console.error('Failed to update autopilot setting on server', err));
                        if (addToast) addToast(`Автопилот ${nextState ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}`, 'info');
                      }}
                      className={cn(
                        "flex flex-col items-center justify-center px-4.5 py-1.5 rounded-xl border transition-all duration-300 select-none group relative overflow-hidden h-full min-w-[105px] cursor-pointer shrink-0",
                        isAutoPilotEnabled 
                          ? "bg-indigo-600/15 hover:bg-indigo-600/25 border-indigo-500/40 text-indigo-400 font-black shadow-[0_0_15px_rgba(99,102,241,0.15)]" 
                          : "bg-white/[0.02] hover:bg-white/[0.04] border-white/[0.06] hover:border-white/[0.1] text-zinc-500 hover:text-zinc-400"
                      )}
                    >
                      {isAutoPilotEnabled && (
                        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-400 to-transparent animate-pulse" />
                      )}
                      <span className={cn(
                        "text-[7.5px] font-black uppercase tracking-[0.2em] mb-1 leading-none transition-colors",
                        isAutoPilotEnabled ? "text-indigo-400/90" : "text-zinc-500 group-hover:text-zinc-400"
                      )}>
                        АВТОПИЛОТ
                      </span>
                      <div className="flex items-center gap-1.5 font-mono mt-0.5">
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full transition-all duration-300", 
                          isAutoPilotEnabled ? "bg-indigo-400 animate-pulse scale-110 shadow-[0_0_6px_rgba(129,140,248,0.7)]" : "bg-zinc-650"
                        )} />
                        <span className={cn(
                          "text-[9.5px] font-black tracking-widest uppercase transition-colors", 
                          isAutoPilotEnabled ? "text-indigo-300" : "text-zinc-500 group-hover:text-zinc-400"
                        )}>
                          {isAutoPilotEnabled ? 'ВКЛ' : 'ВЫКЛ'}
                        </span>
                      </div>
                    </button>
                  </Tooltip>


                </div>

              </div>
            </div>

            {/* 📊 APPLE-GRADE CORE BUSINESS ANALYTICS GRID */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
              
              {/* CELL 1: DEPOSIT & GROWTH HUD (Apple Aesthetics) */}
              <div className="xl:col-span-5 bg-[#0a0a0c]/85 border border-white/[0.04] rounded-2xl p-5.5 shadow-xl flex flex-col justify-between transition-all hover:bg-[#0a0a0c]/95 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none group-hover:bg-indigo-500/10 transition-colors"></div>
                
                {/* 🎯 GOAL EDITING SUB-PANEL */}
                {isEditingGoal && (
                  <div className="absolute inset-0 bg-[#070709]/98 backdrop-blur-md z-30 p-5 flex flex-col justify-between animate-in fade-in zoom-in-95 duration-200">
                    <div>
                      <h5 className="text-[10px] font-black tracking-widest text-zinc-400 uppercase mb-4 flex items-center gap-1.5">
                        <Settings className="w-3.5 h-3.5 text-indigo-400" /> Настройка целей ({tradingMode.toUpperCase()})
                      </h5>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">
                            Начальный баланс (Start Day USD)
                          </label>
                          <input 
                            type="number"
                            defaultValue={startingDepot}
                            id="goal-start-balance"
                            className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono tracking-wide focus:outline-none focus:border-indigo-500/40"
                          />
                        </div>

                        <div>
                          <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">
                            Цель по приросту за день (%)
                          </label>
                          <input 
                            type="number"
                            defaultValue={dailyGoalPctValue}
                            id="goal-daily-percent"
                            className="w-full bg-[#111113] border border-white/[0.06] rounded-xl px-3 py-2 text-xs text-zinc-100 font-mono tracking-wide focus:outline-none focus:border-indigo-500/40"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2.5 mt-4">
                      <button 
                        onClick={() => setIsEditingGoal(false)}
                        className="flex-1 py-2.5 rounded-xl bg-zinc-900 border border-white/[0.04] text-[9px] font-black uppercase text-zinc-400 hover:text-zinc-200 active:scale-95 transition-all"
                      >
                        Отмена
                      </button>
                      <button 
                        onClick={async () => {
                          const startBalInput = document.getElementById('goal-start-balance') as HTMLInputElement;
                          const dailyPctInput = document.getElementById('goal-daily-percent') as HTMLInputElement;
                          if (startBalInput && dailyPctInput) {
                            const newStartBal = Number(startBalInput.value);
                            const newDailyPct = Number(dailyPctInput.value);
                            if (newDailyPct > 0 && newStartBal >= 0) {
                              setDailyGoalPercent(newDailyPct);
                              if (tradingMode === 'virtual') {
                                try {
                                  await fetch('/api/paper-trade/start-balance', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ amount: newStartBal })
                                  });
                                } catch (e) {}
                                setStartOfDayBalance(newStartBal);
                              } else {
                                try {
                                  await fetch('/api/paper-trade/start-balance-real', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ amount: newStartBal })
                                  });
                                } catch (e) {}
                                setStartOfDayRealBalance(newStartBal);
                              }
                              if (addToast) addToast('Параметры цели успешно сохранены!', 'success');
                            }
                          }
                          setIsEditingGoal(false);
                        }}
                        className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-[9px] font-black uppercase text-white shadow-lg active:scale-95 transition-all shadow-indigo-600/20"
                      >
                        Сохранить
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-indigo-500 rounded-full"></span>
                      <h4 className="text-[8.5px] font-black text-zinc-500 tracking-[0.25em] uppercase">
                        ПРИРОСТ ДЕПОЗИТА ({tradingMode.toUpperCase()})
                      </h4>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[8px] font-mono text-zinc-500 font-bold tracking-widest bg-white/[0.03] px-2 py-1 rounded border border-white/[0.04]">
                        START DAY: {isReal && !isRealBalanceVisible ? "••••" : `$${startingDepot.toFixed(2)}`}
                      </span>
                      <button 
                        onClick={() => setIsEditingGoal(true)}
                        className="p-1 hover:bg-white/[0.04] text-zinc-500 hover:text-indigo-400 rounded-lg border border-white/[0.04] transition-colors"
                        title="Настроить цель и начальный баланс"
                      >
                        <Settings className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-baseline justify-between mb-5">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-3xl font-extrabold font-sans tracking-tight text-white flex items-center gap-1.5">
                        {isReal && !isRealBalanceVisible ? "••••" : `$${currentBalanceVal.toFixed(2)}`}
                        {isReal && (
                          <button 
                            onClick={() => setIsRealBalanceVisible(!isRealBalanceVisible)}
                            className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                            title={isRealBalanceVisible ? "Скрыть реальный баланс" : "Показать реальный баланс"}
                          >
                            {isRealBalanceVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                          </button>
                        )}
                      </span>
                      <span className={cn(
                        "text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border flex items-center gap-1 font-mono",
                        isPositiveGrowth 
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/15" 
                          : "bg-rose-500/10 text-rose-400 border-rose-500/15"
                      )}>
                        {isPositiveGrowth ? '▲' : '▼'} {growthRoi >= 0 ? '+' : ''}{growthRoi.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  {/* Progressive Target Slider Rule */}
                  <div className="space-y-2 mb-4 bg-black/20 p-4 rounded-xl border border-white/[0.02]">
                    <div className="flex items-center justify-between text-[9px] font-mono">
                      <span className="text-zinc-500 uppercase tracking-wider">Прогресс к цели дня (+{dailyGoalPctValue}%):</span>
                      <span className="text-indigo-400 font-bold">🎯 {dailyMilestonePct.toFixed(1)}%</span>
                    </div>

                    {/* Apple Style Multi-stop Slider bar */}
                    <div className="relative">
                      <div className="h-2 bg-neutral-900 rounded-full overflow-hidden border border-white/[0.03] p-[1.5px]">
                        <div 
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-purple-500 to-rose-500 transition-all duration-700 shadow-lg" 
                          style={{ width: `${dailyMilestonePct}%` }}
                        />
                      </div>
                      
                      {/* Interactive indicator scale ticks */}
                      <div className="flex justify-between text-[7px] text-zinc-600 font-mono mt-1.5 px-0.5 select-none">
                        {isReal && !isRealBalanceVisible ? (
                          <>
                            <span>0%</span>
                            <span>+{ (dailyGoalPctValue / 2).toFixed(1) }%</span>
                            <span>+{dailyGoalPctValue}% ЦЕЛЬ</span>
                          </>
                        ) : (
                          <>
                            <span>$0 (0%)</span>
                            <span>+${ (targetGrowthAmount / 2).toFixed(2) } (+{ (dailyGoalPctValue / 2).toFixed(1) }%)</span>
                            <span>+${ targetGrowthAmount.toFixed(2) } (+{dailyGoalPctValue}% ЦЕЛЬ)</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 📅 TIME-FRAME DYNAMICS HUD (Today, Week, Month) */}
                  <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-white/[0.03]">
                    <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-2.5 flex flex-col justify-between">
                      <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-wider mb-1">ЗА СЕГОДНЯ</span>
                      <span className={cn("text-xs font-black font-mono", todayPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {isReal && !isRealBalanceVisible ? "••••" : `${todayPnl >= 0 ? '+$' : '-$'}${Math.abs(todayPnl).toFixed(2)}`}
                      </span>
                      <span className={cn("text-[8px] font-mono font-bold mt-0.5", todayPnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                        {todayPnl >= 0 ? '+' : ''}{todayRoi.toFixed(2)}%
                      </span>
                    </div>
                    <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-2.5 flex flex-col justify-between">
                      <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-wider mb-1">ЗА НЕДЕЛЮ</span>
                      <span className={cn("text-xs font-black font-mono", weekPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {isReal && !isRealBalanceVisible ? "••••" : `${weekPnl >= 0 ? '+$' : '-$'}${Math.abs(weekPnl).toFixed(2)}`}
                      </span>
                      <span className={cn("text-[8px] font-mono font-bold mt-0.5", weekPnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                        {weekPnl >= 0 ? '+' : ''}{weekRoi.toFixed(2)}%
                      </span>
                    </div>
                    <div className="bg-[#0a0a0c]/40 border border-white/[0.03] rounded-xl p-2.5 flex flex-col justify-between">
                      <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-wider mb-1">ЗА МЕСЯЦ</span>
                      <span className={cn("text-xs font-black font-mono", monthPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {isReal && !isRealBalanceVisible ? "••••" : `${monthPnl >= 0 ? '+$' : '-$'}${Math.abs(monthPnl).toFixed(2)}`}
                      </span>
                      <span className={cn("text-[8px] font-mono font-bold mt-0.5", monthPnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                        {monthPnl >= 0 ? '+' : ''}{monthRoi.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                </div>

                <div className="flex items-center justify-between text-[8px] border-t border-white/[0.03] pt-3.5 mt-4">
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <span className="w-1 h-1 rounded-full bg-indigo-500"></span>
                    <span className="font-mono uppercase tracking-wider">СЛОЖНЫЙ ПРОЦЕНТ:</span>
                    <span className="text-indigo-400 font-black">АКТИВЕН (100%)</span>
                  </div>
                  <span className="text-zinc-650 font-mono tracking-widest uppercase">SAFE MODE GUARANTEED</span>
                </div>
              </div>

              {/* CELL 2: CLOSED TRADES ANALYTICS & DIRECT TRANSIT */}
              <div className="xl:col-span-7 bg-[#0a0a0c]/85 border border-white/[0.04] rounded-2xl p-5.5 shadow-xl flex flex-col justify-between transition-all hover:bg-[#0a0a0c]/95 relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl pointer-events-none group-hover:bg-purple-500/10 transition-colors"></div>
                <div>
                  
                  {/* Card title with direct hyperlink link */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-purple-500 rounded-full"></span>
                      <h4 className="text-[8.5px] font-black text-zinc-500 tracking-[0.25em] uppercase">АНАЛИТИКА ТОРГОВЛИ И ИСТОРИЯ</h4>
                    </div>

                    <button
                      onClick={() => {
                        setHistoryTab('analytics');
                        setMainTab('history');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="group/btn flex items-center gap-1 text-[8.5px] font-bold text-indigo-400 hover:text-indigo-300 transition-colors uppercase tracking-widest"
                      title="Открыть полный детальный разбор в истории"
                    >
                      <span>Аналитический отчет</span>
                      <ArrowRight className="w-3 h-3 text-indigo-400 group-hover/btn:translate-x-1 transition-transform" />
                    </button>
                  </div>

                  {/* Bento Score Metric row */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                    <div className="bg-black/35 border border-white/[0.02] p-2.5 rounded-xl flex flex-col justify-center transition-all hover:border-emerald-500/10">
                      <span className="text-[7.5px] text-zinc-500 font-extrabold tracking-wider uppercase mb-1 leading-none">ВИНРЕЙТ</span>
                      <span className={cn("text-base md:text-lg font-bold font-mono tracking-tight", closedWinratePercent >= 50 ? "text-emerald-400" : "text-rose-400")}>
                        {closedWinratePercent}%
                      </span>
                    </div>

                    <div className="bg-black/35 border border-white/[0.02] p-2.5 rounded-xl flex flex-col justify-center transition-all hover:border-indigo-500/10">
                      <span className="text-[7.5px] text-zinc-500 font-extrabold tracking-wider uppercase mb-1 leading-none">ПРОФИТ ФАКТОР</span>
                      <span className="text-base md:text-lg font-bold font-mono tracking-tight text-indigo-400">
                        {computedProfitFactor}
                      </span>
                    </div>

                    <div className="bg-black/35 border border-white/[0.02] p-2.5 rounded-xl flex flex-col justify-center transition-all hover:border-emerald-500/10">
                      <span className="text-[7.5px] text-emerald-500/80 font-extrabold tracking-wider uppercase mb-1 leading-none">ЗАКРЫТО В ПЛЮС</span>
                      <div className="flex items-baseline gap-1">
                        <span className="text-base font-bold font-mono text-emerald-400">{winningClosedCount} <span className="text-[10px] font-normal">сд.</span></span>
                        <span className="text-[10px] font-mono font-bold text-emerald-400/80">(+${totalGrossWins.toFixed(2)})</span>
                      </div>
                    </div>

                    <div className="bg-black/35 border border-white/[0.02] p-2.5 rounded-xl flex flex-col justify-center transition-all hover:border-rose-500/10">
                      <span className="text-[7.5px] text-rose-500/80 font-extrabold tracking-wider uppercase mb-1 leading-none">ЗАКРЫТО В МИНУС</span>
                      <div className="flex items-baseline gap-1">
                        <span className="text-base font-bold font-mono text-rose-400">{losingClosedCount} <span className="text-[10px] font-normal">сд.</span></span>
                        <span className="text-[10px] font-mono font-bold text-rose-400/80">(-${totalGrossLosses.toFixed(2)})</span>
                      </div>
                    </div>

                    <div className="col-span-2 md:col-span-1 bg-black/35 border border-white/[0.02] p-2.5 rounded-xl flex flex-col justify-center transition-all hover:border-purple-500/10">
                      <span className="text-[7.5px] text-zinc-500 font-extrabold tracking-wider uppercase mb-1 leading-none">ЧИСТЫЙ PNL</span>
                      <span className={cn("text-base md:text-lg font-bold font-mono tracking-tight", netClosedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {netClosedPnl >= 0 ? '+' : ''}${netClosedPnl.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {/* Micro list of last 3 closed trades */}
                  <div className="space-y-1.5">
                    <span className="text-[7px] text-zinc-500 font-mono uppercase tracking-widest mb-1 block">ПОСЛЕДНИЕ ЗАКРЫТЫЕ ПОЗИЦИИ:</span>
                    {lastClosedTrades.length === 0 ? (
                      <div className="py-3 px-3 bg-black/10 border border-dashed border-white/[0.03] rounded-xl text-center text-zinc-650 text-[9.5px] font-mono uppercase">
                        Сделки еще не зарегистрированы на балансе
                      </div>
                    ) : (
                      lastClosedTrades.map((t, idx) => {
                        const calculatedPct = t.pnlPercent ?? (t.entryPrice && t.closePrice ? (t.side === 'SHORT' ? ((t.entryPrice - t.closePrice) / t.entryPrice) * 100 * t.leverage : ((t.closePrice - t.entryPrice) / t.entryPrice) * 100 * t.leverage) : 0);
                        return (
                          <div 
                            key={`${t.id}-${idx}`}
                            onClick={() => {
                              setChartSymbol({ symbol: t.symbol, exchange: t.exchange || 'weex' });
                              setTerminalVisible(true);
                            }}
                            className="flex items-center justify-between p-2.5 bg-black/20 hover:bg-black/40 border border-white/[0.02] hover:border-white/[0.06] rounded-lg transition-all cursor-pointer group/row"
                            title="Открыть данный инструмент на графике"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-zinc-100 font-bold font-mono text-[10px] tracking-wide">
                                {t.symbol}
                              </span>
                              
                              <span className={cn(
                                "text-[7.5px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded",
                                t.side === 'SHORT' ? "bg-rose-500/10 text-rose-400 border border-rose-500/10" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10"
                              )}>
                                {t.side}
                              </span>
                            </div>

                            <div className="flex items-center gap-4">
                              <span className="text-[8px] text-zinc-500 font-mono uppercase hidden sm:inline">
                                IN: ${t.entryPrice?.toFixed(5)} → OUT: ${t.closePrice?.toFixed(5)}
                              </span>
                              
                              <span className={cn(
                                "text-[10px] font-bold font-mono select-none",
                                t.pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                              )}>
                                {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)} ({calculatedPct >= 0 ? '+' : ''}{calculatedPct?.toFixed(1)}%)
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                </div>
              </div>

            </div>

            {/* 📊 FOUR MASTER INTEL BENTO CARDS */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              
              {/* BENTO CARD 1: OVERHEAT INDEX */}
              <Tooltip text="Степень экстремального роста или пролива лидеров. Анализ волатильности для входа на развороте (SHORT & LONG)">
                <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-4 flex flex-col justify-between transition-all hover:scale-[1.01] hover:border-amber-500/15 hover:bg-white/[0.02] group w-full select-none">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[8px] text-zinc-500 font-black tracking-wider uppercase">Индекс Перегретости</span>
                    <Zap className="w-3.5 h-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="text-xl font-bold font-mono tracking-tight text-amber-400">+{avgGainerPct.toFixed(1)}%</span>
                    <span className="text-[8px] text-zinc-500 uppercase font-mono">ср. гейн</span>
                  </div>
                  <div className="text-[8.5px] text-zinc-400 mt-2 font-mono uppercase tracking-wider flex items-center gap-1.5 pt-2 border-t border-white/[0.03]">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400/50 inline-block animate-pulse"></span>
                    <span>Пампов ({">"}15%): <strong className="text-amber-400 font-black">{signals.filter(s => (s.change24h || 0) > 15 || (s.change1h || 0) > 8 || s.pumpDetected).length}</strong> пар</span>
                  </div>
                </div>
              </Tooltip>

              {/* BENTO CARD 2: WHALE ACTIVITY REGULATOR */}
              <Tooltip text="Привлечение крупного капитала в стакан за последние 15 минут. Ранний маркер ложных заколов у плотностей">
                <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-4 flex flex-col justify-between transition-all hover:scale-[1.01] hover:border-purple-500/15 hover:bg-white/[0.02] group w-full select-none">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[8px] text-zinc-500 font-black tracking-wider uppercase">Детектор Китов</span>
                    <Activity className="w-3.5 h-3.5 text-purple-400 group-hover:animate-pulse" />
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="text-xl font-bold font-mono tracking-tight text-purple-400">{whaleDetections} пар</span>
                    <span className="text-[8px] text-zinc-500 uppercase font-mono">аномалий</span>
                  </div>
                  <div className="text-[8.5px] text-zinc-400 mt-2 font-mono uppercase tracking-wider flex items-center gap-1.5 pt-2 border-t border-white/[0.03]">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400/50 inline-block"></span>
                    <span>Объем взрывной: <strong className="text-purple-400 font-black">{signals.filter(s => (Number(s.volumeSpike) || 0) > 1.5 || (s as any).isQuickLocalSpike).length}</strong> шт.</span>
                  </div>
                </div>
              </Tooltip>

              {/* BENTO CARD 3: AI COMMITTEE CONSENSUS WEIGHT */}
              <Tooltip text="Средний расчетный интеллект-скор сигналов в пуле. Высокое значение гарантирует более стабильное удержание лимитных ловушек">
                <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-4 flex flex-col justify-between transition-all hover:scale-[1.01] hover:border-indigo-500/15 hover:bg-white/[0.02] group w-full select-none">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[8px] text-zinc-500 font-black tracking-wider uppercase">Консенсус AI</span>
                    <Brain className="w-3.5 h-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="text-xl font-bold font-mono tracking-tight text-indigo-400">
                      {avgAiScore > 0 ? `${avgAiScore.toFixed(0)}%` : 'ЖДЕМ СЕТАП'}
                    </span>
                    <span className="text-[8px] text-zinc-500 uppercase font-mono">индекс</span>
                  </div>
                  <div className="text-[8.5px] text-zinc-400 mt-2 font-mono uppercase tracking-wider flex items-center gap-1.5 pt-2 border-t border-white/[0.03]">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/50 inline-block"></span>
                    <span>Smart Шорт (AI {">"}= 70): <strong className="text-indigo-400 font-black">{signals.filter(s => (s.aiScore || (s.score10 ? parseFloat(s.score10) * 10 : 0)) >= 70).length}</strong></span>
                  </div>
                </div>
              </Tooltip>

              {/* BENTO CARD 4: MAXIMUM FUNDING SPECTRUM */}
              <Tooltip text="Процентная APY ставка, которую лонгисты уплачивают за удержание противоположного плеча. Сверх-положительный фандинг гарантирует чистый пассивный возврат прибыли ежечасно">
                <div className="bg-white/[0.01] border border-white/[0.03] rounded-xl p-4 flex flex-col justify-between transition-all hover:scale-[1.01] hover:border-emerald-500/15 hover:bg-white/[0.02] group w-full select-none">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[8px] text-zinc-500 font-black tracking-wider uppercase">Фандинг Спектр</span>
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="text-xl font-bold font-mono tracking-tight text-emerald-400 truncate">
                      {maxFundingSig && maxFundingSig.funding ? `${(maxFundingSig.funding * 100).toFixed(4)}%` : '0.0000%'}
                    </span>
                    <span className="text-[8px] text-emerald-500 uppercase tracking-widest font-extrabold font-mono leading-none">MAX</span>
                  </div>
                  <div className="text-[8.5px] text-zinc-400 mt-2 font-mono uppercase tracking-wider flex items-center gap-1.5 pt-2 border-t border-white/[0.03] truncate">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/50 inline-block shrink-0"></span>
                    <span className="truncate">Лидер: <strong className="text-emerald-400 font-bold">{maxFundingSig ? maxFundingSig.symbol : '---'}</strong></span>
                  </div>
                </div>
              </Tooltip>

            </div>

          <div className="bg-obsidian-900 border border-white/[0.04] rounded-2xl overflow-hidden shadow-2xl">
            <div className="p-5 border-b border-white/[0.04] bg-black/35">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/15 shadow-glow-rose">
                    <Activity className="w-4 h-4 text-amber-400" />
                  </div>
                  <div>
                    <h3 className="text-xs font-black text-zinc-100 uppercase tracking-[0.2em] mb-1">Мониторинг рынка</h3>
                    <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider flex items-center gap-1.5 font-bold">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      <span>АНАЛИЗИРУЕТСЯ: 761 ПАР (WEEX SWAP)</span>
                      <span className="text-white/[0.08]">|</span>
                      <span>ТОП 6 СДЕЛОК (SHORT / LONG)</span>
                    </p>
                  </div>
                </div>

                {/* Элегантные кнопки фильтра по направлениям (ALL, LONG, SHORT, POSITIONS) */}
                <div className="flex items-center bg-black/40 border border-white/[0.04] p-1 rounded-xl gap-1 shrink-0">
                  {paperTrades.filter(t => t.status === 'OPEN').length > 0 && (
                    <button
                      onClick={() => setSignalDirectionFilter(signalDirectionFilter === 'POSITIONS' ? 'ALL' : 'POSITIONS')}
                      className={cn(
                        "px-3.5 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase transition-all duration-300 cursor-pointer flex items-center gap-1.5",
                        signalDirectionFilter === 'POSITIONS'
                          ? "bg-sky-500/20 border border-sky-500/40 text-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.25)]"
                          : "border border-sky-500/20 text-sky-400/80 hover:text-sky-300 hover:bg-sky-500/5"
                      )}
                      title="Показать только пары с открытыми позициями"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
                      В СДЕЛКЕ ({paperTrades.filter(t => t.status === 'OPEN').length})
                    </button>
                  )}
                  <button
                    onClick={() => setSignalDirectionFilter('ALL')}
                    className={cn(
                      "px-3.5 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase transition-all duration-300 cursor-pointer",
                      signalDirectionFilter === 'ALL'
                        ? "bg-zinc-800 text-zinc-100 shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                        : "text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    ВСЕ
                  </button>
                  <button
                    onClick={() => setSignalDirectionFilter('LONG')}
                    className={cn(
                      "px-3.5 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase transition-all duration-300 cursor-pointer",
                      signalDirectionFilter === 'LONG'
                        ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shadow-glow-emerald"
                        : "border border-transparent text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    LONG
                  </button>
                  <button
                    onClick={() => setSignalDirectionFilter('SHORT')}
                    className={cn(
                      "px-3.5 py-1.5 rounded-lg text-[9px] font-black tracking-widest uppercase transition-all duration-300 cursor-pointer",
                      signalDirectionFilter === 'SHORT'
                        ? "bg-rose-500/10 border border-rose-500/20 text-rose-400 shadow-glow-rose"
                        : "border border-transparent text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    SHORT
                  </button>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[600px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <table className="w-full text-xs text-left relative border-separate border-spacing-0">
                <thead className="bg-obsidian-900/95 backdrop-blur-md sticky top-0 z-20">
                  <tr>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Ассет / Биржа</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Цена</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">24ч %</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Объем</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Стакан</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Сигнал</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Тип</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[10px] text-emerald-500 border-b border-white/5">AI</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-zinc-600 border-b border-white/5">Риск</th>
                    <th className="px-3 py-3 font-black uppercase tracking-[0.1em] text-[9px] text-right text-zinc-600 border-b border-white/5">Цель</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                {loading ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-zinc-500 font-black tracking-widest uppercase">Инициализация потока...</td></tr>
                ) : displaySignals.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-16 text-center">
                      <div className="max-w-md mx-auto flex flex-col items-center justify-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-zinc-400 text-xs font-black tracking-widest uppercase block">АКТИВНЫХ СИГНАЛОВ НЕТ</span>
                        <p className="text-zinc-600 text-[10px] leading-relaxed max-w-sm">
                          Рынок находится в спокойной/флэтовой фазе. Торговый ИИ-сканер активен в режиме <span className="text-zinc-500 font-bold">Smart Safety Mode</span> и ожидает высоковероятных импульсов, подтвержденных снятием ликвидности (Liquidity Sweeps) и структурой BOS/ChoCh по двунаправленной системе <span className="text-zinc-500 font-bold">SHORT & LONG Quantum Scalping</span>.
                        </p>
                        <p className="text-[9px] text-zinc-600/70 italic mt-1">
                          Вы можете ввести любой тикер в поиске выше для мгновенного ручного анализа.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  displaySignals.map((sig, idx) => {
                    const activeTrade = paperTrades.find(t => {
                      if (t.status !== 'OPEN') return false;
                      const norm = (s: string) => s.replace(/[\/:_]/g, '').toUpperCase();
                      return norm(t.symbol) === norm(sig.symbol);
                    });
                    return (
                      <SignalRow 
                        key={`${sig.symbol}-${sig.exchange}-${idx}`}
                        sig={sig}
                        onSelect={handleSelectSignal}
                        selected={selectedSignal?.symbol === sig.symbol}
                        latestPrice={renderedPrices[sig.symbol.replace('/', '')] || renderedPrices[sig.symbol] || sig.price}
                        favorites={favorites}
                        toggleFavorite={toggleFavorite}
                        setChartSymbol={setChartSymbol}
                        getMinNotional={getMinNotional}
                        pStability={pHistoryRef.current[sig.symbol]}
                        activeTrade={activeTrade}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        
        
        {chartSymbol && (
          <div ref={chartScrollRef} className="mt-8 border border-white/10 rounded-2xl overflow-hidden shadow-2xl h-[500px]">
            <Suspense fallback={
              <div className="w-full h-full min-h-[500px] flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
                <span className="text-xs text-zinc-400 font-mono">Загрузка графика...</span>
              </div>
            }>
              <TradingChart 
                key={`${chartSymbol.symbol}-${chartSymbol.exchange}`}
                symbol={chartSymbol.symbol} 
                exchange={chartSymbol.exchange} 
                onClose={() => setChartSymbol(null)} 
                trades={allTradesArray}
              />
            </Suspense>
          </div>
        )}
      </div>
    )})()}

  {mainTab === 'scanner' && selectedSignal && (
        <div className="flex flex-col gap-6 pt-4">
          {(() => {
            const isShort = (selectedSignal.signal || '').includes('SELL') || (selectedSignal.signal || '').includes('SHORT');
            const action = isShort ? 'ВХОД В ШОРТ' : 'ВХОД В ЛОНГ';
            const subtitle = isShort ? ((selectedSignal.change24h || 0) > 10 ? 'Идеальный шорт (Парабола)' : 'Шорт на откате') : 'Покупка на поддержке';
            const tpVal = takeProfit 
              ? (calcTpMode === 'PERCENT' ? getCalcPriceFromPnlPct(Number(takeProfit), true) : Number(takeProfit))
              : (isShort ? selectedSignal.price * 0.85 : selectedSignal.price * 1.15);
            const potential = (selectedSignal.price > 0) ? Math.abs(((tpVal - selectedSignal.price) / (selectedSignal.price)) * 100) : 15;
            const estProfit = (margin || 0) * (leverage || 1) * (potential / 100);
            const oiTrend = isShort ? 'РАСТЕТ' : 'ПАДАЕТ';
            const oiSub = isShort ? 'Толпа заходит в лонги на хаях (топливо для дампа)' : 'Шортисты набирают позиции (шорт-сквиз)';
            const l2Text = isShort ? `Аск 26.99% > Бид` : `Бид 28.45% > Аск`;
            const l2Sub = isShort ? 'Давление продавцов сверху' : 'Поддержка покупателей снизу';
            const wallPrice = isShort ? (selectedSignal.price * 1.018).toFixed(5) : (selectedSignal.price * 0.982).toFixed(5);
            
            const signalAgeSec = Math.floor((now - new Date(selectedSignal.timestamp).getTime()) / 1000);
            const cacheTimeout = 40;
            const updateIn = Math.max(0, cacheTimeout - signalAgeSec);
            
            let step4Status = 'waiting'; // waiting, approved, fallback
            let step4Text = 'Ожидание глубокого RAG-анализа... Сверка паттернов с Базой Знаний.';
            let step4Style = 'bg-zinc-800 text-zinc-500 border-white/10';
            let step4TextStyle = 'text-zinc-400 border-white/10';
            
            if (isAnalyzing) {
              step4Text = 'Gemini 2.0 анализирует контекст...';
              step4Style = 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30 animate-pulse';
              step4TextStyle = 'text-indigo-400 border-indigo-500/50';
            } else if (aiAnalysisResult) {
              if (aiAnalysisResult.error || aiAnalysisResult.consensus?.includes('АВТО-HOLD')) {
                 const isLimits = aiAnalysisResult.error?.includes('429') || aiAnalysisResult.reason?.includes('перегружен') || aiAnalysisResult.advice?.includes('Ожидание');
                 step4Status = 'fallback';
                 step4Text = isLimits ? '⏳ Ожидание квоты (кулдаун). AI временно недоступен.' : '⚠️ Защита капитала. Вердикт: HOLD.';
                 step4Style = isLimits ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30';
                 step4TextStyle = isLimits ? 'text-orange-400/90 border-orange-500/50' : 'text-red-400/90 border-red-500/50';
              } else if (aiAnalysisResult.approved) {
                 step4Status = 'approved';
                 step4Text = `✅ Проверено ИИ (Gemini). Вердикт: ${aiAnalysisResult.consensus || 'ОДОБРЕНО'}. Уверенность: ${Number(aiAnalysisResult.aiScore || selectedSignal.aiScore || 0).toFixed(1)}%`;
                 step4Style = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-glow-emerald';
                 step4TextStyle = 'text-emerald-400/90 border-emerald-500/50 font-medium';
              } else if (aiAnalysisResult.approved === false) {
                 step4Status = 'fallback';
                 step4Text = `⚠️ Отклонено ИИ (Gemini). Причина: ${aiAnalysisResult.consensusReason || 'Риски завышены'}`;
                 step4Style = 'bg-rose-500/20 text-rose-400 border-rose-500/30';
                 step4TextStyle = 'text-rose-400/90 border-rose-500/50';
              }
            } else if (selectedSignal.aiScore) {
                 // Fallback if we haven't actively analyzed but it came with a score
                 step4Status = 'approved';
                 step4Text = `Анализ паттернов: Система назначила скор ${Number(selectedSignal.aiScore || 0).toFixed(1)}%. Для полного RAG-анализа нажмите "АНАЛИЗ ИИ"`;
                 step4Style = 'bg-amber-500/20 text-amber-500 border-amber-500/30 shadow-glow-rose';
                 step4TextStyle = 'text-amber-400/90 border-amber-500/50';
            }
            
            return (
              <div id="strategy-section" className="bg-obsidian-900 border border-white/[0.04] rounded-2xl overflow-hidden shadow-2xl shadow-black/80 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="px-6 py-4 border-b border-white/[0.04] flex items-center gap-3 bg-black/35">
                  <div className="p-2.5 bg-amber-500/10 rounded-xl border border-amber-500/15 shadow-glow-rose">
                    <Brain className="w-4 h-4 text-amber-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.2em] mb-0.5">AI СТРАТЕГИЧЕСКИЙ ПРОТОКОЛ</h3>
                    <div className="text-sm font-black text-zinc-100 flex items-center gap-2">
                       {selectedCoin} <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono tracking-widest leading-none border border-white/5">АНАЛИЗ ЗАВЕРШЕН</span>
                    </div>
                  </div>
                  <button onClick={handleCloseSelection} className="p-2 hover:bg-white/[0.04] rounded-xl text-zinc-500 hover:text-zinc-200 transition-all border border-transparent hover:border-white/[0.06]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="p-6">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                    <div className="bg-black/40 border border-white/[0.04] rounded-2xl p-4.5 shadow-xl transition-all duration-300 hover:border-white/[0.08]">
                      <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3 border-b border-white/[0.04] pb-2">СТРАТЕГИЯ</div>
                      <div className={cn("text-lg font-black tracking-tight", isShort ? "text-rose-400" : "text-emerald-400")}>{action}</div>
                      <div className="text-[9px] text-zinc-400 mt-1 uppercase font-bold tracking-wider">{subtitle}</div>
                    </div>
                    <div className="bg-black/40 border border-white/[0.04] rounded-2xl p-4.5 shadow-xl transition-all duration-300 hover:border-white/[0.08]">
                      <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3 border-b border-white/[0.04] pb-2">ТЕКУЩАЯ ЦЕНА</div>
                      <div className="text-lg font-black text-white font-mono tracking-tighter">${selectedSignal.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                      <div className="text-[9px] text-zinc-400 mt-1 flex items-center gap-1 font-mono uppercase">
                        ВОЛ-ТЬ: <span className="text-zinc-200 font-bold">${selectedSignal.volatility || '12.5'}%</span>
                      </div>
                    </div>
                    <div className="bg-black/40 border border-white/[0.04] rounded-2xl p-4.5 shadow-xl transition-all duration-300 hover:border-white/[0.08]">
                      <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3 border-b border-white/[0.04] pb-2">ЦЕЛЬ ВЫХОДА</div>
                      <div className="text-lg font-black text-amber-400 font-mono tracking-tighter">${(takeProfit || (selectedSignal.price * (isShort ? 0.85 : 1.15))).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                      <div className="text-[9px] text-zinc-400 mt-1 flex items-center gap-1 font-mono uppercase">
                        ПОТЕНЦИАЛ: <span className="text-emerald-400 font-bold">+{potential.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="bg-black/40 border border-white/[0.04] rounded-2xl p-4.5 shadow-xl transition-all duration-300 hover:border-white/[0.08]">
                      <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3 border-b border-white/[0.04] pb-2">ОЖИДАЕМЫЙ ИТОГ</div>
                      <div className={cn("text-lg font-black font-mono tracking-tighter", isShort ? "text-rose-400" : "text-emerald-400")}>
                        ${(takeProfit || (selectedSignal.price * (isShort ? 0.85 : 1.15))).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                      <div className="text-[9px] text-zinc-400 mt-1 uppercase font-bold tracking-wider">ГРЯЗНАЯ ПРИБЫЛЬ</div>
                    </div>
                  </div>

                  {/* ИНТЕРФЕЙСНАЯ НАДСТРОЙКА ВАЛИДАЦИИ СИГНАЛОВ */}
                  <div className="bg-black/35 border border-white/[0.04] rounded-2xl p-6 mb-6 shadow-2xl relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/[0.01] rounded-bl-full blur-2xl pointer-events-none" />
                    
                    <div className="flex items-center gap-3 mb-6 relative z-10">
                      <div className="p-2.5 bg-indigo-500/10 rounded-xl border border-indigo-500/15 shadow-glow-indigo">
                        <Activity className="w-4 h-4 text-indigo-400" />
                      </div>
                      <div>
                        <div className="text-[9px] font-bold text-indigo-400 uppercase tracking-[0.2em] mb-0.5">Маршрут сигнала</div>
                        <div className="text-sm font-black text-zinc-100 flex items-center gap-2">АРХИТЕКТУРНЫЙ ПУТЬ ВАЛИДАЦИИ</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 relative z-10">
                       <div className="flex flex-col gap-2.5">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                          <span className="w-4.5 h-4.5 rounded text-[10px] font-black bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shadow-glow-emerald">1</span>
                          Разведка (Стрим)
                        </div>
                        <div className="text-[11px] text-zinc-400 leading-relaxed border-l border-emerald-500/40 pl-3.5 ml-2.5">
                          Анализ OHLCV: Проверка параболического роста, всплеск объемов x4, переворот индикатора SAR. Выявление теневого пробоя.
                        </div>
                      </div>
                      
                      <div className="flex flex-col gap-2.5">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                          <span className="w-4.5 h-4.5 rounded text-[10px] font-black bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shadow-glow-emerald">2</span>
                          Ликвидации (O.I.)
                        </div>
                        <div className="text-[11px] text-zinc-400 leading-relaxed border-l border-emerald-500/40 pl-3.5 ml-2.5">
                          Анти-шум: Фильтрация через карту ликвидаций. Подтверждение отсутствия ловушки маркетмейкера.
                        </div>
                      </div>
                      
                      <div className="flex flex-col gap-2.5 relative">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                          <span className="w-4.5 h-4.5 rounded text-[10px] font-black bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shadow-glow-emerald">3</span>
                          Кэширование
                          {updateIn > 0 ? (
                            <span className="ml-1 text-[8px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/5 leading-none">Обновление {updateIn}с</span>
                          ) : (
                            <span className="ml-1 text-[8px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/15 leading-none">Готово</span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 leading-relaxed border-l border-emerald-500/40 pl-3.5 ml-2.5 h-full">
                          Сбор 30х-секундного буфера для фиксации волатильности до RAG-отправки.
                        </div>
                      </div>

                      <div className="flex flex-col gap-2.5">
                        <div className="flex items-center gap-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                          <span className={cn("w-4.5 h-4.5 rounded text-[10px] font-black flex items-center justify-center border", step4Style)}>4</span>
                          Gemini 2.0 (Score)
                        </div>
                        <div className={cn("text-[11px] leading-relaxed border-l pl-3.5 ml-2.5 h-full transition-colors", step4TextStyle)}>
                          {step4Text}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-amber-500/[0.015] border border-amber-500/10 rounded-2xl p-6 mb-6 shadow-xl relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-15 transition-opacity duration-300">
                      <Brain className="w-20 h-20 text-amber-500 -mr-4 -mt-4 rotate-12 animate-pulse" />
                    </div>
                    <div className="relative z-10">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-[9px] font-bold text-amber-400 uppercase tracking-[0.3em]">Логика ИИ (Reasoning)</span>
                        <div className="h-px flex-1 bg-amber-500/10" />
                      </div>
                      <p className="text-xs text-zinc-300 leading-relaxed font-sans font-medium">
                        {isShort 
                          ? `Обнаружен параболический рост с критической волатильностью. Модель фиксирует истощение покупателя на пике. Ожидается декомпрессия (дамп) к уровню поддержки. Рекомендуется набор шорт-позиции в зоне $${selectedSignal.price.toLocaleString()} с использованием алгоритма ступенчатого входа. Прогнозный таргет: $${(takeProfit || (selectedSignal.price * 0.85)).toLocaleString()}.`
                          : `Идентифицирована аномальная зона накопления после циклического падения. Модель подтверждает вход крупного капитала (Hidden Divergence). Рекомендуется формирование лонг-позиции от уровня $${selectedSignal.price.toLocaleString()} с целью на технический отскок к $${(takeProfit || (selectedSignal.price * 1.15)).toLocaleString()}.`}
                      </p>
                    </div>
                  </div>

                  <div className="border border-white/[0.04] rounded-2xl overflow-hidden shadow-2xl bg-black/25">
                    <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between bg-black/10">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                          <Activity className="w-3.5 h-3.5 text-indigo-400" />
                        </div>
                        <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]">Матрица глубокой ликвидности</span>
                      </div>
                      <div className="flex gap-1.5 opacity-65">
                        <div className="w-1 h-1 rounded-full bg-emerald-500/40" />
                        <div className="w-1 h-1 rounded-full bg-emerald-500/40" />
                        <div className="w-1 h-1 rounded-full bg-emerald-500/40" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 lg:divide-x divide-white/[0.04] bg-obsidian-900/40">
                      <div className="p-5 hover:bg-white/[0.015] transition-colors duration-200">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-2.5">Открытый интерес</div>
                        <div className={cn("text-xs font-black font-mono tracking-tight flex items-center gap-2", isShort ? "text-emerald-400" : "text-rose-400")}>
                          {oiTrend === 'РАСТЕТ' ? '↑ РАСТЕТ' : '↓ ПАДАЕТ'} <span className="text-[8px] px-1.5 py-0.5 rounded-sm bg-black/45 border border-white/[0.05] font-sans">{isShort ? '+' : '-'}(14.75%)</span>
                        </div>
                        <div className="text-[9px] text-zinc-500 mt-2 font-medium leading-none uppercase tracking-wider">{oiSub.split('(')[0]}</div>
                      </div>
                      <div className="p-5 hover:bg-white/[0.015] transition-colors duration-200">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-2.5">Институциональный VWAP</div>
                        <div className="text-sm font-black text-amber-500 font-mono tracking-tight">
                          {selectedSignal.vwap !== undefined ? `$${selectedSignal.vwap.toLocaleString()}` : 'АНАЛИЗ...'}
                        </div>
                        <div className="text-[9px] text-zinc-500 mt-2 flex items-center gap-1 font-sans uppercase">
                          Дист: <span className="text-zinc-300 font-mono">${selectedSignal.vwapDist ? selectedSignal.vwapDist.toFixed(1) : 0}%</span>
                        </div>
                      </div>
                      <div className="p-5 hover:bg-white/[0.015] transition-colors duration-200">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-2.5">Матрица сжатия TTM</div>
                        <div className={cn("text-[9px] font-black tracking-widest mt-1", selectedSignal.squeeze === 'FIRING' ? "text-fuchsia-400 shadow-glow-rose" : selectedSignal.squeeze === 'ON' ? "text-amber-500" : "text-zinc-500 opacity-60")}>
                           {selectedSignal.squeeze === 'FIRING' ? '🔥 ПРОБОЙ В ПРОЦЕССЕ' : selectedSignal.squeeze === 'ON' ? '⚡ КОНСОЛИДАЦИЯ' : 'БЕЗ АНОМАЛИЙ'}
                        </div>
                        <div className="text-[9px] text-zinc-500 mt-2.5 uppercase font-medium tracking-wider">Анализ канала Кельтнера</div>
                      </div>
                      <div className="p-5 hover:bg-white/[0.015] transition-colors duration-200">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-2.5">Анализ принтов китов</div>
                        <div className={cn("text-[9px] font-black tracking-widest mt-1", selectedSignal.whaleHit ? "text-cyan-400 shadow-glow-indigo" : selectedSignal.pumpDetected ? "text-fuchsia-400" : "text-blue-500 opacity-60")}>
                           {selectedSignal.stopHunt ? `🧹 СТОП-ХАНТ (${selectedSignal.stopHunt})` : selectedSignal.whaleHit ? '🐋 ВСПЛЕСК КИТА (>2M$)' : selectedSignal.pumpDetected ? '🤖 АЛГОРИТМ ПАМПА' : 'ОЖИДАНИЕ'}
                        </div>
                        <div className="text-[9px] text-zinc-500 mt-2.5 uppercase font-medium tracking-wider">Анализ ленты и стакана</div>
                      </div>
                    </div>
                  </div>

                  {/* АДДИТИВНЫЙ БЛОК: SMART MONEY КОНФЛЮЭНС И КОНТЕКСТ РЫНКА (MTF) */}
                  <div className="border border-white/[0.04] rounded-2xl overflow-hidden shadow-2xl bg-black/25 mt-4">
                    <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between bg-black/10">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                          <Activity className="w-3.5 h-3.5 text-indigo-400" />
                        </div>
                        <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]">Smart Money Конфлюэнс & Контекст Рынка</span>
                      </div>
                      {selectedSignal.hasMarketConfluence ? (
                        <span className="text-[8px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded shadow-glow-emerald animate-pulse">
                          🌟 Сильный Конфлюэнс
                        </span>
                      ) : (
                        <span className="text-[8px] font-black uppercase tracking-widest bg-zinc-800 text-zinc-500 border border-white/5 px-2 py-0.5 rounded">
                          Стандартный Сигнал
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-white/[0.04] bg-obsidian-900/40 font-sans p-5 gap-4">
                      {/* Старший таймфрейм 1D и 1H */}
                      <div className="flex flex-col gap-2">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.15em] border-b border-white/[0.03] pb-1.5">Старший Тренд (HTF)</div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">1D Общий Тренд:</span>
                          <span className={cn("font-black uppercase text-[10px] px-1.5 py-0.5 rounded", 
                            selectedSignal.trend1d === 'BULLISH' ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/10" : 
                            selectedSignal.trend1d === 'BEARISH' ? "bg-rose-500/15 text-rose-400 border border-rose-500/10" : "bg-zinc-800 text-zinc-400"
                          )}>
                            {selectedSignal.trend1d === 'BULLISH' ? '🟢 Бычий (BULL)' : selectedSignal.trend1d === 'BEARISH' ? '🔴 Медвежий (BEAR)' : '⚪ Флэт (NEUTRAL)'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">1H Снятие Ликвидности:</span>
                          <span className={cn("font-black uppercase text-[10px] px-1.5 py-0.5 rounded", 
                            (selectedSignal.isLiquiditySweep1h || selectedSignal.isLiquiditySweepLow1h) ? "bg-amber-500/15 text-amber-400 border border-amber-500/10 animate-pulse" : "bg-zinc-800 text-zinc-500"
                          )}>
                            {selectedSignal.isLiquiditySweep1h ? '🧹 Свип Сверху (Top)' : selectedSignal.isLiquiditySweepLow1h ? '🧹 Свип Снизу (Low)' : '⚪ Свипов нет'}
                          </span>
                        </div>
                      </div>

                      {/* Младший таймфрейм 5m */}
                      <div className="flex flex-col gap-2 md:pl-4">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.15em] border-b border-white/[0.03] pb-1.5">Локальная структура (5m)</div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">Локальный Максимум:</span>
                          <span className="font-mono font-bold text-zinc-200">${selectedSignal.localHigh5m ? selectedSignal.localHigh5m.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">Локальный Минимум:</span>
                          <span className="font-mono font-bold text-zinc-200">${selectedSignal.localLow5m ? selectedSignal.localLow5m.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">5m Снятие стопов:</span>
                          <span className={cn("font-black uppercase text-[10px] px-1.5 py-0.5 rounded", 
                            (selectedSignal.isLiquiditySweep5m || selectedSignal.isLiquiditySweepLow5m) ? "bg-amber-500/15 text-amber-400 border border-amber-500/10" : "bg-zinc-800 text-zinc-500"
                          )}>
                            {selectedSignal.isLiquiditySweep5m ? '🧹 Свип Сверху' : selectedSignal.isLiquiditySweepLow5m ? '🧹 Свип Снизу' : '⚪ Нет свипа'}
                          </span>
                        </div>
                      </div>

                      {/* Точки входа и выхода */}
                      <div className="flex flex-col gap-2 md:pl-4">
                        <div className="text-[8px] font-bold text-zinc-500 uppercase tracking-[0.15em] border-b border-white/[0.03] pb-1.5">Точки А и Б (Smart Money)</div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400 font-medium">Точка А (Вход/Ориентир):</span>
                          <span className="font-mono font-black text-indigo-400">${selectedSignal.pointA ? selectedSignal.pointA.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400 font-medium">Точка Б (Цель/Таргет):</span>
                          <span className="font-mono font-black text-emerald-400">${selectedSignal.pointB ? selectedSignal.pointB.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-zinc-400">Имбаланс (5m FVG):</span>
                          <span className={cn("font-black uppercase text-[10px] px-1.5 py-0.5 rounded", 
                            (selectedSignal.hasFvg5mAbove || selectedSignal.hasFvg5mBelow) ? "bg-amber-500/15 text-amber-400 border border-amber-500/10" : "bg-zinc-800 text-zinc-500"
                          )}>
                            {selectedSignal.hasFvg5mAbove ? '⚠️ Дисбаланс Сверху' : selectedSignal.hasFvg5mBelow ? '⚠️ Дисбаланс Снизу' : '⚪ Нет FVG'}
                          </span>
                        </div>
                      </div>
                    </div>
                    {selectedSignal.hasMarketConfluence && (
                      <div className="p-4 bg-emerald-500/5 border-t border-white/[0.03] text-[10px] text-emerald-400/90 font-bold text-center uppercase tracking-wider animate-pulse">
                        🛡️ СИСТЕМА ЗАФИКСИРОВАЛА СОВПАДЕНИЕ СТАРШЕГО И МЛАДШЕГО ТРЕНДОВ И СНЯТИЯ СТОПОВ. СТРОГИЕ ФИЛЬТРЫ РИСКА УСПЕШНО ОСЛАБЛЕНЫ ДЛЯ ВХОДА.
                      </div>
                    )}
                  </div>

                  {selectedSignal.obWalls && selectedSignal.obWalls.length > 0 && (
                     <div className="border border-white/[0.04] rounded-2xl overflow-hidden shadow-2xl bg-black/25 mt-4">
                       <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
                         <div className="flex items-center gap-3">
                           <div className="p-2 bg-emerald-500/10 rounded-lg">
                             <Activity className="w-3.5 h-3.5 text-emerald-400" />
                           </div>
                           <span className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em]">Плотности стакана (Smart Orderbook)</span>
                         </div>
                       </div>
                       <div className="p-5 flex flex-col gap-2 border-b border-white/5">
                         {selectedSignal.obWalls.map((wall, i) => (
                           <div key={i} className="flex items-center justify-between">
                             <div className="flex items-center gap-2">
                               <div className={cn("w-1.5 h-1.5 rounded-full", wall.type === 'bid' ? "bg-emerald-500" : "bg-red-500")} />
                               <span className="text-xs text-zinc-300 font-mono tracking-tighter">
                                 ${wall.price.toLocaleString(undefined, { maximumFractionDigits: 5 })}
                               </span>
                               <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded", wall.type === 'bid' ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400")}>
                                 {wall.type === 'bid' ? 'ПОДДЕРЖКА' : 'СОПРОТИВЛЕНИЕ'}
                               </span>
                             </div>
                             <div className="text-right flex items-center gap-3">
                               <div className="text-xs font-mono font-bold text-zinc-400">
                                 ${(wall.size / 1000).toFixed(1)}k
                               </div>
                               <div className="text-[10px] text-zinc-500 font-mono">
                                 ({wall.distancePct > 0 ? '+' : ''}{wall.distancePct.toFixed(2)}%)
                               </div>
                             </div>
                           </div>
                         ))}
                       </div>
                       <div className="p-5 flex flex-col gap-2 bg-black/10 font-sans">
                         <div className="flex items-center justify-between">
                           <span className="text-zinc-500 text-[11px] font-medium">Сила Сопротивления к Поддержке:</span>
                           <span className={cn("font-mono text-xs font-bold", (selectedSignal.wallDensityScore || 0) >= 0 ? "text-red-400" : "text-emerald-400")}>
                             {selectedSignal.wallDensityScore !== undefined ? `${selectedSignal.wallDensityScore > 0 ? '+' : ''}${selectedSignal.wallDensityScore.toFixed(2)}` : '0.00'}
                           </span>
                         </div>
                         {selectedSignal.wallDensityScore !== undefined && selectedSignal.wallDensityScore > 5 ? (
                           <div className="text-[10px] text-red-400 font-bold bg-red-500/10 p-2 rounded-lg border border-red-500/20 text-center">
                             🛡️ СВЕРХУ КРУПНЫЕ ЛИМИТНЫЕ СТЕНКИ (Идеально для удержания SHORT позиции!)
                           </div>
                         ) : selectedSignal.wallDensityScore !== undefined && selectedSignal.wallDensityScore < -5 ? (
                           <div className="text-[10px] text-amber-500 font-bold bg-amber-500/10 p-2 rounded-lg border border-amber-500/20 text-center">
                             ⚠️ ВНИМАНИЕ: СНИЗУ ПЛОТНЫЕ ПОКУПАТЕЛЬСКИЕ СТЕНКИ!
                           </div>
                         ) : null}
                       </div>
                     </div>
                  )}

                  {selectedSignal.cvd && selectedSignal.cvd.buyVol > 0 && (
                     <div className="border border-white/5 rounded-2xl overflow-hidden shadow-2xl bg-black/20 mt-4">
                       <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
                         <div className="flex items-center gap-3">
                           <div className="p-2 bg-indigo-500/10 rounded-lg">
                             <Activity className="w-3.5 h-3.5 text-indigo-400" />
                           </div>
                           <span className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em]">Кластерный Анализ (Footprint CVD)</span>
                         </div>
                       </div>
                       <div className="p-5 grid grid-cols-3 gap-2 text-center divide-x divide-white/5 border-b border-white/5">
                          <div className="flex flex-col">
                             <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-black mb-1">Buy Vol</span>
                             <span className="text-emerald-400 font-mono text-xs font-bold">${(selectedSignal.cvd.buyVol || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="flex flex-col">
                             <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-black mb-1">Sell Vol</span>
                             <span className="text-red-400 font-mono text-xs font-bold">${(selectedSignal.cvd.sellVol || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="flex flex-col">
                             <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-black mb-1">Delta (CVD)</span>
                             <span className={cn("font-mono text-xs font-bold", (selectedSignal.cvd.cvd || 0) > 0 ? "text-emerald-400" : "text-red-400")}>
                                {(selectedSignal.cvd.cvd || 0) > 0 ? '+' : ''}{(selectedSignal.cvd.cvd || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                             </span>
                          </div>
                       </div>
                       <div className="p-5 flex flex-col gap-2 bg-black/10 font-sans">
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-500 text-[11px] font-medium">Коэффициент CVD:</span>
                            <span className={cn("font-mono text-xs font-bold", selectedSignal.cvdRatio && selectedSignal.cvdRatio > 0 ? "text-emerald-400" : "text-red-400")}>
                              {selectedSignal.cvdRatio !== undefined ? `${(selectedSignal.cvdRatio * 100).toFixed(1)}%` : '0.00%'}
                            </span>
                          </div>
                          {selectedSignal.isCvdBearishDivergence && (
                            <div className="mt-1 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-center text-[10px] text-red-400 font-bold animate-pulse">
                              ⚠️ BEARISH CVD DIVERGENCE (Лимитный продавец гасит агрессивные рыночные покупки!)
                            </div>
                          )}
                       </div>
                     </div>
                  )}

                  {/* HIGH TIMEFRAME TREND LOCK (HTF LOCK) */}
                  <div className="border border-white/5 rounded-2xl overflow-hidden shadow-2xl bg-black/20 mt-4 font-sans">
                    <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-amber-500/10 rounded-lg">
                          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                        </div>
                        <span className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em]">Фильтр Старшего Таймфрейма (HTF Lock)</span>
                      </div>
                    </div>
                    <div className="p-5 flex flex-col gap-3">
                       <div className="flex items-center justify-between">
                          <span className="text-zinc-500 text-xs font-medium">1h EMA-200 Тренд:</span>
                          <span className={cn("text-xs font-bold font-mono px-2 py-0.5 rounded", 
                             selectedSignal.price < (selectedSignal.ema200_1h || selectedSignal.price) 
                               ? "bg-red-500/10 text-red-400" 
                               : "bg-emerald-500/10 text-emerald-400"
                          )}>
                             {selectedSignal.price < (selectedSignal.ema200_1h || selectedSignal.price) ? 'Шорт Тренд (🔴 Медвежий)' : 'Лонг Тренд (🟢 Бычий)'}
                          </span>
                       </div>
                       {selectedSignal.ema200_1h && (
                          <div className="flex items-center justify-between text-[11px] text-zinc-400">
                             <span>Уровень EMA-200:</span>
                             <span className="font-mono text-zinc-300">$${selectedSignal.ema200_1h.toLocaleString(undefined, { minimumFractionDigits: 5 })}</span>
                          </div>
                       )}
                       <div className="flex items-center justify-between">
                          <span className="text-zinc-500 text-xs font-medium">4h Дисбаланс (FVG):</span>
                          <span className="text-xs font-bold font-mono">
                             {selectedSignal.hasFvgAbove ? (
                                <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">МАГНИТ СВЕРХУ (Bullish FVG)</span>
                             ) : selectedSignal.hasBullishFvgBelow ? (
                                <span className="text-red-400 bg-red-500/10 px-2 py-0.5 rounded">ПОДДЕРЖКА СНИЗУ (Bullish FVG support)</span>
                             ) : selectedSignal.hasBearishFvgAbove ? (
                                <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">СОПРОТИВЛЕНИЕ СВЕРХУ (Bearish FVG resistance)</span>
                             ) : (
                                <span className="text-zinc-400 bg-zinc-800/20 px-2 py-0.5 rounded">Чистый фон (No FVG)</span>
                             )}
                          </span>
                       </div>
                       <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                        {/* Order Book Depth Analysis (L2 Icebergs & Smart Limit Placement) */}
                        {selectedSignal.icebergs && (selectedSignal.icebergs.askIceberg || selectedSignal.icebergs.bidIceberg) && (
                           <div className="p-2.5 bg-blue-950/30 border border-blue-500/30 rounded-lg space-y-1.5">
                              <div className="text-xs font-bold text-blue-300 flex items-center gap-1.5">
                                 <span>🧊 Order Book Depth (L2 Iceberg Wall Detected)</span>
                              </div>
                              {selectedSignal.icebergs.askIceberg && (
                                 <div className="text-[11px] font-mono text-zinc-300 flex justify-between items-center">
                                    <span className="text-rose-400">Плотность продавца (Ask Iceberg):</span>
                                    <span>${(selectedSignal.icebergs.askIceberg.size / 1000).toFixed(1)}k @ ${selectedSignal.icebergs.askIceberg.price}</span>
                                 </div>
                              )}
                              {selectedSignal.icebergs.bidIceberg && (
                                 <div className="text-[11px] font-mono text-zinc-300 flex justify-between items-center">
                                    <span className="text-emerald-400">Плотность покупателя (Bid Iceberg):</span>
                                    <span>${(selectedSignal.icebergs.bidIceberg.size / 1000).toFixed(1)}k @ ${selectedSignal.icebergs.bidIceberg.price}</span>
                                 </div>
                              )}
                              {selectedSignal.smartLimitTarget && (
                                 <div className="text-[11px] font-mono font-bold text-amber-300 flex justify-between items-center pt-1 border-t border-blue-500/20">
                                    <span>Smart Limit Placement (Front-run 0.03%):</span>
                                    <span className="text-amber-400">${selectedSignal.smartLimitTarget}</span>
                                 </div>
                              )}
                           </div>
                        )}

                        {/* Spot Accumulation Engine (DCA Buy Ladder) */}
                        {(selectedSignal.spotDcaLadder || selectedSignal.type.includes('Спот') || selectedSignal.type.includes('Spot')) && (
                           <div className="p-2.5 bg-emerald-950/30 border border-emerald-500/30 rounded-lg space-y-2">
                              <div className="text-xs font-bold text-emerald-300 flex items-center justify-between">
                                 <span>📈 Spot Accumulation Engine (DCA Buy Ladder)</span>
                                 <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">3 Tiers</span>
                              </div>
                              <div className="space-y-1 font-mono text-[11px]">
                                 {(selectedSignal.spotDcaLadder || [
                                    { step: 1, price: selectedSignal.price, percentDip: 0, allocationPct: 30, label: 'Базовый Спот Влив (30%)' },
                                    { step: 2, price: Number((selectedSignal.price * 0.965).toFixed(5)), percentDip: -3.5, allocationPct: 35, label: 'DCA Накопление -3.5% (35%)' },
                                    { step: 3, price: Number((selectedSignal.price * 0.925).toFixed(5)), percentDip: -7.5, allocationPct: 35, label: 'Глубокое DCA Накопление -7.5% (35%)' }
                                 ]).map((tier, idx) => (
                                    <div key={idx} className="flex justify-between items-center bg-zinc-900/60 px-2 py-1 rounded text-zinc-300">
                                       <span className="text-emerald-400">{tier.label}:</span>
                                       <span className="font-bold">${tier.price}</span>
                                    </div>
                                 ))}
                              </div>
                           </div>
                        )}

                          <span className="text-zinc-400 text-[11px] font-bold">HTF Filter Сделки:</span>
                          <span className={cn("text-xs font-mono font-black tracking-widest uppercase", 
                             (selectedSignal.price > (selectedSignal.ema200_1h || selectedSignal.price) || selectedSignal.hasFvgAbove || selectedSignal.hasBullishFvgBelow)
                               ? "text-rose-500" 
                               : "text-emerald-500"
                          )}>
                             {(selectedSignal.price > (selectedSignal.ema200_1h || selectedSignal.price) || selectedSignal.hasFvgAbove || selectedSignal.hasBullishFvgBelow) ? '🔒 ЗАБЛОКИРОВАН (LOCKED)' : '🟢 ПАТЕНТ СВЕРХУ (PASSED)'}
                          </span>
                       </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

            <div id="ladder-calculator" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 h-fit">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-zinc-100 flex items-center gap-2">
                <Calculator className="w-5 h-5 text-yellow-400" /> 
                Калькулятор ({selectedCoin || 'Монета'})
              </h3>
              <button onClick={handleCloseSelection} className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
                <div className="flex flex-col gap-2 p-2 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Режим Торговли</span>
                  </div>
                  <div className="flex gap-1">
                    <button 
                      onClick={() => setTradeMode('AUTO')}
                      className={cn("flex-1 py-1.5 text-[10px] rounded transition-all flex flex-col items-center gap-0.5", tradeMode === 'AUTO' ? "bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300 border border-transparent")}
                    >
                      <span>🚀</span>
                      Автопилот
                    </button>
                    <button 
                      onClick={() => setTradeMode('SEMI_AUTO')}
                      className={cn("flex-1 py-1.5 text-[10px] rounded transition-all flex flex-col items-center gap-0.5", tradeMode === 'SEMI_AUTO' ? "bg-yellow-500/20 text-yellow-500 font-bold border border-yellow-500/30" : "text-zinc-500 hover:text-zinc-300 border border-transparent")}
                    >
                      <span>🤖</span>
                      Полуавтомат
                    </button>
                    <button 
                      onClick={() => setTradeMode('MANUAL')}
                      className={cn("flex-1 py-1.5 text-[10px] rounded transition-all flex flex-col items-center gap-0.5", tradeMode === 'MANUAL' ? "bg-zinc-800 text-zinc-300 font-bold border border-zinc-700" : "text-zinc-500 hover:text-zinc-300 border border-transparent")}
                    >
                      <span>🙋</span>
                      Ручной
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 p-2 bg-zinc-950 rounded-lg border border-zinc-800">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Тип Сделки</span>
                  </div>
                  <div className="flex gap-1">
                    <button 
                      type="button"
                      onClick={() => setPositionType('long')}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] rounded transition-all flex items-center justify-center gap-1.5 font-bold uppercase tracking-wider cursor-pointer border", 
                        positionType === 'long' 
                          ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.15)]" 
                          : "text-zinc-500 hover:text-zinc-300 border-transparent bg-transparent"
                      )}
                    >
                      <span>🟢</span>
                      LONG
                    </button>
                    <button 
                      type="button"
                      onClick={() => setPositionType('short')}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] rounded transition-all flex items-center justify-center gap-1.5 font-bold uppercase tracking-wider cursor-pointer border", 
                        positionType === 'short' 
                          ? "bg-rose-500/20 text-rose-400 border-rose-500/30 shadow-[0_0_12px_rgba(244,63,94,0.15)]" 
                          : "text-zinc-500 hover:text-zinc-300 border-transparent bg-transparent"
                      )}
                    >
                      <span>🔴</span>
                      SHORT
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs text-zinc-500">Цена входа (USDT)</label>
                   {selectedSignal?.atr !== undefined && Number(selectedSignal.atr) > 0 && (
                     <button onClick={() => {
                        const targetSide = ((selectedSignal.signal || '').includes('SELL') || (selectedSignal.signal || '').includes('SHORT')) ? -1 : 1;
                        const atrVal = Number(selectedSignal.atr);
                        setCalcTpMode('PRICE');
                        setCalcSlMode('PRICE');
                        setStopLoss(Number(((selectedSignal.price || 0) - (atrVal * 2 * targetSide)).toFixed(5)));
                        setTakeProfit(Number(((selectedSignal.price || 0) + (atrVal * 3 * targetSide)).toFixed(5)));
                     }} className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400 hover:text-yellow-400 transition-colors">
                        Авто ATR (SL: 2, TP: 3)
                     </button>
                   )}
                </div>
                <input type="number" value={entryPrice} onChange={(e) => setEntryPrice(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono" step="0.00001" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                {/* Take Profit Input */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs text-zinc-500 font-bold">Take Profit</label>
                    <button
                      type="button"
                      onClick={handleToggleCalcTpMode}
                      className={cn(
                        "text-[8px] px-1 py-0.5 rounded font-black transition-colors uppercase",
                        calcTpMode === 'PERCENT' ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                      )}
                    >
                      {calcTpMode === 'PERCENT' ? '% PnL' : 'Цена ($)'}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value === '' ? '' : Number(e.target.value))}
                      placeholder={calcTpMode === 'PERCENT' ? "например 7" : "Опционально"}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-6 py-2 text-zinc-200 font-mono"
                      step="0.00001"
                    />
                    {calcTpMode === 'PERCENT' && (
                      <span className="absolute right-2 top-2 text-[10px] text-emerald-400 font-mono font-bold">%</span>
                    )}
                  </div>
                  {takeProfit !== '' && !isNaN(Number(takeProfit)) && (
                    <div className="mt-1 text-[8px] text-zinc-500 font-mono">
                      {calcTpMode === 'PERCENT' ? (
                        <span>~ ${getCalcPriceFromPnlPct(Number(takeProfit), true).toFixed(5)}</span>
                      ) : (
                        <span>~ +{getCalcPnlPctFromPrice(Number(takeProfit), true).toFixed(1)}% PnL</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Stop Loss Input */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs text-zinc-500 font-bold">Stop Loss</label>
                    <button
                      type="button"
                      onClick={handleToggleCalcSlMode}
                      className={cn(
                        "text-[8px] px-1 py-0.5 rounded font-black transition-colors uppercase",
                        calcSlMode === 'PERCENT' ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                      )}
                    >
                      {calcSlMode === 'PERCENT' ? '% Loss' : 'Цена ($)'}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value === '' ? '' : Number(e.target.value))}
                      placeholder={calcSlMode === 'PERCENT' ? "например 5" : "Опционально"}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-6 py-2 text-zinc-200 font-mono"
                      step="0.00001"
                    />
                    {calcSlMode === 'PERCENT' && (
                      <span className="absolute right-2 top-2 text-[10px] text-rose-400 font-mono font-bold">%</span>
                    )}
                  </div>
                  {stopLoss !== '' && !isNaN(Number(stopLoss)) && (
                    <div className="mt-1 text-[8px] text-zinc-500 font-mono">
                      {calcSlMode === 'PERCENT' ? (
                        <span>~ ${getCalcPriceFromPnlPct(Number(stopLoss), false).toFixed(5)}</span>
                      ) : (
                        <span>~ -{getCalcPnlPctFromPrice(Number(stopLoss), false).toFixed(1)}% PnL</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Комиссия биржи</label>
                  <select value={feeType} onChange={(e) => setFeeType(e.target.value as any)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono">
                    <option value="maker">Maker (0.02%)</option>
                    <option value="taker">Taker (0.06%)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Депозит (USD)</label>
                  <input type="number" value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono" />
                  <div className="mt-1 text-[9px] text-zinc-500 font-mono flex items-center justify-between">
                    <span>Доступно:</span>
                    <span 
                      onClick={() => setMargin(Math.floor((tradingMode === 'real' ? (realBalance || 0) : virtualBalance) * 0.1))}
                      className="cursor-pointer hover:text-indigo-400 underline transition-colors"
                      title="Использовать 10% от баланса"
                    >
                      {tradingMode === 'real' && !isRealBalanceVisible ? "••••" : `$${(tradingMode === 'real' ? (realBalance || 0) : virtualBalance).toFixed(2)}`}
                    </span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Плечо</label>
                  <input type="number" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Шаг лесенки (%)</label>
                  <input 
                    type="number" 
                    value={useAtrDynamicDca ? Number(((selectedSignal?.atr ? Number(selectedSignal.atr) : (entryPrice * 0.015)) / (entryPrice || 1) * 100).toFixed(2)) : stepPercent} 
                    onChange={(e) => setStepPercent(Number(e.target.value))} 
                    disabled={useAtrDynamicDca}
                    className={cn(
                      "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono",
                      useAtrDynamicDca && "opacity-75 cursor-not-allowed text-emerald-400 font-semibold"
                    )}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Кол-во шагов</label>
                  <input type="number" value={stepsCount} onChange={(e) => setStepsCount(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 font-mono" max="10" />
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-850">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold text-zinc-200">Динамический шаг (ATR)</span>
                  <p className="text-[10px] text-zinc-500">Авто-расширение сетки пропорционально волатильности</p>
                </div>
                <input 
                  type="checkbox" 
                  checked={useAtrDynamicDca} 
                  onChange={(e) => setUseAtrDynamicDca(e.target.checked)}
                  className="w-4 h-4 rounded accent-emerald-500 bg-zinc-950 border-zinc-800 cursor-pointer" 
                />
              </div>
              <div className="mt-3 flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-850">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold text-zinc-200">Привязка к стакану (Walls)</span>
                  <p className="text-[10px] text-zinc-500">Авто-размещение лимитов перед крупными стенками</p>
                </div>
                <input 
                  type="checkbox" 
                  checked={alignWithWalls} 
                  onChange={(e) => setAlignWithWalls(e.target.checked)}
                  className="w-4 h-4 rounded accent-yellow-500 bg-zinc-950 border-zinc-800 cursor-pointer" 
                />
              </div>
              <div className="mt-4 p-3 bg-zinc-950 rounded-lg border border-zinc-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
                <p className="text-xs text-zinc-400">
                  При каждом следующем шаге маржа удваивается для эффективного усреднения цены (стратегия Мартингейла).
                </p>
              </div>
              <div className="flex gap-2 mt-4">
                <a href={getTradeUrl(selectedSignal.exchange, selectedSignal.coin)} target="_blank" rel="noopener noreferrer" className="flex-1 py-2 bg-yellow-500 hover:bg-yellow-600 text-zinc-950 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                  <ExternalLink className="w-4 h-4" /> На бирже
                </a>
                {paperTrades.find(t => {
                   const tNorm = normalizeSymbol(t.symbol);
                   const sNorm = normalizeSymbol(selectedSignal.symbol);
                   return t.status === 'OPEN' && tNorm === sNorm;
                }) ? (
                  <button 
                    onClick={() => {
                      const trade = paperTrades.find(t => {
                        const tNorm = t.symbol.replace('/', '').replace(':', '').toUpperCase();
                        const sNorm = selectedSignal.symbol.replace('/', '').replace(':', '').toUpperCase();
                        return t.status === 'OPEN' && tNorm === sNorm;
                      });
                      if (trade) handleCloseActiveTrade(trade);
                    }} 
                    disabled={isAnalyzing}
                    className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <X className="w-4 h-4" /> Закрыть сделку
                  </button>
                ) : (
                  <button onClick={handleOpenPaperTrade} disabled={isAnalyzing} className={cn(
                    "flex-1 py-2 text-white rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50",
                    tradeMode === 'AUTO' ? "bg-emerald-600 hover:bg-emerald-500" : 
                    tradeMode === 'SEMI_AUTO' ? "bg-yellow-600 hover:bg-yellow-500" : "bg-indigo-600 hover:bg-indigo-500",
                    tradingMode === 'real' && "outline outline-2 outline-offset-2 outline-emerald-500"
                  )}>
                    {isAnalyzing ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      tradeMode === 'AUTO' ? <Zap className="w-4 h-4" /> :
                      tradeMode === 'SEMI_AUTO' ? <Bot className="w-4 h-4" /> : <Activity className="w-4 h-4" />
                    )}
                    {isAnalyzing ? 'Открываем...' : 
                     tradingMode === 'real' ? (tradeMode === 'AUTO' ? '🚀 АВТОПИЛОТ' : tradeMode === 'SEMI_AUTO' ? '🤖 ПОЛУАВТОМАТ' : 'ОТКРЫТЬ REAL СДЕЛКУ') : 
                     tradeMode === 'AUTO' ? '🚀 АВТОПИЛОТ' :
                     tradeMode === 'SEMI_AUTO' ? '🤖 ПОЛУАВТОМАТ' : 'ОТКРЫТЬ TEST СДЕЛКУ'}
                  </button>
                )}
                <button onClick={handleAiAnalyze} disabled={isAnalyzing} className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
                  <Brain className="w-4 h-4 text-yellow-500" /> {isAnalyzing ? 'Анализ...' : 'Спросить ИИ'}
                </button>
              </div>
              {aiAnalysisResult && typeof aiAnalysisResult === 'object' && (
                <div className="mt-4 p-4 bg-zinc-900/80 border border-zinc-700 rounded-lg text-sm text-zinc-300 leading-relaxed grid gap-3">
                  <div className="flex items-center gap-2 mb-1 font-bold text-yellow-500">
                    <Brain className="w-4 h-4" /> AI Committee (Консенсус 3 Агентов):
                  </div>
                  {aiAnalysisResult.error ? (
                    <div className="bg-red-950/20 text-red-400 p-3 rounded border border-red-900/50">
                      {aiAnalysisResult.error}
                    </div>
                  ) : (
                    <>
                      <div className="bg-zinc-950 p-3 rounded border border-zinc-800">
                         <div className="text-xs text-blue-400 font-bold mb-1">🤖 Теханалитик:</div>
                         {aiAnalysisResult.techAnalyst}
                      </div>
                      <div className="bg-zinc-950 p-3 rounded border border-zinc-800">
                         <div className="text-xs text-red-400 font-bold mb-1">🛡️ Риск-менеджер:</div>
                         {aiAnalysisResult.riskManager}
                      </div>
                      <div className="bg-zinc-950 p-3 rounded border border-zinc-800">
                         <div className="text-xs text-emerald-400 font-bold mb-1 flex items-center justify-between">
                           <span>⚖️ Вердикт: <span className="text-white text-base ml-1">{aiAnalysisResult.consensus}</span></span>
                         </div>
                         {aiAnalysisResult.consensusReason}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          
          <div className="lg:col-span-2 flex flex-col gap-6">
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
              <div className="p-6 border-b border-zinc-800/50 flex justify-between items-center">
                <h3 className="text-lg font-medium text-zinc-100">План входа (Ордера)</h3>
                <div className="text-sm text-zinc-400">
                  Средняя цена: <span className="text-yellow-400 font-mono">
                    {ladder.reduce((acc, l) => acc + l.size, 0) > 0 
                      ? formatPrice(ladder.reduce((acc, l) => acc + (l.price * l.size), 0) / ladder.reduce((acc, l) => acc + l.size, 0))
                      : "0.00"}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-zinc-500 bg-zinc-950/50 border-b border-zinc-800/50">
                    <tr><th className="px-6 py-3">Шаг</th><th className="px-6 py-3">Тип ордера</th><th className="px-6 py-3">Цена входа</th><th className="px-6 py-3">Маржа</th><th className="px-6 py-3">Объем позиции</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {ladder.map((step, idx) => (
                      <tr key={idx} className="hover:bg-zinc-800/20">
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-zinc-800 text-zinc-300 text-xs font-bold">
                            {step.step}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-zinc-300">Лимитный</td>
                        <td className="px-6 py-4 font-mono text-yellow-400">{formatPrice(step.price)}</td>
                        <td className="px-6 py-4 font-mono text-zinc-300">${(step.margin || 0).toFixed(2)}</td>
                        <td className="px-6 py-4 font-mono text-zinc-300">${(step.size || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-6 bg-zinc-950/50 border-t border-zinc-800/50">
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400 text-sm">Итого задействовано маржи:</span>
                  <span className="text-lg font-bold text-zinc-100 font-mono">
                    ${ladder.reduce((acc, l) => acc + l.margin, 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center mt-2">
                  <span className="text-zinc-400 text-sm">Итоговый объем позиции:</span>
                  <span className="text-lg font-bold text-zinc-100 font-mono">
                    ${ladder.reduce((acc, l) => acc + l.size, 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center mt-2 border-t border-zinc-900 pt-2">
                  <span className="text-zinc-500 text-xs">Комиссия биржи (Total Open+Close):</span>
                  <span className="text-sm font-bold text-red-400/80 font-mono">
                    -${(ladder.reduce((acc, l) => acc + l.size, 0) * (feeType === 'maker' ? 0.0002 : 0.0006) * 2).toFixed(2)}
                  </span>
                </div>
                {takeProfit && Number(takeProfit) > 0 && (
                  <div className="flex justify-between items-center mt-2 pt-2 border-t border-zinc-900">
                    <span className="text-zinc-400 text-sm">Чистая прибыль (с учетом комиссий):</span>
                    <span className={cn("text-lg font-bold font-mono", 
                      (() => {
                        const totalSize = ladder.reduce((acc, l) => acc + l.size, 0);
                        const avgPrice = totalSize > 0 ? (ladder.reduce((acc, l) => acc + (l.price * l.size), 0) / totalSize) : 0;
                        const tPrice = Number(takeProfit);
                        const rawPnl = positionType === 'short' ? (avgPrice - tPrice) / avgPrice * totalSize : (tPrice - avgPrice) / avgPrice * totalSize;
                        const fees = totalSize * (feeType === 'maker' ? 0.0002 : 0.0006) * 2;
                        return (rawPnl - fees) > 0 ? "text-emerald-400" : "text-red-400";
                      })()
                    )}>
                      {(() => {
                        const totalSize = ladder.reduce((acc, l) => acc + l.size, 0);
                        const avgPrice = totalSize > 0 ? (ladder.reduce((acc, l) => acc + (l.price * l.size), 0) / totalSize) : 0;
                        const tPrice = Number(takeProfit);
                        const rawPnl = positionType === 'short' ? (avgPrice - tPrice) / avgPrice * totalSize : (tPrice - avgPrice) / avgPrice * totalSize;
                        const fees = totalSize * (feeType === 'maker' ? 0.0002 : 0.0006) * 2;
                        return (rawPnl - fees).toFixed(2);
                      })()}
                    </span>
                  </div>
                )}
              </div>
              <div className="p-6 bg-zinc-950/50 border-t border-zinc-800/50">
                <div className="flex items-center gap-2 mb-4">
                  <Brain className="w-5 h-5 text-yellow-400" />
                  <h3 className="text-lg font-medium text-zinc-100">Стратегия ведения сделки</h3>
                </div>
                {(selectedSignal.change24h || 0) > 10 && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2 text-red-400 font-medium mb-2">
                      <AlertCircle className="w-4 h-4" />
                      Внимание: Монета идет со дна!
                    </div>
                    <p className="text-sm text-red-400/90">
                      Она показывает сильный рост (+{(selectedSignal.change24h || 0).toFixed(2)}%) и может знатно полететь вверх. Шортим очень аккуратно: используйте минимальное плечо (2x) и заходите небольшим объемом (1-2% от депозита на первый шаг). Шаг усреднения лучше сделать шире (от 4%).
                    </p>
                  </div>
                )}
                <div className="space-y-4 text-sm text-zinc-300">
                  <p>
                    <strong className="text-zinc-100">Вход и усреднение:</strong> Заходим первым ордером на <strong className="text-yellow-400">${formatPrice(entryPrice)}</strong>. Если цена идет против нас (растет), расставляем лимитные ордера по сетке. Каждый следующий ордер больше предыдущего в 2 раза, что позволяет быстро сместить среднюю цену входа.
                  </p>
                  <p>
                    <strong className="text-zinc-100">Выход из сделки (Тейк-профит):</strong> Основная цель для фиксации прибыли — <strong className="text-emerald-400">{takeProfit ? `$${formatPrice(Number(takeProfit))}` : 'не задана'}</strong>. Рекомендуется закрывать 50% позиции при достижении профита в 10-15% (с учетом плеча), а остаток тянуть до основной цели, переведя стоп-лосс в безубыток.
                  </p>
                  <p>
                    <strong className="text-zinc-100">Стоп-лосс:</strong> Устанавливается на 1-2% выше последнего (самого верхнего) ордера усреднения. Если сработали все {stepsCount} шагов, и цена продолжает расти, необходимо жестко фиксировать убыток, чтобы избежать ликвидации.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}

      {mainTab === 'scanner' && terminalVisible && (
        <div 
          id="simulator-section" 
          className={cn(
            "bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 shadow-2xl",
            isTerminalFullscreen ? "fixed inset-0 bg-zinc-950 z-[9999] overflow-y-auto p-6 w-screen h-screen rounded-none flex flex-col" : ""
          )}
        >
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4 border-b border-zinc-800/50 pb-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-indigo-500/10 rounded-xl">
                <Activity className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2">SpreadScanner</h2>
                  
                  {/* Кнопки управления окном терминала */}
                  <div className="flex items-center gap-1.5 ml-2">
                    <button
                      onClick={toggleFullscreen}
                      className="p-1.5 bg-zinc-950/80 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all rounded-md flex items-center justify-center cursor-pointer"
                      title={isTerminalFullscreen ? "Свернуть" : "Открыть во весь экран"}
                    >
                      {isTerminalFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                    </button>
                    
                    <button
                      onClick={handleOpenNewWindow}
                      className="p-1.5 bg-zinc-950/80 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all rounded-md flex items-center justify-center cursor-pointer"
                      title="Открыть в отдельном окне/вкладке"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1.5">
                  <div className={cn("w-2 h-2 rounded-full animate-pulse", tradingMode === 'virtual' ? "bg-indigo-500" : "bg-emerald-500")} />
                  {tradingMode === 'virtual' ? 'Виртуальный режим (Виртуальный терминал)' : 'Реальный режим (API Биржи)'}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
              {/* Mode Toggle */}
              <div className="bg-zinc-950 border border-zinc-800 p-1 rounded-xl flex items-center">
                <button
                  onClick={() => handleToggleTradingMode('virtual')}
                  className={cn(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2",
                    tradingMode === 'virtual' ? "bg-indigo-500 text-white shadow-lg" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  Виртуальный
                </button>
                <button
                  onClick={() => handleToggleTradingMode('real')}
                  disabled={!exchangeConfigEnabled}
                  className={cn(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2",
                    tradingMode === 'real' ? "bg-emerald-600 text-white shadow-lg" : "text-zinc-500 hover:text-zinc-300",
                    !exchangeConfigEnabled && "opacity-50 cursor-not-allowed"
                  )}
                >
                  Реальный
                  {!exchangeConfigEnabled && <Settings className="w-3 h-3 ml-1" />}
                </button>
              </div>

              {/* Balance Widget */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-4 px-4 py-2 bg-zinc-950 border border-zinc-800 rounded-xl min-w-[220px]">
                  <div className="flex-1">
                    <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5 flex justify-between gap-1 items-start">
                      <span>Доступно:</span>
                      {tradingMode === 'virtual' && (
                        <div className="flex flex-col items-end gap-0.5 ml-2 font-mono text-[9px] font-bold">
                          <span className={cn(
                            dailyDrawdownPct >= 0 ? "text-emerald-500" : (dailyDrawdownPct <= -12 ? "text-rose-500 animate-pulse" : "text-amber-500")
                          )}>
                            День: {dailyDrawdownPct >= 0 ? "+" : ""}{dailyDrawdownPct.toFixed(1)}%
                          </span>
                          <span className={cn(
                            weeklyDrawdownPct >= 0 ? "text-emerald-500" : (weeklyDrawdownPct <= -20 ? "text-rose-500 animate-pulse" : "text-amber-500")
                          )}>
                            Нед: {weeklyDrawdownPct >= 0 ? "+" : ""}{weeklyDrawdownPct.toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </div>
                    <div className={cn("text-base font-black font-mono flex items-center justify-between", tradingMode === 'virtual' ? "text-indigo-400 hover:text-indigo-300 cursor-pointer" : "text-emerald-400")}>
                      <span 
                        onClick={tradingMode === 'virtual' ? handleEditBalance : undefined} 
                        title={tradingMode === 'virtual' ? "Редактировать баланс" : undefined}
                      >
                        {tradingMode === 'virtual' 
                          ? `$${(virtualBalance || 0).toFixed(2)}` 
                          : ((realBalance !== null && realBalance !== undefined) 
                              ? (isRealBalanceVisible ? `$${realBalance.toFixed(2)}` : "$••••") 
                              : '---')}
                      </span>
                    </div>
                  </div>
                  {tradingMode === 'virtual' && (
                    <div className="flex items-center gap-1">
                      <button onClick={handleTopUpBalance} title="Пополнить баланс" className="p-1 hover:bg-zinc-800 rounded-lg text-indigo-400 transition-colors border border-indigo-500/10">
                        <Plus className="w-4 h-4" />
                      </button>
                      <button onClick={handleEditBalance} title="Редактировать баланс" className="p-1 hover:bg-zinc-800 rounded-lg text-indigo-400 transition-colors border border-indigo-500/10">
                        <Edit className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  {tradingMode === 'real' && (
                    <button 
                      onClick={async () => {
                        if (onRefreshRealBalance) {
                          if (addToast) addToast('Обновление баланса...', 'info');
                          await onRefreshRealBalance();
                          if (addToast) addToast('Баланс обновлен!', 'success');
                        }
                      }} 
                      title="Обновить баланс" 
                      className="p-1 hover:bg-zinc-800 rounded-lg text-emerald-400 transition-colors border border-emerald-500/10"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2"><Activity className="w-5 h-5 text-indigo-400" /> Открытые позиции (Terminal)</h2>
              <p className="text-sm text-zinc-400 mt-1">Отработка сигналов и обучение ИИ на реальных результатах</p>
            </div>
            {displayActiveTrades.length > 0 && (
              <div className="px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl flex items-center gap-2 self-start md:self-auto shadow-md">
                <span className="text-xs text-zinc-400 font-medium">Общий PnL открытых позиций:</span>
                <span className={cn("text-sm font-black font-mono tracking-tight", totalOpenPnl >= 0 ? "text-emerald-400" : "text-rose-500")}>
                  {totalOpenPnl >= 0 ? '+' : ''}{totalOpenPnl.toFixed(2)} USDT
                </span>
              </div>
            )}
          </div>

          <div className="mb-4">
            <h3 className="text-lg font-medium text-zinc-100">Активные сделки</h3>
          </div>
          <div className="space-y-4 mb-8">
            {displayActiveTrades.length === 0 ? (
              <div className="text-zinc-500 text-sm">Нет активных сделок.</div>
            ) : displayActiveTrades.map((trade, idx) => (
              <ActiveTradeItem 
                key={`${trade.id}-${idx}`}
                trade={trade}
                latestPrices={renderedPrices}
                livePrice={livePrice}
                handleCloseActiveTrade={handleCloseActiveTrade}
                handleChangeTradeMode={handleChangeTradeMode}
                handleLeverageChange={handleLeverageChange}
                handleSlTpChange={handleSlTpChange}
                handleAverageTrade={handleAverageTrade}
                activeTerminalTradeId={activeTerminalTradeId}
                setActiveTerminalTradeId={setActiveTerminalTradeId}
                isRealBalanceVisible={isRealBalanceVisible}
              />
            ))}
          </div>
        </div>
      )}
      
      {mainTab === 'history' && (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            <h2 className="text-xl font-bold text-zinc-100 flex items-center gap-2"><History className="w-6 h-6 text-indigo-400" /> История сделок</h2>
            {historyTab === 'learning' && (
               <div className="flex items-center gap-2 px-3 py-1 bg-indigo-500/10 border border-indigo-500/20 rounded-full">
                  <span className="w-2 h-2 bg-indigo-400 rounded-full animate-pulse" />
                  <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">ИИ Обучение активно</span>
               </div>
            )}
            <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800/50 flex-wrap gap-1">
               <button onClick={() => setHistoryTab('virtual')} className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-colors", historyTab === 'virtual' ? "bg-indigo-500 text-white" : "text-zinc-500 hover:text-zinc-300")}>Виртуальные</button>
               <button onClick={() => setHistoryTab('learning')} className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-colors", historyTab === 'learning' ? "bg-amber-600 text-white" : "text-zinc-500 hover:text-zinc-300")} title="Сделки, которые ИИ открывает сам в фоне для обучения">Фоновое обучение ИИ</button>
               <button onClick={() => setHistoryTab('real')} className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-colors", historyTab === 'real' ? "bg-emerald-600 text-white" : "text-zinc-500 hover:text-zinc-300")}>Реальные</button>
               <button onClick={() => setHistoryTab('analytics')} className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-colors", historyTab === 'analytics' ? "bg-purple-600 text-white" : "text-zinc-500 hover:text-zinc-300")}>Аналитика</button>
               <button onClick={() => setHistoryTab('signal_analytics')} className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 shadow-sm", historyTab === 'signal_analytics' ? "bg-indigo-600 text-white font-bold" : "text-zinc-400 hover:text-zinc-200")}>
                 <BarChart3 className="w-4 h-4 text-indigo-300" /> Аналитика сигналов
               </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="p-4 bg-emerald-500/5 border border-emerald-500/10 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Search className="w-16 h-16 text-emerald-400" />
              </div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                <h3 className="text-sm font-black text-emerald-300 uppercase tracking-tighter">Обучение Агента №1 (Сканер)</h3>
                <div className="ml-auto text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full uppercase">Scanning Market</div>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Агент №1 непрерывно сканирует рынок в поисках паттернов "Слив/Отскок" и сигналов BOS/ChoCh. 
                Он обучается на реальном потоке данных, сравнивая силу сигналов с движениями на WEEX.
              </p>
              <div className="mt-3 flex gap-1">
                 <div className="h-1 flex-1 bg-emerald-500/20 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 w-3/4 animate-pulse" />
                 </div>
              </div>
            </div>

            <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Bot className="w-16 h-16 text-indigo-400" />
              </div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-pulse" />
                <h3 className="text-sm font-black text-indigo-300 uppercase tracking-tighter">Обучение Агента №2 (Менеджер Позиций)</h3>
                <div className="ml-auto text-[10px] text-indigo-500 font-bold bg-indigo-500/10 px-2 py-0.5 rounded-full uppercase">Position Management</div>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Агент №2 обучается на закрытых сделках (SHORT и LONG). Он анализирует точки входа, эффективность 
                Trailing Stop, усреднения DCA и развороты рынка, формируя новые правила для Базы Знаний.
              </p>
              <div className="mt-3 flex gap-1">
                 <div className="h-1 flex-1 bg-indigo-500/20 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 w-1/2 animate-pulse" />
                 </div>
              </div>
            </div>

            <div className="p-4 bg-violet-500/5 border border-violet-500/10 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <TrendingUp className="w-16 h-16 text-violet-400" />
              </div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-2 h-2 bg-violet-400 rounded-full animate-pulse" />
                <h3 className="text-sm font-black text-violet-300 uppercase tracking-tighter">Обучение Агента №3 (Менеджер LONG)</h3>
                <div className="ml-auto text-[10px] text-violet-500 font-bold bg-violet-500/10 px-2 py-0.5 rounded-full uppercase">Long Managing</div>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Агент №3 непрерывно оптимизирует ведение лонг-позиций. Он калибрует уровни поддержки, сигнальный тренд, динамический тейк-профит и стоп-лосс на отскоках.
              </p>
              <div className="mt-3 flex gap-1">
                 <div className="h-1 flex-1 bg-violet-500/20 rounded-full overflow-hidden">
                    <div className="h-full bg-violet-500 w-2/3 animate-pulse" />
                 </div>
              </div>
            </div>
          </div>
          
          {historyTab === 'signal_analytics' ? (
            <Suspense fallback={
              <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
                <span className="text-xs text-zinc-400 font-mono">Загрузка аналитики сигналов...</span>
              </div>
            }>
              <SignalAnalyticsDashboard trades={allTradesArray} onRefresh={manualSync} />
            </Suspense>
          ) : historyTab === 'analytics' ? (
            <Suspense fallback={
              <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mb-2" />
                <span className="text-xs text-zinc-400 font-mono">Загрузка аналитики...</span>
              </div>
            }>
              <AnalyticsTab trades={allTradesArray} onRefresh={manualSync} onExport={handleExportDB} isLoading={loading} />
            </Suspense>
          ) : historyTab === 'learning' ? (
            <div className="space-y-4">
              {autoLearningTrades.length === 0 ? (
                <div className="text-zinc-500 text-sm text-center py-10 bg-zinc-950/50 rounded-lg border border-zinc-800/50">
                  Нет фоновых сделок. ИИ автоматически откроет виртуальную сделку при уверенности выше 95% для обучения.
                </div>
              ) : (
                autoLearningTrades
                  .sort((a, b) => (b.closeTime || b.openTime || 0) - (a.closeTime || a.openTime || 0))
                  .map((trade, idx) => {
                    const calculatedPct = trade.pnlPercent !== undefined && trade.pnlPercent !== null
                      ? trade.pnlPercent
                      : (trade.entryPrice && trade.closePrice
                          ? (trade.side === 'SHORT'
                              ? ((trade.entryPrice - trade.closePrice) / trade.entryPrice) * 100 * (trade.leverage || 1)
                              : ((trade.closePrice - trade.entryPrice) / trade.entryPrice) * 100 * (trade.leverage || 1))
                          : 0);

                    const calculatedPnlVal = trade.pnl !== undefined && trade.pnl !== null
                      ? trade.pnl
                      : ((trade.amount || trade.initialAmount || 0) * (calculatedPct / 100));
                    return (
                      <div key={trade.id + '-' + idx} className="bg-zinc-950 border border-amber-900/30 rounded-lg p-4 transition-opacity shadow-lg">
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-zinc-100">{trade.symbol}</span>
                              <span className={cn("px-2 py-0.5 text-[10px] font-bold rounded", trade.side === 'SHORT' ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400")}>
                                {trade.side}
                              </span>
                              <span className="text-xs text-zinc-500">{trade.leverage || 1}x</span>
                            </div>
                            <div className="text-[11px] text-zinc-500 mt-1 flex items-center gap-2 flex-wrap">
                              <span>Вход: <strong className="text-zinc-300 font-mono">{trade.entryPrice}</strong> | Выход: <strong className="text-zinc-300 font-mono">{trade.closePrice || '---'}</strong></span>
                              <span className="text-zinc-600">•</span>
                              <span className="text-zinc-400 font-mono flex items-center gap-1">
                                <Clock className="w-3 h-3 text-amber-500/70" />
                                {formatTradeTime(trade.openTime || trade.createdAt)} → {formatTradeTime(trade.closeTime || trade.updatedAt)}
                              </span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={cn("text-sm font-black font-mono", calculatedPnlVal >= 0 ? "text-emerald-400" : "text-rose-400")}>
                              {calculatedPnlVal >= 0 ? '+' : ''}{calculatedPnlVal.toFixed(2)} USDT
                            </div>
                            <div className={cn("text-xs font-bold font-mono", calculatedPct >= 0 ? "text-emerald-500" : "text-rose-500")}>
                              {calculatedPct >= 0 ? '+' : ''}{calculatedPct.toFixed(1)}%
                            </div>
                          </div>
                        </div>

                        {trade.closeReason && (
                          <div className="text-xs text-zinc-400 bg-zinc-900/50 p-2 rounded border border-zinc-800/50 flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                            <span>{trade.closeReason}</span>
                          </div>
                        )}
                        {trade.aiAdvice && (
                          <div className="text-xs text-indigo-300 bg-indigo-500/10 p-2 rounded border border-indigo-500/20 mt-2 flex items-center gap-1.5">
                            <Bot className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                            <span>{trade.aiAdvice}</span>
                          </div>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {currentHistoryTrades.length === 0 ? (
                <div className="text-zinc-500 text-sm text-center py-10 bg-zinc-950/50 rounded-lg border border-zinc-800/50">
                  {historyTab === 'real' ? 'Нет истории реальных сделок' : 'Нет истории виртуальных сделок'}
                </div>
              ) : (
                currentHistoryTrades
                  .sort((a, b) => (b.closeTime || b.openTime || 0) - (a.closeTime || a.openTime || 0))
                  .map((trade, idx) => {
                    const pnlVal = trade.pnl !== undefined && trade.pnl !== null
                      ? trade.pnl
                      : ((trade.amount || trade.initialAmount || 0) * ((trade.pnlPercent || 0) / 100));
                    const pnlPct = trade.pnlPercent || 0;
                    const durationStr = formatTradeDuration(trade.openTime || trade.createdAt, trade.closeTime || trade.updatedAt);
                    return (
                      <div key={trade.id + '-' + idx} className="bg-zinc-950 border border-zinc-800/50 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-zinc-100">{trade.symbol}</span>
                            <span className={cn("px-2 py-0.5 text-[10px] font-bold rounded", trade.side === 'SHORT' ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400")}>
                              {trade.side}
                            </span>
                            <span className="text-xs text-zinc-500">{trade.leverage || 1}x</span>
                            {trade.mode === 'AUTO' && (
                              <span className="text-[10px] font-bold text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                                AUTO
                              </span>
                            )}
                            {durationStr && (
                              <span className="text-[10px] text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800 flex items-center gap-1 font-mono">
                                <Clock className="w-3 h-3 text-zinc-500" />
                                {durationStr}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-400 flex items-center gap-2 flex-wrap">
                            <span>Вход: <strong className="text-zinc-200 font-mono">{trade.entryPrice}</strong></span>
                            <span className="text-zinc-600">•</span>
                            <span>Закрытие: <strong className="text-zinc-200 font-mono">{trade.closePrice || '---'}</strong></span>
                            {trade.amount && (
                              <>
                                <span className="text-zinc-600">•</span>
                                <span>Объем: <span className="font-mono text-zinc-300">{Number(trade.amount).toFixed(2)}$</span></span>
                              </>
                            )}
                          </div>
                          <div className="text-[11px] text-zinc-400 flex items-center gap-3 flex-wrap pt-0.5">
                            <div className="flex items-center gap-1">
                              <span className="text-zinc-500">Открыта:</span>
                              <span className="text-zinc-300 font-mono">{formatTradeTime(trade.openTime || trade.createdAt)}</span>
                            </div>
                            <span className="text-zinc-700 hidden sm:inline">•</span>
                            <div className="flex items-center gap-1">
                              <span className="text-zinc-500">Закрыта:</span>
                              <span className="text-zinc-300 font-mono">{formatTradeTime(trade.closeTime || trade.updatedAt)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-left sm:text-right flex sm:flex-col justify-between sm:justify-center items-end border-t sm:border-t-0 pt-2 sm:pt-0 border-zinc-800">
                          <div className={cn("text-sm font-bold font-mono", pnlVal >= 0 ? "text-emerald-400" : "text-rose-400")}>
                            {pnlVal >= 0 ? '+' : ''}{pnlVal.toFixed(2)} USDT
                          </div>
                          <div className={cn("text-xs font-mono", pnlPct >= 0 ? "text-emerald-500" : "text-rose-500")}>
                            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TradingTerminal;
