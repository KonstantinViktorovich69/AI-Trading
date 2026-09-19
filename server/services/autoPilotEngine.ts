import ccxt from 'ccxt';
import { normalizeSymbol } from '../quant.ts';
import { calculateKelly, calculateAdaptiveCloseRatios } from '../quant.ts';
import { logStructured } from '../utils/logger.ts';
import { executePaperTradeOpenTransaction, executePaperTradeCloseTransaction } from './paperTradeTransaction.ts';
import { dbAtomicStore } from '../atomicDbSaver.ts';
import { type AgentDecisionEnvelope, evaluateCommitteeConsensus } from './agentEngine.ts';
import { createAutopilotTradeIntentFromScanner } from './autopilotIntentFactory.ts';
import { type AutoEntryExecutionPort } from './autoEntryService.ts';
import { calculateStructuralStopLoss, calculateStructuralTpLadder } from './structuralExitLevels.ts';
import { calculateOteEntryZone } from './oteEntryCalculator.ts';
import { addOtePendingCandidate } from './oteVirtualQueue.ts';

export interface AutoPilotEngineDependencies {
  getGlobalSettings: () => any;
  getCacheSignals: () => any;
  getVirtualTrades: () => any[];
  pushVirtualTrade: (trade: any) => void;
  getVirtualBalance: () => number;
  setVirtualBalance: (val: number) => void;
  getStartOfDayBalance: () => number;
  getGlobalCcxtTickers: () => Record<string, any>;
  getGlobalTrueOhlcv: () => Record<string, any>;
  getGlobalAdx: () => Record<string, number>;
  getGlobalAtr: () => Record<string, number>;
  getGlobalOrderBookHistory: () => Record<string, any[]>;
  getOrderBookImbalance: () => Record<string, any>;
  getGlobalMarketPulse: () => any;
  getProlivPeaks: () => any[];
  getAutopilotFailedSymbols: () => Set<string>;
  getSymbolsUndergoingRealOpen: () => Set<string>;
  isCircuitBreakerActive: () => boolean;
  committeeVetoShadowStats: { totalRealEntriesChecked: number; wouldHaveBlockedCount: number };
  acquireExecutionLock: (symbol: string) => boolean;
  isWeexApiSupported: (symbol: string) => boolean;
  getCcxtClient: (config: any) => any;
  fetchCachedRealBalance: (client: any, type: string, force: boolean, context: string) => Promise<any>;
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number, oteOptions?: { targetPrice: number; timeoutMs?: number }) => Promise<any>;
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  saveBalanceDB: () => Promise<void>;
  saveSettings: () => Promise<void>;
  sendTelegramMessage: (text: string) => void;
  getAtomicStoreRevision: () => number;
  executeMainVirtualAutoEntry: (params: any, options: any) => Promise<any>;
  executeMainRealAutoEntry: (params: any, options: any) => Promise<any>;
  getLossStreakSizeDampening: (trades: any[]) => number;
  getWallAdjustedTp: (symbol: string, isSell: boolean, entry: number, target: number) => number;
}

export interface CandidateQueueOptions {
  allowedTradingDirections?: string;
  activeLongCount?: number;
  activeShortCount?: number;
}

/**
 * Robust numerical price formatter that prevents truncation to 0 for small crypto assets
 */
export function formatNumericPrice(p: number): number {
  if (!p || isNaN(p) || p <= 0) return p;
  if (p < 0.0001) return Number(p.toPrecision(6));
  if (p < 1) return Number(p.toFixed(6));
  return Number(p.toFixed(5));
}

/**
 * Builds a balanced, interleaved 50/50 candidate queue for execution.
 * Ensures neither LONG nor SHORT can monopolize execution slots merely by having higher individual aiScores,
 * and prioritizes the lagging direction if there is an existing position imbalance.
 */
export function buildBalancedCandidateQueue(rawSignals: any[], options?: CandidateQueueOptions): any[] {
  if (!Array.isArray(rawSignals) || rawSignals.length === 0) return [];

  const allowedDir = options?.allowedTradingDirections || 'BOTH';
  const longCandidates = allowedDir === 'SHORT_ONLY'
    ? []
    : rawSignals.filter((s: any) => s && (s.signal === 'LONG' || (s.signal && s.signal.includes('BUY'))));
  const shortCandidates = allowedDir === 'LONG_ONLY'
    ? []
    : rawSignals.filter((s: any) => s && (s.signal === 'SHORT' || (s.signal && s.signal.includes('SELL'))));

  longCandidates.sort((a: any, b: any) => (b.aiScore || 0) - (a.aiScore || 0));
  shortCandidates.sort((a: any, b: any) => (b.aiScore || 0) - (a.aiScore || 0));

  const activeLong = options?.activeLongCount ?? 0;
  const activeShort = options?.activeShortCount ?? 0;
  const prioritizeShort = activeShort < activeLong;

  const balancedCandidateSignals: any[] = [];
  const maxSignalCandidates = Math.max(longCandidates.length, shortCandidates.length);

  for (let i = 0; i < maxSignalCandidates; i++) {
    if (prioritizeShort) {
      if (i < shortCandidates.length) balancedCandidateSignals.push(shortCandidates[i]);
      if (i < longCandidates.length) balancedCandidateSignals.push(longCandidates[i]);
    } else {
      if (i < longCandidates.length) balancedCandidateSignals.push(longCandidates[i]);
      if (i < shortCandidates.length) balancedCandidateSignals.push(shortCandidates[i]);
    }
  }

  return balancedCandidateSignals;
}

export async function runAutopilotAndVirtualTradeEntry(deps: AutoPilotEngineDependencies): Promise<void> {
  try {
    const globalSettings = deps.getGlobalSettings();
    if (!globalSettings.isAutopilotEnabled) {
      return;
    }
    const cacheSignals = deps.getCacheSignals();
    if (!cacheSignals || !Array.isArray(cacheSignals.data) || cacheSignals.data.length === 0) {
      return;
    }

    const virtualTrades = deps.getVirtualTrades();
    let virtualBalance = deps.getVirtualBalance();
    const startOfDayBalance = deps.getStartOfDayBalance();
    const GLOBAL_CCXT_TICKERS = deps.getGlobalCcxtTickers();
    const GLOBAL_TRUE_OHLCV = deps.getGlobalTrueOhlcv();
    const GLOBAL_ADX = deps.getGlobalAdx();
    const GLOBAL_ATR = deps.getGlobalAtr();
    const GLOBAL_ORDER_BOOK_HISTORY = deps.getGlobalOrderBookHistory();
    const orderBookImbalance = deps.getOrderBookImbalance();
    const GLOBAL_MARKET_PULSE = deps.getGlobalMarketPulse();
    const prolivPeaks = deps.getProlivPeaks();
    const autopilotFailedSymbols = deps.getAutopilotFailedSymbols();
    const symbolsUndergoingRealOpen = deps.getSymbolsUndergoingRealOpen();
    const isCircuitBreakerActive = deps.isCircuitBreakerActive();
    const committeeVetoShadowStats = deps.committeeVetoShadowStats;

    const targetIsAutoLearning = globalSettings.tradingMode !== 'virtual';
    const marketRegime = cacheSignals.marketRegime || 'NEUTRAL';
    const btcTrend24h = cacheSignals.btcTrend24h || 0;
    
    // Evaluate recent performance using a sliding window of the last 15 closed trades, allowing the system to recover or react quickly
    const closedAuto = [...virtualTrades.filter(t => !!(t as any).isAutoLearning === !!targetIsAutoLearning && t.status === 'CLOSED')]
      .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
      .slice(0, 15);
    const wonAuto = closedAuto.filter(t => (t.pnlPercent || 0) > 0).length;
    const autoWinRate = closedAuto.length >= 3 ? wonAuto / closedAuto.length : 0.70;

    // Считаем раздельно для обхода ограничений на виртуальных сделках и сделках фонового обучения
    const autoWinRateForReal = autoWinRate;
    const autoWinRateForVirtual = 0.80; // Всегда высокая точность для виртуального робота

    // 1. Параметры для виртуальных/обучающих сделок (всегда без ограничений)
    let requiredAutoScoreVirtual = 94;
    let maxAutoLeverageVirtual = 5;
    let sizeMultiplierVirtual = 1.0;

    if (autoWinRateForVirtual < 0.40) {
        requiredAutoScoreVirtual = 97;
        maxAutoLeverageVirtual = 3;
        sizeMultiplierVirtual = 0.4;
    } else if (autoWinRateForVirtual < 0.55) {
        requiredAutoScoreVirtual = 95;
        maxAutoLeverageVirtual = 4;
        sizeMultiplierVirtual = 0.7;
    } else if (autoWinRateForVirtual >= 0.75) {
        requiredAutoScoreVirtual = 93;
        maxAutoLeverageVirtual = 5;
        sizeMultiplierVirtual = 1.25;
    }

    // 2. Параметры для реальных сделок (с полной защитой от просадок и убытков)
    let requiredAutoScoreReal = 94;
    let maxAutoLeverageReal = 5;
    let sizeMultiplierReal = 1.0;

    if (autoWinRateForReal < 0.40) {
        requiredAutoScoreReal = 97;
        maxAutoLeverageReal = 3;
        sizeMultiplierReal = 0.4;
    } else if (autoWinRateForReal < 0.55) {
        requiredAutoScoreReal = 95;
        maxAutoLeverageReal = 4;
        sizeMultiplierReal = 0.7;
    } else if (autoWinRateForReal >= 0.75) {
        requiredAutoScoreReal = 93;
        maxAutoLeverageReal = 5;
        sizeMultiplierReal = 1.25;
    }

    // Корректировка по агрессивности для виртуальных и реальных
    const aggressiveness = globalSettings.autopilotAggressiveness || 'conservative';
    if (aggressiveness === 'moderate') {
        requiredAutoScoreVirtual = Math.min(requiredAutoScoreVirtual, 88);
        sizeMultiplierVirtual = Math.max(sizeMultiplierVirtual, 0.8);
        maxAutoLeverageVirtual = Math.max(maxAutoLeverageVirtual, 5);

        requiredAutoScoreReal = Math.min(requiredAutoScoreReal, 88);
        sizeMultiplierReal = Math.max(sizeMultiplierReal, 0.8);
        maxAutoLeverageReal = Math.max(maxAutoLeverageReal, 5);
        console.log(`[META-LEARNING AUTOPILOT] Moderate aggressiveness applied. Required Score capped at 88. Virtual size multiplier: ${sizeMultiplierVirtual}, Real: ${sizeMultiplierReal}`);
    } else if (aggressiveness === 'aggressive') {
        // Смягчённый кап: агрессивный режим снижает порог относительно адаптивного значения,
        // но больше не обнуляет полностью самозащиту при плохой полосе (адаптивное значение доходит до 97).
        // Нижняя граница 75 сохранена — агрессивный режим всегда мягче Moderate (88) и Conservative (93).
        requiredAutoScoreVirtual = Math.max(75, requiredAutoScoreVirtual - 15);
        sizeMultiplierVirtual = Math.max(sizeMultiplierVirtual * 1.8, 1.2);
        maxAutoLeverageVirtual = Math.max(maxAutoLeverageVirtual, 10);

        requiredAutoScoreReal = Math.max(75, requiredAutoScoreReal - 15);
        sizeMultiplierReal = Math.max(sizeMultiplierReal * 1.8, 1.2);
        maxAutoLeverageReal = Math.max(maxAutoLeverageReal, 10);
        console.log(`[META-LEARNING AUTOPILOT] Aggressive trading active! Required Score reduced to ${requiredAutoScoreReal}. Virtual size boost: ${sizeMultiplierVirtual}x, Real size boost: ${sizeMultiplierReal}x`);
    } else {
        requiredAutoScoreVirtual = Math.min(requiredAutoScoreVirtual, 93);
        requiredAutoScoreReal = Math.min(requiredAutoScoreReal, 93);
    }

    if (globalSettings.aiMinConfidenceThreshold !== undefined) {
        const userThresholdScore = Math.round(globalSettings.aiMinConfidenceThreshold * 100);
        requiredAutoScoreVirtual = Math.min(requiredAutoScoreVirtual, userThresholdScore);
        requiredAutoScoreReal = Math.min(requiredAutoScoreReal, userThresholdScore);
    }

    // Apply Loss Streak Size Dampening
    const recentClosedVirtualForDampening = [...virtualTrades.filter(t => !!(t as any).isAutoLearning === !!targetIsAutoLearning && t.status === 'CLOSED')]
      .sort((a, b) => (a.closeTime || 0) - (b.closeTime || 0))
      .slice(-15);
    const virtualDampening = deps.getLossStreakSizeDampening(recentClosedVirtualForDampening);
    sizeMultiplierVirtual = sizeMultiplierVirtual * virtualDampening;

    const recentClosedRealForDampening = [...virtualTrades.filter(t => t.isReal === true && t.mode === 'AUTO' && t.status === 'CLOSED')]
      .sort((a, b) => (a.closeTime || 0) - (b.closeTime || 0))
      .slice(-15);
    const realDampening = deps.getLossStreakSizeDampening(recentClosedRealForDampening);
    sizeMultiplierReal = sizeMultiplierReal * realDampening;

    // Streak Protection checking
    const recentHourAutos = virtualTrades.filter(t => 
        !!(t as any).isAutoLearning === !!targetIsAutoLearning && 
        t.status === 'CLOSED' && 
        t.closeTime && 
        (Date.now() - t.closeTime < 60 * 60 * 1000)
    ).sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));

    let streakLossesCount = 0;
    for (const t of recentHourAutos) {
        if ((t.pnlPercent || 0) < 0) {
            streakLossesCount++;
        } else {
            break; // Streak interrupted by winning trade
        }
    }

    const isStreakProtectionActiveForReal = streakLossesCount >= 3;
    const streakSizeMultiplierForReal = isStreakProtectionActiveForReal ? 0.50 : 1.0;
    const streakScoreBufferForReal = isStreakProtectionActiveForReal ? 6 : 0;

    // Daily drawdown checks
    const dailyChangePercent = startOfDayBalance > 0 ? ((virtualBalance - startOfDayBalance) / startOfDayBalance) * 100 : 0;
    const dynamicDrawdownThreshold = virtualBalance <= 360.0 ? -6.0 : -15.0;
    const isDailyLimitExceeded = dailyChangePercent <= dynamicDrawdownThreshold;

    // 50/50 Balanced Queue: Ensure equal, symmetrical evaluation of LONG and SHORT signals
    const activeLongCount = virtualTrades.filter(t => t.status === 'OPEN' && t.side === 'LONG').length;
    const activeShortCount = virtualTrades.filter(t => t.status === 'OPEN' && t.side === 'SHORT').length;

    const balancedCandidateSignals = buildBalancedCandidateQueue(cacheSignals.data || [], {
        allowedTradingDirections: (globalSettings as any)?.allowedTradingDirections,
        activeLongCount,
        activeShortCount
    });

    for (const currentSig of balancedCandidateSignals) {
        if (!currentSig || currentSig.signal === 'NEUTRAL' || (currentSig.aiScore || 0) < 70) continue;
        const symbol = currentSig.rawSymbol || currentSig.symbol;
        if (!symbol || typeof symbol !== 'string') continue;
        const price = currentSig.price;
        const exName = currentSig.exchange;
        const finalAiScore = currentSig.aiScore;
        const volatility = typeof currentSig.volatility !== 'undefined' ? Number(currentSig.volatility) : 2.0;

        // --- STRICT SIGNAL QUALITY & PATTERN FILTER ---
        // Disallow entries into unclassified / low-conviction signals lacking volume spike or verified core pattern
        const sigType = (currentSig.type || currentSig.sctoPattern || currentSig.pattern || '').toUpperCase();
        const hasVerifiedPattern = sigType.includes('SAR') || sigType.includes('SPIRE') || sigType.includes('WICK') || 
                                   sigType.includes('BOS') || sigType.includes('PUMP') || sigType.includes('PARABOLIC') || 
                                   sigType.includes('STAGNATION') || sigType.includes('РЕВЕРС') || sigType.includes('РЕТЕСТ') ||
                                   sigType.includes('LIQUIDITY') || sigType.includes('SWEEP') || sigType.includes('ИДЕАЛЬНЫЙ') ||
                                   (Array.isArray(currentSig.matchedRuleIds) && currentSig.matchedRuleIds.length > 0);
        const hasVolumeConfirmation = (Number(currentSig.volumeSpike) || 0) >= 1.3 || (Number(currentSig.volume24h) || Number(currentSig.volume) || 0) >= 200000;
        
        if (!hasVerifiedPattern && !hasVolumeConfirmation && finalAiScore < 88) {
            continue; // Skip unclassified stagnant signals to protect win-rate
        }

        // --- HARD BLOCK ON CONSENSUS REJECT & STRATEGY CHECKLIST ---
        if (currentSig.decisionTrace) {
            const dt = currentSig.decisionTrace;
            const requiredScore = typeof dt.requiredScore === 'number' ? dt.requiredScore : 75;
            if (dt.passedConsensus === false || (typeof dt.consensusScore === 'number' && dt.consensusScore < requiredScore)) {
                console.log(`[AUTOPILOT CONSENSUS GUARD] Rejected entry for ${symbol}: Consensus score ${dt.consensusScore} < ${requiredScore} or passedConsensus is false`);
                continue;
            }

            // Mandatory checklist rule: Liquidity Sweep verification
            if (globalSettings.isLiquiditySweepFilterEnabled !== false) {
                const liquidityFactor = dt.factors?.find((f: any) => f.name === 'LIQUIDITY_SWEEP');
                if (liquidityFactor && liquidityFactor.passed === false) {
                    console.log(`[AUTOPILOT CHECKLIST GUARD] Skipping entry for ${symbol}: LIQUIDITY_SWEEP unconfirmed (waiting for liquidity sweep)`);
                    continue;
                }
            }

            // Mandatory checklist rule: Candlestick Wick Rejection verification
            const wickFactor = dt.factors?.find((f: any) => f.name && f.name.includes('WICK_REJECTION'));
            if (wickFactor && wickFactor.passed === false) {
                console.log(`[AUTOPILOT CHECKLIST GUARD] Skipping entry for ${symbol}: WICK_REJECTION unconfirmed (insufficient candlestick wick rejection)`);
                continue;
            }
        }
        
        // --- RISK CONTROLS ---
        // BTC hyper-growth (Защита от открытия шортов при вертикальном росте BTC)
        const isBtcHyperGrowth = btcTrend24h > 5.0;
        if (isBtcHyperGrowth && (currentSig.signal.includes('SELL') || currentSig.signal.includes('SHORT'))) {
            continue;
        }

        // BTC Panic / Flash Crash (Защита от открытия лонгов при обвале BTC)
        const isBtcPanic = btcTrend24h < -5.0;
        if (isBtcPanic && (currentSig.signal.includes('BUY') || currentSig.signal.includes('LONG'))) {
            continue;
        }

        // Bullish / Bearish Expansion guards
        const isBullishExpansion = marketRegime === 'BULL_TREND' || marketRegime === 'PUMP';
        if (isBullishExpansion && finalAiScore < 85 && (currentSig.signal.includes('SELL') || currentSig.signal.includes('SHORT'))) {
            continue;
        }
        const isBearishExpansion = marketRegime === 'BEAR_TREND' || marketRegime === 'DUMP';
        if (isBearishExpansion && finalAiScore < 85 && (currentSig.signal.includes('BUY') || currentSig.signal.includes('LONG'))) {
            continue;
        }

        // Spread & Volatility protection (Защита от спреда и низкой ликвидности для всех направлений)
        const ticker = GLOBAL_CCXT_TICKERS[exName]?.[symbol];
        const ask = ticker?.ask || ticker?.close || price;
        const bid = ticker?.bid || ticker?.close || price;
        const currentSpreadPct = bid > 0 ? ((ask - bid) / bid) * 100 : 0;
        if (currentSpreadPct > 0.25 && finalAiScore < 95) {
            continue; // Skip wide spread pairs to prevent entry slippage loss
        }

        // Universal Volume Shield (Защита от безимпульсных малоликвидных монет):
        // Согласно правилу RULE[AGENTS_md]: Фильтрация мусора: Игнорировать монеты с объемом < 50,000$ (если нет аномального всплеска > 4x).
        // ЛЕГАСИ-ЛОГИКА: ранее отсекались монеты с volume24h < 200000 при volumeSpike < 1.8, что блокировало качественные сетапы с объемами 50k-200k.
        const volume24h = Number(currentSig.volume24h) || Number(currentSig.volume) || 0;
        const volumeSpike = Number(currentSig.volumeSpike) || 0;
        if (volume24h > 0 && volume24h < 50000 && volumeSpike < 4.0) {
            continue; // Ignore low-volume stagnant coins without volume spike
        }

        // LONG Risk Controls:
        const isBuySignalCheck = currentSig.signal && (currentSig.signal.includes('BUY') || currentSig.signal.includes('LONG'));
        if (isBuySignalCheck) {
            // В падающем/медвежьем рынке для LONG требуется повышенный балл или подтвержденный разворотный импульс
            const isBearishRegime = marketRegime === 'BEAR_TREND' || marketRegime === 'PANIC_DUMP' || btcTrend24h < -3.0;
            if (isBearishRegime && finalAiScore < 95 && !currentSig.volumeSpike && (Number(currentSig.riseFromLow) || 0) < 2.0) {
                console.log(`[AUTOPILOT LONG SHIELD] Ignored ${symbol} LONG in Bearish Market: score ${finalAiScore} < 95 without volume spike or reversal rise`);
                continue;
            }
        }

        // High volatility & wide daily range leverage cap (reduction to 4x-5x on volatile coins)
        const absChange24h = Math.abs(Number(currentSig.change24h) || 0);
        const isHighVolatilityAsset = volatility >= 5.0 || absChange24h >= 7.0;

        let adaptiveLeverageVirtual = maxAutoLeverageVirtual;
        let adaptiveLeverageReal = maxAutoLeverageReal;

        if (isHighVolatilityAsset) {
            adaptiveLeverageVirtual = Math.min(4, Math.max(2, Math.round(maxAutoLeverageVirtual * 0.4)));
            adaptiveLeverageReal = Math.min(4, Math.max(2, Math.round(maxAutoLeverageReal * 0.4)));
            console.log(`[LEVERAGE VOLATILITY CAP] High volatility detected for ${symbol} (vol: ${volatility}, 24h: ${absChange24h}%). Leverage capped to ${adaptiveLeverageVirtual}x.`);
        } else if (volatility > 3.5 || absChange24h >= 4.0) {
            adaptiveLeverageVirtual = Math.min(6, Math.max(2, Math.round(maxAutoLeverageVirtual * 0.6)));
            adaptiveLeverageReal = Math.min(6, Math.max(2, Math.round(maxAutoLeverageReal * 0.6)));
        }

        const normalizedSymbol = normalizeSymbol(symbol);
        const cleanSymNorm = normalizedSymbol;

        // POINT 2: Choppy Market Guard (ADX Check)
        const sigAdx = GLOBAL_ADX[cleanSymNorm] || GLOBAL_TRUE_OHLCV[cleanSymNorm]?.adx15m || 25;
        let choppinessRequiredScore = 0;
        if (sigAdx < 18) {
            choppinessRequiredScore = 78; // Require at least 78% score in flat/choppy markets
        }

        const sigRequiredOverride = currentSig.sctoRequiredScoreOverride || 0;
        const dynamicRequiredAutoScoreVirtual = Math.max(sigRequiredOverride, requiredAutoScoreVirtual, choppinessRequiredScore);
        const dynamicRequiredAutoScoreReal = Math.max(sigRequiredOverride, isStreakProtectionActiveForReal ? Math.min(98, requiredAutoScoreReal + streakScoreBufferForReal) : requiredAutoScoreReal, choppinessRequiredScore);

        const isSellSignal = currentSig.signal && (currentSig.signal.includes('SELL') || currentSig.signal.includes('SHORT'));
        const isBuySignal = currentSig.signal && (currentSig.signal.includes('BUY') || currentSig.signal.includes('LONG'));

        // POINT 3: Orderbook Depth Ratio Check
        const obInfo = orderBookImbalance[cleanSymNorm];
        if (obInfo && (obInfo.bidVolume > 0 || obInfo.askVolume > 0)) {
            const bidVol = obInfo.bidVolume || 1;
            const askVol = obInfo.askVolume || 1;
            if (isSellSignal && (askVol / bidVol) < 0.6) {
                console.log(`[ORDERBOOK SHIELD] Skipping auto SHORT for ${symbol}: Bid density (${bidVol.toFixed(0)}) dominates Ask (${askVol.toFixed(0)}), ratio ${(askVol/bidVol).toFixed(2)} < 0.6`);
                continue;
            }
            if (isBuySignal && (bidVol / askVol) < 0.6) {
                console.log(`[ORDERBOOK SHIELD] Skipping auto LONG for ${symbol}: Ask density (${askVol.toFixed(0)}) dominates Bid (${bidVol.toFixed(0)}), ratio ${(bidVol/askVol).toFixed(2)} < 0.6`);
                continue;
            }
        }

        // 1. VIRTUAL / AUTO LEARNING ENTRY
        if (finalAiScore >= dynamicRequiredAutoScoreVirtual && (isSellSignal || isBuySignal)) {
            const existingAutoTrade = virtualTrades.find(t => {
                const tNorm = normalizeSymbol(t.symbol);
                return t.status === 'OPEN' && tNorm === normalizedSymbol && !!(t as any).isAutoLearning === !!targetIsAutoLearning;
            });

            // Кулдаун по минусовым/закрытым сделкам применяется ИСКЛЮЧИТЕЛЬНО при торговле на РЕАЛЬНОМ балансе!
            // Для виртуального баланса (авто-обучения) кулдаун полностью отключен.
            const recentlyClosedAuto = undefined;

            const activeVirtualCount = virtualTrades.filter(t => t.status === 'OPEN' && !!(t as any).isAutoLearning === !!targetIsAutoLearning).length;
            
            // Balanced capacity: target 6 positions (3 LONG + 3 SHORT) — жесткий лимит не более 6
            const configuredMax = (globalSettings as any).maxActivePositionsVirtual !== undefined ? Number((globalSettings as any).maxActivePositionsVirtual) : 6;
            const maxVirtualPositions = Math.min(6, Math.max(2, configuredMax || 6));
            
            const isVirtualLimitReached = activeVirtualCount >= maxVirtualPositions;

            const sameDirVirtualCount = virtualTrades.filter(t => 
                t.status === 'OPEN' && 
                !!(t as any).isAutoLearning === !!targetIsAutoLearning && 
                t.side === (isSellSignal ? 'SHORT' : 'LONG')
            ).length;

            // Strict directional quota: exactly half the limit (e.g. 3 of 6) to eliminate one-sided skew
            const maxSameDir = (globalSettings as any)?.maxSameDirectionPositions !== undefined
                ? Math.min(3, Math.max(1, Number((globalSettings as any).maxSameDirectionPositions)))
                : Math.max(1, Math.min(3, Math.ceil(maxVirtualPositions / 2)));
            const isSameDirLimitReached = sameDirVirtualCount >= maxSameDir;

            if (isSameDirLimitReached && !isVirtualLimitReached && !existingAutoTrade && !recentlyClosedAuto) {
                console.log(`[RISK ACTUATOR] Virtual auto-trade for ${symbol} blocked: Max active positions in the same direction reached (${sameDirVirtualCount}/${maxSameDir})`);
            }

            if (!isVirtualLimitReached && !isSameDirLimitReached && !existingAutoTrade && !recentlyClosedAuto) {
                if (!deps.acquireExecutionLock(symbol)) {
                    console.log(`[VIRTUAL AUTOPILOT] [LOCK] Skip entry for ${symbol}: Concurrent transaction lock is active.`);
                    continue;
                }
                // Open new virtual trade
                const tradeId = `AL-${Date.now()}-${Math.floor(Math.random() * 10000).toString(36).toUpperCase()}`;
                const cachedIndicators = GLOBAL_TRUE_OHLCV[normalizeSymbol(symbol)] || {};
                const atr = currentSig.atr ? Number(currentSig.atr) : (GLOBAL_ATR[normalizeSymbol(symbol)] || (price * 0.015));

                const signalVol = volatility;
                const slippagePercent = Math.min(0.0015, 0.0005 * (1 + Math.max(0, signalVol - 2.0) * 0.15));
                const slippagePrice = isSellSignal ? formatNumericPrice(price * (1 - slippagePercent)) : formatNumericPrice(price * (1 + slippagePercent));

                const hasWickWorthy = typeof currentSig.wicks !== 'undefined' && currentSig.wicks && (isSellSignal ? currentSig.wicks.topPct > 0.25 : currentSig.wicks.bottomPct > 0.25);
                let optimizedEntryPrice = slippagePrice;
                if (hasWickWorthy && volatility > 4.5) {
                    const shortWickPremium = Math.min(0.005, ((isSellSignal ? currentSig.wicks.topPct : currentSig.wicks.bottomPct) - 0.20) * 0.01);
                    optimizedEntryPrice = isSellSignal
                        ? formatNumericPrice(slippagePrice * (1 + shortWickPremium))
                        : formatNumericPrice(slippagePrice * (1 - shortWickPremium));
                    console.log(`[CHALLENGE ENHANCEMENT] Entry optimized for ${symbol}: entry price adjusted by ${isSellSignal ? '+' : '-'}${(shortWickPremium * 100).toFixed(2)}% to $${optimizedEntryPrice} inside the wick.`);
                }

                const wallCheckSym = normalizeSymbol(symbol);
                const vObHist = GLOBAL_ORDER_BOOK_HISTORY[wallCheckSym];
                let wallPersistence = 0.5;
                if (vObHist && vObHist.length >= 3) {
                    const lastSnaps = vObHist.slice(-8);
                    let snapsWithWalls = 0;
                    lastSnaps.forEach(snap => {
                        if (snap.walls && snap.walls.some((w: any) => w.type === (isSellSignal ? 'ask' : 'bid') && w.distancePct <= 2.2)) {
                            snapsWithWalls++;
                        }
                    });
                    wallPersistence = snapsWithWalls / lastSnaps.length;
                }
                
                if (wallPersistence < 0.25) {
                    const extraBuffer = Math.min(0.003, volatility * 0.0005);
                    optimizedEntryPrice = isSellSignal
                        ? formatNumericPrice(optimizedEntryPrice * (1 + extraBuffer))
                        : formatNumericPrice(optimizedEntryPrice * (1 - extraBuffer));
                    console.log(`[ANTI-SPOOF FILTER] Warning for ${symbol}: High spoof probability detected (intensity ${(wallPersistence*100).toFixed(0)}%). Limit order entry adjusted ${isSellSignal ? 'upwards by +' : 'downwards by -'}${(extraBuffer*100).toFixed(3)}% to $${optimizedEntryPrice} to avoid quick fill and false breakdown.`);
                }

                const autoVolSqueezeFactor = (currentSig.atr && price > 0) ? Math.max(0.5, Math.min(1.8, (Number(currentSig.atr) / price * 100) / 1.75)) : 1.0;
                const dAutoTp1 = Math.max(0.70, 1.0 * autoVolSqueezeFactor);
                const dAutoTp2 = Math.max(1.40, 2.0 * autoVolSqueezeFactor);
                const dAutoTp3 = Math.max(2.60, 3.8 * autoVolSqueezeFactor);
                const dAutoTp4 = Math.max(4.50, 7.0 * autoVolSqueezeFactor);

                // Structural Stop-Loss (привязанный к localLow5m/localHigh5m и буферу ATR)
                const structuralSlVirtual = calculateStructuralStopLoss({
                    isSellSignal,
                    referencePrice: optimizedEntryPrice,
                    localLow5m: cachedIndicators.localLow5m ?? price,
                    localHigh5m: cachedIndicators.localHigh5m ?? price,
                    atr,
                    dAutoTp1OrDRealTp1: dAutoTp1
                });
                const slDistVal = optimizedEntryPrice * structuralSlVirtual.slPct;
                const slPctVal = structuralSlVirtual.slPct;

                const rewardToRiskVal = 2.0;
                const kVal = calculateKelly(finalAiScore, rewardToRiskVal);
                const virtualRiskBudget = virtualBalance * Math.max(0.1, kVal) * 0.05;
                const targetVirtualPosVal = slPctVal > 0 ? (virtualRiskBudget / slPctVal) : (virtualBalance * Math.max(0.1, kVal));
                
                // Scale base position size and minimum size based on current virtualBalance
                let minBaseSize = 20;
                let maxPctOfBalance = 0.15;
                if (virtualBalance <= 150) {
                    minBaseSize = 10;
                    maxPctOfBalance = 0.10;
                } else if (virtualBalance <= 300) {
                    minBaseSize = 15;
                    maxPctOfBalance = 0.10;
                } else if (virtualBalance <= 500) {
                    maxPctOfBalance = 0.12;
                }
                const baseSize = Math.max(minBaseSize, Math.min(virtualBalance * maxPctOfBalance, targetVirtualPosVal));

                const openAutoTradesNowCount = activeVirtualCount;
                let portfolioOverexposureMultiplier = 1.0;
                if (openAutoTradesNowCount >= 2 && openAutoTradesNowCount < 4) {
                    portfolioOverexposureMultiplier = 0.70;
                } else if (openAutoTradesNowCount >= 4) {
                    portfolioOverexposureMultiplier = 0.50;
                }

                let challengeRiskMultiplier = 1.0; // Для виртуальных и обучающих сделок отключены любые ограничения по просадке баланса или точности сделок
                const sctoSizeMult = currentSig.sctoSizeMultiplier || 1.0;

                let calculatedAmount = Number((baseSize * sizeMultiplierVirtual * portfolioOverexposureMultiplier * challengeRiskMultiplier * sctoSizeMult).toFixed(1));
                const requiredMargin = calculatedAmount / adaptiveLeverageVirtual;
                if (requiredMargin > virtualBalance * 0.95) {
                    calculatedAmount = Number((virtualBalance * 0.95 * adaptiveLeverageVirtual).toFixed(1));
                    if (calculatedAmount < 1.0) {
                        console.log(`[VIRTUAL AUTOPILOT] Entry for ${symbol} blocked: virtual balance is too low ($${virtualBalance.toFixed(2)} USDT) to cover minimum trade size`);
                        continue;
                    }
                }

                const autoImbVal = orderBookImbalance[normalizeSymbol(symbol)]?.imbalance ?? 50;
                const autoRatios = calculateAdaptiveCloseRatios(autoImbVal, volatility);

                // Structural TP Ladder (привязанный к swingHigh1h/swingLow1h)
                const tpLadderVirtual = calculateStructuralTpLadder({
                    isSellSignal,
                    referencePrice: optimizedEntryPrice,
                    swingHigh1h: cachedIndicators.swingHigh1h ?? price,
                    swingLow1h: cachedIndicators.swingLow1h ?? price,
                    dAutoTp4OrDRealTp4Floor: dAutoTp4
                });

                const rawTakeProfit = tpLadderVirtual.stage4;
                const adjustedTakeProfit = deps.getWallAdjustedTp(symbol, isSellSignal, optimizedEntryPrice, rawTakeProfit);

                const stage1Target = tpLadderVirtual.stage1;
                const stage2Target = tpLadderVirtual.stage2;
                const stage3Target = tpLadderVirtual.stage3;
                const stage4Target = tpLadderVirtual.stage4;

                const autoEntryPort: AutoEntryExecutionPort = {
                    saveTradeDB: async (t, imm) => {
                        await deps.saveTradeDB(t, imm);
                    },
                    saveBalanceDB: async () => {
                        await deps.saveBalanceDB();
                    },
                    logStructured: (level, category, message, sym, meta) => {
                        logStructured(level as any, category, message, sym, meta);
                    },
                    sendTelegramMessage: (text) => {
                        deps.sendTelegramMessage(text);
                    },
                    getAtomicStoreRevision: () => deps.getAtomicStoreRevision(),
                    reservePaperMargin: async (amountOrMargin: number, immutableTradeId: string, entryIntentId: string, correlationId: string, trade: any) => {
                        const tradeLeverage = Math.max(1, Number(trade?.leverage || 1));
                        const tradeNotional = Number(trade?.amount || amountOrMargin);
                        const margin = trade?.margin
                          ? Number(trade.margin)
                          : (amountOrMargin === tradeNotional && tradeLeverage > 1
                              ? Number((tradeNotional / tradeLeverage).toFixed(2))
                              : Number(amountOrMargin.toFixed(2)));

                        const tx = await executePaperTradeOpenTransaction(dbAtomicStore, {
                            tradeId: immutableTradeId,
                            entryIntentId,
                            correlationId,
                            margin,
                            trade: {
                                ...trade,
                                amount: tradeNotional,
                                initialAmount: tradeNotional,
                                margin,
                                initialMargin: margin,
                                leverage: tradeLeverage
                            },
                            initialBalanceFallback: virtualBalance
                        });
                        if (tx.success) {
                            virtualBalance = tx.newBalance;
                            deps.setVirtualBalance(tx.newBalance);
                            globalSettings.virtualBalance = tx.newBalance; // Authorized cache update after commit
                            return { success: true, newBalance: tx.newBalance };
                        }
                        return { success: false, error: tx.error || 'INSUFFICIENT_VIRTUAL_BALANCE' };
                    },
                    releasePaperMargin: async (amount: number, pnl: number, immutableTradeId: string, closeEventId: string) => {
                        if (!immutableTradeId || !closeEventId) {
                            throw new Error('IMMUTABLE_TRADE_ID_AND_CLOSE_EVENT_ID_REQUIRED');
                        }
                        const tx = await executePaperTradeCloseTransaction(dbAtomicStore, {
                            tradeId: immutableTradeId,
                            closeEventId,
                            closeRatio: 1.0,
                            pnl: pnl || 0,
                            isFullClose: true
                        });
                        if (tx.success) {
                            virtualBalance = tx.newBalance;
                            deps.setVirtualBalance(tx.newBalance);
                            globalSettings.virtualBalance = tx.newBalance; // Authorized cache update after commit
                            return { success: true, newBalance: tx.newBalance };
                        }
                        return { success: false, error: tx.error };
                    },
                    getAvailableVirtualBalance: () => {
                        const state = dbAtomicStore.loadState<any>({});
                        return state?.settings?.main?.virtualBalance ?? virtualBalance ?? 1000;
                    }
                };

                const mainVirtualHunterTimestamp = Date.now();
                const mainVirtualHunterDecision: AgentDecisionEnvelope = {
                    decisionId: `hunter_main_v_${mainVirtualHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                    agentName: 'HUNTER',
                    correlationId: `corr_mv_${mainVirtualHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                    proposedTradeId: `TR-${mainVirtualHunterTimestamp}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`,
                    signalId: currentSig?.id || `sig_${mainVirtualHunterTimestamp}`,
                    strategyId: (globalSettings as any).activeStrategy || 'ADAPTIVE_DYNAMIC',
                    strategyVersion: '2.1.0',
                    stateRevision: deps.getAtomicStoreRevision(),
                    action: finalAiScore >= dynamicRequiredAutoScoreVirtual ? 'APPROVE' : 'NO_TRADE',
                    confidence: finalAiScore,
                    approved: finalAiScore >= dynamicRequiredAutoScoreVirtual,
                    decisionSource: 'AI',
                    rationale: currentSig?.rationale || currentSig?.pattern || `High-conviction pattern detected (Score: ${finalAiScore}%)`,
                    createdAt: mainVirtualHunterTimestamp
                };

                const mainVirtualBearDecision: AgentDecisionEnvelope = {
                    decisionId: `bear_main_v_${mainVirtualHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                    agentName: 'BEAR',
                    correlationId: mainVirtualHunterDecision.correlationId,
                    proposedTradeId: mainVirtualHunterDecision.proposedTradeId,
                    signalId: currentSig?.id || `sig_${mainVirtualHunterTimestamp}`,
                    strategyId: (globalSettings as any).activeStrategy || 'ADAPTIVE_DYNAMIC',
                    strategyVersion: '2.1.0',
                    stateRevision: deps.getAtomicStoreRevision(),
                    action: isDailyLimitExceeded || isSameDirLimitReached || isVirtualLimitReached ? 'REJECT' : 'APPROVE',
                    confidence: 85,
                    approved: !isDailyLimitExceeded && !isSameDirLimitReached && !isVirtualLimitReached,
                    decisionSource: 'AI',
                    rationale: `Risk parameters within limits (Volatility: ${volatility}%, OB Imbalance: ${autoImbVal}%)`,
                    createdAt: mainVirtualHunterTimestamp
                };

                // P0 shared intent factory call before executeMainVirtualAutoEntry
                const mainVirtualOhlcv = GLOBAL_TRUE_OHLCV[normalizeSymbol(symbol)];
                const mainVirtualIntentResult = createAutopilotTradeIntentFromScanner({
                    scannerSignal: currentSig,
                    symbol,
                    rawSettings: globalSettings,
                    rawMarketInput: {
                        price: optimizedEntryPrice,
                        high: currentSig?.high !== undefined ? Number(currentSig.high) : (mainVirtualOhlcv?.high !== undefined ? Number(mainVirtualOhlcv.high) : undefined),
                        low: currentSig?.low !== undefined ? Number(currentSig.low) : (mainVirtualOhlcv?.low !== undefined ? Number(mainVirtualOhlcv.low) : undefined),
                        open: currentSig?.open !== undefined ? Number(currentSig.open) : (mainVirtualOhlcv?.open !== undefined ? Number(mainVirtualOhlcv.open) : undefined),
                        vwap: currentSig?.indicators?.vwap !== undefined ? Number(currentSig.indicators.vwap) : (currentSig?.vwap !== undefined ? Number(currentSig.vwap) : (mainVirtualOhlcv?.vwap !== undefined ? Number(mainVirtualOhlcv.vwap) : undefined)),
                        sar: currentSig?.indicators?.sar !== undefined ? Number(currentSig.indicators.sar) : (currentSig?.sar !== undefined ? Number(currentSig.sar) : (mainVirtualOhlcv?.sar !== undefined ? Number(mainVirtualOhlcv.sar) : undefined)),
                        rsi: currentSig?.rsi !== undefined ? Number(currentSig.rsi) : (currentSig?.indicators?.rsi1h !== undefined ? Number(currentSig.indicators.rsi1h) : (mainVirtualOhlcv?.rsi !== undefined ? Number(mainVirtualOhlcv.rsi) : undefined)),
                        change24h: currentSig?.change24h !== undefined ? Number(currentSig.change24h) : (mainVirtualOhlcv?.change24h !== undefined ? Number(mainVirtualOhlcv.change24h) : undefined),
                        volume24h: Number(currentSig?.volume24h) || Number(currentSig?.volume) || (mainVirtualOhlcv?.volume24h !== undefined ? Number(mainVirtualOhlcv.volume24h) : undefined),
                        avgVolume: Number(currentSig?.volume24h) || Number(currentSig?.volume) || (mainVirtualOhlcv?.volume24h !== undefined ? Number(mainVirtualOhlcv.volume24h) : undefined),
                        orderBookImbalance: (autoImbVal - 50) / 50
                    },
                    sourcePath: 'MAIN_VIRTUAL',
                    correlationId: mainVirtualHunterDecision.correlationId,
                    signalId: currentSig?.id || `sig_${mainVirtualHunterTimestamp}`
                });

                if (!mainVirtualIntentResult.ok) {
                    const rej = (mainVirtualIntentResult as any).rejection;
                    console.log(`[AUTOPILOT] [MAIN_VIRTUAL] Rejection before entry: ${rej?.reasonCode} - ${rej?.reason}`);
                } else {
                    const validatedIntent = mainVirtualIntentResult.intent;
                    const executeVirtualEntryNow = async (entryPriceOverride?: number) => {
                        const autoEntryRes = await deps.executeMainVirtualAutoEntry({
                            symbol,
                            tradeIntent: validatedIntent,
                            marketInput: {
                                symbol,
                                marketType: validatedIntent.marketType,
                                tradingMode: validatedIntent.requestedMode,
                                price: entryPriceOverride ?? optimizedEntryPrice,
                                high: validatedIntent.marketSnapshot.high,
                                low: validatedIntent.marketSnapshot.low,
                                open: validatedIntent.marketSnapshot.open,
                                vwap: validatedIntent.marketSnapshot.vwap,
                                sar: validatedIntent.marketSnapshot.sar,
                                rsi: validatedIntent.marketSnapshot.rsi,
                                change24h: validatedIntent.marketSnapshot.change24h,
                                volume24h: validatedIntent.marketSnapshot.volume24h,
                                avgVolume: validatedIntent.marketSnapshot.avgVolume,
                                orderBookImbalance: (autoImbVal - 50) / 50,
                                isCommitteeConsensusEnabled: (globalSettings as any).isCommitteeConsensusCheckEnabled !== false
                            },
                            currentSig,
                            finalAiScore,
                            calculatedAmount,
                            leverage: adaptiveLeverageVirtual,
                            stopLoss: formatNumericPrice(structuralSlVirtual.stopLoss),
                            takeProfit: adjustedTakeProfit,
                            tpStages: [
                                { targetPrice: stage1Target, targetPercent: Number((tpLadderVirtual.tp4DistancePct * 0.15).toFixed(2)), closeRatio: autoRatios[0], executed: false },
                                { targetPrice: stage2Target, targetPercent: Number((tpLadderVirtual.tp4DistancePct * 0.30).toFixed(2)), closeRatio: autoRatios[1], executed: false },
                                { targetPrice: stage3Target, targetPercent: Number((tpLadderVirtual.tp4DistancePct * 0.55).toFixed(2)), closeRatio: autoRatios[2], executed: false },
                                { targetPrice: stage4Target, targetPercent: Number(tpLadderVirtual.tp4DistancePct.toFixed(2)), closeRatio: autoRatios[3], executed: false }
                            ],
                            gridOrders: (() => {
                                const cleanSym = (symbol || '').replace(/[\/:]/g, '');
                                const assetAtr = currentSig?.atr ? Number(currentSig.atr) : (GLOBAL_ATR[cleanSym] || (optimizedEntryPrice * 0.015));
                                const dcaStepPct = Math.max(0.012, (assetAtr / optimizedEntryPrice) * 0.8);
                                const p1 = validatedIntent.side === 'SHORT' ? optimizedEntryPrice * (1 + dcaStepPct) : optimizedEntryPrice * (1 - dcaStepPct);
                                const p2 = validatedIntent.side === 'SHORT' ? optimizedEntryPrice * (1 + 2 * dcaStepPct) : optimizedEntryPrice * (1 - 2 * dcaStepPct);
                                const dcaMultFactor = Math.min(1.0, globalSettings.dcaMultiplierFactor || 1.0);
                                return [
                                    { price: formatNumericPrice(p1), amount: Number((calculatedAmount * 0.20 * dcaMultFactor).toFixed(1)), executed: false },
                                    { price: formatNumericPrice(p2), amount: Number((calculatedAmount * 0.30 * dcaMultFactor).toFixed(1)), executed: false }
                                ];
                            })(),
                            targetIsAutoLearning,
                            virtualBalance
                        }, {
                            executionPort: autoEntryPort,
                            hunterDecision: mainVirtualHunterDecision,
                            bearDecision: mainVirtualBearDecision,
                            isCommitteeConsensusEnabled: (globalSettings as any).isCommitteeConsensusCheckEnabled !== false
                        });

                        if (autoEntryRes.executed && autoEntryRes.trade) {
                            deps.pushVirtualTrade(autoEntryRes.trade);
                            virtualTrades.push(autoEntryRes.trade);
                            if (targetIsAutoLearning) {
                                console.log(`[AUTO-LEARNING] [MAIN-THREAD] Started tracking ${validatedIntent.side === 'SHORT' ? 'SHORT' : 'LONG'} trade for ${symbol} with dynamic required score ${dynamicRequiredAutoScoreVirtual}% (WinRate: ${(autoWinRate * 100).toFixed(1)}%). CorrelationID: ${autoEntryRes.trade.id}`);
                            } else {
                                console.log(`[VIRTUAL AUTOPILOT] [MAIN-THREAD] Opened virtual trade for ${symbol} with dynamic required score ${dynamicRequiredAutoScoreVirtual}% (WinRate: ${(autoWinRate * 100).toFixed(1)}%). CorrelationID: ${autoEntryRes.trade.id}`);
                            }
                        }
                    };

                    if (globalSettings.isOteEntryEnabled === true) {
                        const oteResult = calculateOteEntryZone({
                            isSellSignal,
                            price,
                            localLow5m: cachedIndicators.localLow5m ?? price,
                            localHigh5m: cachedIndicators.localHigh5m ?? price
                        });
                        if (oteResult.isValid) {
                            addOtePendingCandidate({
                                id: `ote_virtual_${symbol}_${Date.now()}`,
                                symbol,
                                zoneLow: oteResult.zoneLow,
                                zoneHigh: oteResult.zoneHigh,
                                startedAtMs: Date.now(),
                                context: { executeVirtualEntry: executeVirtualEntryNow }
                            });
                        } else {
                            await executeVirtualEntryNow();
                        }
                    } else {
                        await executeVirtualEntryNow();
                    }
                }
            }
        }

        // 2. REAL AUTOPILOT ENTRY
        const config = globalSettings.exchangeApiConfig;
        const activeRealCount = virtualTrades.filter(t => t.status === 'OPEN' && t.isReal === true && t.mode === 'AUTO').length;
        const configuredRealMax = (globalSettings as any).maxActivePositionsReal !== undefined ? Number((globalSettings as any).maxActivePositionsReal) : 6;
        const maxRealPositions = Math.min(6, Math.max(2, configuredRealMax || 6));
        const isRealLimitReached = activeRealCount >= maxRealPositions;

        if (globalSettings.tradingMode === 'real' && config && config.isEnabled && config.apiKey && !isDailyLimitExceeded) {
            if (isCircuitBreakerActive) {
                continue;
            }
            const isCommitteeConsensusCheckEnabled = globalSettings.isCommitteeConsensusCheckEnabled !== false;
            const verdict = currentSig.judgeDecision || '';
            const p = currentSig.confidenceP || 0;
            const minThreshold = globalSettings.aiMinConfidenceThreshold !== undefined ? globalSettings.aiMinConfidenceThreshold : 0.75;
            const isDirectionalMismatch = (isSellSignal && verdict === 'LONG') || (!isSellSignal && verdict === 'SHORT');
            const isVetoTriggered = (verdict === 'NEUTRAL' || isDirectionalMismatch) && p >= minThreshold;

            const realHunterDec: AgentDecisionEnvelope = {
                decisionId: `dec_hunter_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                agentName: 'HUNTER',
                signalId: currentSig.id || `sig_${Date.now()}`,
                strategyId: 'CANONICAL_QUANT_SCALP_V2',
                strategyVersion: '2.1.0',
                action: 'APPROVE',
                confidence: Math.round(finalAiScore),
                approved: true,
                decisionSource: 'AI',
                rationale: `Hunter signal detected for real trade with score ${finalAiScore}`,
                createdAt: Date.now()
            };

            const realBearDec: AgentDecisionEnvelope = {
                decisionId: `dec_bear_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                agentName: 'BEAR',
                signalId: currentSig.id || `sig_${Date.now()}`,
                strategyId: 'CANONICAL_QUANT_SCALP_V2',
                strategyVersion: '2.1.0',
                action: isVetoTriggered ? 'REJECT' : 'APPROVE',
                confidence: Math.round(isVetoTriggered ? (p * 100) : finalAiScore),
                approved: !isVetoTriggered,
                decisionSource: 'RULE_ENGINE',
                rationale: isVetoTriggered 
                    ? `Bear risk evaluation vetoed: verdict=${verdict}, mismatch=${isDirectionalMismatch}, p=${p}` 
                    : `Bear risk evaluation approved for ${symbol}`,
                createdAt: Date.now()
            };

            const realCommitteeConsensus = evaluateCommitteeConsensus(realHunterDec, realBearDec, isCommitteeConsensusCheckEnabled);

            committeeVetoShadowStats.totalRealEntriesChecked++;
            if (!realCommitteeConsensus.approved) {
                committeeVetoShadowStats.wouldHaveBlockedCount++;
            }
            if (!realCommitteeConsensus.approved && isCommitteeConsensusCheckEnabled) {
                console.log(`[COMMITTEE CONSENSUS VIOLATION] Real auto-entry for ${symbol} BLOCKED: ${realCommitteeConsensus.rationale}`);
                continue;
            }
            if (!realCommitteeConsensus.approved && !isCommitteeConsensusCheckEnabled) {
                console.log(`[COMMITTEE CONSENSUS SHADOW] Would have blocked real auto-entry for ${symbol} (${realCommitteeConsensus.rationale}) — check is currently disabled, trade proceeds.`);
            }
            if (config.exchange === 'weex' && !deps.isWeexApiSupported(symbol)) {
                continue;
            }
            const existingRealAutoTrade = virtualTrades.find(t => {
                const tNorm = normalizeSymbol(t.symbol);
                return t.status === 'OPEN' && tNorm === normalizedSymbol && t.isReal === true && t.mode === 'AUTO';
            });
            
            const recentlyClosedRealAuto = virtualTrades.find(t => {
                const tNorm = normalizeSymbol(t.symbol);
                if (tNorm === normalizedSymbol && t.status === 'CLOSED' && t.isReal === true && t.mode === 'AUTO') {
                    const isLoss = (t.pnlPercent || 0) < 0;
                    let cooldownTime = 10 * 60 * 1000;
                    if (isLoss) {
                        const agg = globalSettings.autopilotAggressiveness || 'conservative';
                        if (agg === 'aggressive') {
                            cooldownTime = 15 * 60 * 1000; // 15 Mins
                        } else if (agg === 'moderate') {
                            cooldownTime = 45 * 60 * 1000; // 45 Mins
                        } else {
                            cooldownTime = 2 * 60 * 60 * 1000; // 2 Hours
                        }
                    }
                    return (Date.now() - (t.closeTime || 0) < cooldownTime);
                }
                return false;
            });

            const rsiVal = currentSig.indicators?.rsi1h ?? currentSig.rsi ?? 50;
            const bbVal = currentSig.indicators?.bbStatus ?? currentSig.bbStatus;
            const isVerifiedPattern = !!(currentSig.matchedPattern && (
                currentSig.matchedPattern.includes('SAR') || 
                currentSig.matchedPattern.includes('Spire') || 
                currentSig.matchedPattern.includes('False Breakout') || 
                currentSig.matchedPattern.includes('Retest') || 
                currentSig.matchedPattern.includes('ИДЕАЛЬНЫЙ') || 
                currentSig.matchedPattern.includes('EXTREME') || 
                currentSig.matchedPattern.includes('Exhaustion') || 
                currentSig.matchedPattern.includes('СЛИВ') || 
                currentSig.matchedPattern.includes('ПРОЛИВ')
            ));

            const hasLiquiditySweep = isSellSignal
                ? (bbVal === 'OVERBOUGHT' || (currentSig.funding && currentSig.funding > 0.05) || currentSig.dropProb > 65 || currentSig.indicators?.topWickPct > 0.25 || isVerifiedPattern)
                : (bbVal === 'OVERSOLD' || (currentSig.funding && currentSig.funding < -0.05) || currentSig.riseProb > 65 || currentSig.indicators?.bottomWickPct > 0.25 || isVerifiedPattern);
            const hasConfirmedReversal = isSellSignal
                ? (bbVal === 'OVERBOUGHT' || rsiVal > 62 || currentSig.dropProb > 65 || isVerifiedPattern)
                : (bbVal === 'OVERSOLD' || rsiVal < 38 || currentSig.riseProb > 65 || isVerifiedPattern);
            const isRetestPeakSignal = isVerifiedPattern || (currentSig.type && (currentSig.type.includes('РЕТЕСТ ПИКА') || currentSig.type.includes('РЕТЕСТ ДНА')));
            
            const cleanSymUpper = (symbol || '').split(':')[0].replace(/[\/:]/g, '').toUpperCase();
            const activeRetestPeak = prolivPeaks.find(p => p.symbol === cleanSymUpper);
            const retestPeakPrice = activeRetestPeak ? activeRetestPeak.peakPrice : 0;

            const aggressivenessMode = globalSettings.autopilotAggressiveness || 'conservative';
            let isEntryConf = isRetestPeakSignal || (hasLiquiditySweep && hasConfirmedReversal);
            if (aggressivenessMode === 'moderate') {
                isEntryConf = isRetestPeakSignal || hasLiquiditySweep || hasConfirmedReversal;
            } else if (aggressivenessMode === 'aggressive') {
                isEntryConf = true;
            }

            const sameDirRealCount = virtualTrades.filter(t => 
                t.status === 'OPEN' && 
                t.isReal === true && 
                t.mode === 'AUTO' && 
                t.side === (isSellSignal ? 'SHORT' : 'LONG')
            ).length;
            const maxSameDir = (globalSettings as any)?.maxSameDirectionPositions !== undefined
                ? Math.min(3, Math.max(1, Number((globalSettings as any).maxSameDirectionPositions)))
                : Math.max(1, Math.min(3, Math.ceil(maxRealPositions / 2)));
            const isSameDirRealLimitReached = sameDirRealCount >= maxSameDir;

            if (isRealLimitReached && !existingRealAutoTrade && !recentlyClosedRealAuto && isEntryConf) {
                console.log(`[REAL AUTOPILOT] Trade for ${symbol} blocked: Max active real positions limit reached (${activeRealCount}/${maxRealPositions})`);
            } else if (isSameDirRealLimitReached && !existingRealAutoTrade && !recentlyClosedRealAuto && isEntryConf) {
                console.log(`[REAL AUTOPILOT] Trade for ${symbol} blocked: Max active real positions in the same direction reached (${sameDirRealCount}/${maxSameDir})`);
            }

            const isRealScoreSatisfied = finalAiScore >= dynamicRequiredAutoScoreReal;
            const isOpeningInProgress = symbolsUndergoingRealOpen.has(normalizedSymbol);

            if (isRealScoreSatisfied && !isRealLimitReached && !isSameDirRealLimitReached && !existingRealAutoTrade && !recentlyClosedRealAuto && isEntryConf && !autopilotFailedSymbols.has(symbol.toUpperCase().trim()) && !isOpeningInProgress) {
                symbolsUndergoingRealOpen.add(normalizedSymbol);
                (async () => {
                    try {
                        const exClass = (ccxt as any)[config.exchange] as typeof ccxt.Exchange;
                        if (exClass) {
                            let defaultOptions = { defaultType: config.exchange === 'weex' ? 'swap' : 'future' };
                            const client = deps.getCcxtClient(config);
                            const balance = await deps.fetchCachedRealBalance(client, defaultOptions.defaultType, false, 'fetchBalance for real autopilot').catch(() => null);
                            let realBalanceUSDT = 100;
                            if (balance && balance.USDT) {
                                realBalanceUSDT = balance.USDT.total || balance.USDT.free || 100;
                            }

                            const cachedIndicatorsReal = GLOBAL_TRUE_OHLCV[normalizeSymbol(symbol)] || {};
                            const atr = currentSig.atr ? Number(currentSig.atr) : (GLOBAL_ATR[normalizeSymbol(symbol)] || (price * 0.015));
                            const realVolSqueezeFactor = (currentSig.atr && price > 0) ? Math.max(0.5, Math.min(1.8, (Number(currentSig.atr) / price * 100) / 1.75)) : 1.0;
                            const dRealTp1 = Math.max(0.70, 1.0 * realVolSqueezeFactor);
                            const dRealTp2 = Math.max(1.40, 2.0 * realVolSqueezeFactor);
                            const dRealTp3 = Math.max(2.60, 3.8 * realVolSqueezeFactor);
                            const dRealTp4 = Math.max(4.50, 7.0 * realVolSqueezeFactor);

                            // Structural Stop-Loss (привязанный к localLow5m/localHigh5m и буферу ATR)
                            const structuralSlReal = calculateStructuralStopLoss({
                                isSellSignal,
                                referencePrice: price,
                                localLow5m: cachedIndicatorsReal.localLow5m ?? price,
                                localHigh5m: cachedIndicatorsReal.localHigh5m ?? price,
                                atr,
                                dAutoTp1OrDRealTp1: dRealTp1
                            });
                            const slDistVal = price * structuralSlReal.slPct;
                            const slPctVal = structuralSlReal.slPct;
                            const rewardToRiskVal = 2.0;

                            const k = calculateKelly(finalAiScore, rewardToRiskVal);
                            let maxFraction = 0.05;
                            if (aggressivenessMode === 'moderate') {
                                maxFraction = 0.08;
                            } else if (aggressivenessMode === 'aggressive') {
                                maxFraction = 0.15;
                            }

                            let riskPercentage = (aggressivenessMode === 'moderate') ? 0.015 : ((aggressivenessMode === 'aggressive') ? 0.02 : 0.01);
                            const scaledRiskPercentage = riskPercentage * Math.max(0.5, Math.min(1.5, k * 2.0));
                            const realRiskBudget = realBalanceUSDT * scaledRiskPercentage;
                            const targetRealPosVal = slPctVal > 0 ? (realRiskBudget / slPctVal) : (realBalanceUSDT * Math.max(0.1, k));
                            const activeLev = Math.max(5, adaptiveLeverageReal);
                            const targetRealMargin = targetRealPosVal / activeLev;

                            const safeFraction = Math.max(0.010, Math.min(0.030, k * 0.10));
                            const standardMargin = realBalanceUSDT * safeFraction;
                            
                            const openRealTradesNowCount = activeRealCount;
                            let portfolioOverexposureMultiplier = 1.0;
                            if (openRealTradesNowCount >= 2 && openRealTradesNowCount < 4) {
                                portfolioOverexposureMultiplier = 0.70;
                            } else if (openRealTradesNowCount >= 4) {
                                portfolioOverexposureMultiplier = 0.50;
                            }

                            let challengeRiskMultiplier = 1.0;
                            if (realBalanceUSDT <= 400.0) {
                                challengeRiskMultiplier = 0.85;
                            } else if (realBalanceUSDT >= 700.0 && autoWinRate >= 0.60) {
                                challengeRiskMultiplier = 1.25;
                            }

                            const finalStreakMultiplier = streakSizeMultiplierForReal * sizeMultiplierReal;
                            let totalMargin = Number(Math.max(20.0, Math.min(realBalanceUSDT * maxFraction, Math.min(standardMargin, targetRealMargin)) * portfolioOverexposureMultiplier * challengeRiskMultiplier * finalStreakMultiplier * (currentSig.sctoSizeMultiplier || 1.0)).toFixed(1));

                            if (totalMargin < 20.0) { 
                                if (realBalanceUSDT < 20.0) {
                                    console.log(`[REAL AUTOPILOT] Trade for ${symbol} blocked: insufficient balance ($${realBalanceUSDT.toFixed(2)} USDT) to cover minimum margin ($20.00 USDT)`);
                                    return;
                                }
                                totalMargin = 20.0; 
                            }
                            if (totalMargin > realBalanceUSDT * 0.9) {
                                totalMargin = Number((realBalanceUSDT * 0.9).toFixed(1));
                                if (totalMargin < 5.0) {
                                    console.log(`[REAL AUTOPILOT] Trade for ${symbol} blocked: extreme margin exhaustion ($${totalMargin} USDT vs balance $${realBalanceUSDT} USDT)`);
                                    return;
                                }
                            }
                            if (totalMargin >= 20.0) {
                                const realImbVal = orderBookImbalance[normalizeSymbol(symbol)]?.imbalance ?? 50;
                                const step1Amount = totalMargin;
                                const realLeverage = Math.max(5, adaptiveLeverageReal);
                                const realRatios = calculateAdaptiveCloseRatios(realImbVal, volatility);

                                // Structural TP Ladder (привязанный к swingHigh1h/swingLow1h)
                                const tpLadderReal = calculateStructuralTpLadder({
                                    isSellSignal,
                                    referencePrice: price,
                                    swingHigh1h: cachedIndicatorsReal.swingHigh1h ?? price,
                                    swingLow1h: cachedIndicatorsReal.swingLow1h ?? price,
                                    dAutoTp4OrDRealTp4Floor: dRealTp4
                                });

                                const rawTpPrice = tpLadderReal.stage4;
                                const adjustedTakeProfit = deps.getWallAdjustedTp(symbol, isSellSignal, price, rawTpPrice);

                                const stage1Target = tpLadderReal.stage1;
                                const stage2Target = tpLadderReal.stage2;
                                const stage3Target = tpLadderReal.stage3;
                                const stage4Target = tpLadderReal.stage4;

                                const realExecutionPort: AutoEntryExecutionPort = {
                                    executeRealOpenOnExchange: async (sym, side, amt, lev) => {
                                        if (globalSettings.isOteEntryEnabled === true) {
                                            const oteResult = calculateOteEntryZone({
                                                isSellSignal,
                                                price,
                                                localLow5m: cachedIndicatorsReal.localLow5m ?? price,
                                                localHigh5m: cachedIndicatorsReal.localHigh5m ?? price
                                            });
                                            if (oteResult.isValid) {
                                                return deps.executeRealOpenOnExchange(sym, side, amt, lev, {
                                                    targetPrice: oteResult.targetPrice,
                                                    timeoutMs: undefined
                                                });
                                            }
                                        }
                                        return deps.executeRealOpenOnExchange(sym, side, amt, lev);
                                    },
                                    setRealTradeSlTpOnExchange: async (sym, side, sl, tp) => {
                                        return deps.setRealTradeSlTpOnExchange(sym, side, sl, tp);
                                    },
                                    saveTradeDB: async (t, imm) => {
                                        await deps.saveTradeDB(t, imm);
                                    },
                                    saveBalanceDB: async () => {
                                        await deps.saveBalanceDB();
                                    },
                                    logStructured: (level, category, message, sym, meta) => {
                                        logStructured(level as any, category, message, sym, meta);
                                    },
                                    sendTelegramMessage: (text) => {
                                        deps.sendTelegramMessage(text);
                                    },
                                    getAtomicStoreRevision: () => deps.getAtomicStoreRevision(),
                                    reservePaperMargin: async (amountOrMargin: number, immutableTradeId: string, entryIntentId: string, correlationId: string, trade: any) => {
                                        const tradeLeverage = Math.max(1, Number(trade?.leverage || 1));
                                        const tradeNotional = Number(trade?.amount || amountOrMargin);
                                        const margin = trade?.margin
                                          ? Number(trade.margin)
                                          : (amountOrMargin === tradeNotional && tradeLeverage > 1
                                              ? Number((tradeNotional / tradeLeverage).toFixed(2))
                                              : Number(amountOrMargin.toFixed(2)));

                                        const tx = await executePaperTradeOpenTransaction(dbAtomicStore, {
                                            tradeId: immutableTradeId,
                                            entryIntentId,
                                            correlationId,
                                            margin,
                                            trade: {
                                                ...trade,
                                                amount: tradeNotional,
                                                initialAmount: tradeNotional,
                                                margin,
                                                initialMargin: margin,
                                                leverage: tradeLeverage
                                            },
                                            initialBalanceFallback: virtualBalance
                                        });
                                        if (tx.success) {
                                            virtualBalance = tx.newBalance;
                                            deps.setVirtualBalance(tx.newBalance);
                                            globalSettings.virtualBalance = tx.newBalance; // Authorized cache update after commit
                                            return { success: true, newBalance: tx.newBalance };
                                        }
                                        return { success: false, error: tx.error || 'INSUFFICIENT_VIRTUAL_BALANCE' };
                                    },
                                    releasePaperMargin: async (amount: number, pnl: number, immutableTradeId: string, closeEventId: string) => {
                                        if (!immutableTradeId || !closeEventId) {
                                            throw new Error('IMMUTABLE_TRADE_ID_AND_CLOSE_EVENT_ID_REQUIRED');
                                        }
                                        const tx = await executePaperTradeCloseTransaction(dbAtomicStore, {
                                            tradeId: immutableTradeId,
                                            closeEventId,
                                            closeRatio: 1.0,
                                            pnl: pnl || 0,
                                            isFullClose: true
                                        });
                                        if (tx.success) {
                                            virtualBalance = tx.newBalance;
                                            deps.setVirtualBalance(tx.newBalance);
                                            globalSettings.virtualBalance = tx.newBalance; // Authorized cache update after commit
                                            return { success: true, newBalance: tx.newBalance };
                                        }
                                        return { success: false, error: tx.error };
                                    },
                                    getAvailableVirtualBalance: () => {
                                        const state = dbAtomicStore.loadState<any>({});
                                        return state?.settings?.main?.virtualBalance ?? virtualBalance ?? 1000;
                                    }
                                };

                                const mainRealHunterTimestamp = Date.now();
                                const mainRealHunterDecision: AgentDecisionEnvelope = {
                                    decisionId: `hunter_main_r_${mainRealHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                                    agentName: 'HUNTER',
                                    correlationId: `corr_mr_${mainRealHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                                    proposedTradeId: `TR-REAL-${mainRealHunterTimestamp}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`,
                                    signalId: currentSig?.id || `sig_${mainRealHunterTimestamp}`,
                                    strategyId: (globalSettings as any).activeStrategy || 'ADAPTIVE_DYNAMIC',
                                    strategyVersion: '2.1.0',
                                    stateRevision: deps.getAtomicStoreRevision(),
                                    action: finalAiScore >= dynamicRequiredAutoScoreReal ? 'APPROVE' : 'NO_TRADE',
                                    confidence: finalAiScore,
                                    approved: finalAiScore >= dynamicRequiredAutoScoreReal,
                                    decisionSource: 'AI',
                                    rationale: currentSig?.rationale || currentSig?.pattern || `High-conviction real signal detected (Score: ${finalAiScore}%)`,
                                    createdAt: mainRealHunterTimestamp
                                };

                                const mainRealBearDecision: AgentDecisionEnvelope = {
                                    decisionId: `bear_main_r_${mainRealHunterTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
                                    agentName: 'BEAR',
                                    correlationId: mainRealHunterDecision.correlationId,
                                    proposedTradeId: mainRealHunterDecision.proposedTradeId,
                                    signalId: currentSig?.id || `sig_${mainRealHunterTimestamp}`,
                                    strategyId: (globalSettings as any).activeStrategy || 'ADAPTIVE_DYNAMIC',
                                    strategyVersion: '2.1.0',
                                    stateRevision: deps.getAtomicStoreRevision(),
                                    action: isDailyLimitExceeded || isSameDirRealLimitReached || isRealLimitReached || isCircuitBreakerActive ? 'REJECT' : 'APPROVE',
                                    confidence: 90,
                                    approved: !isDailyLimitExceeded && !isSameDirRealLimitReached && !isRealLimitReached && !isCircuitBreakerActive,
                                    decisionSource: 'AI',
                                    rationale: `Real risk parameters within boundaries (Volatility: ${volatility}%, OB Imbalance: ${realImbVal}%)`,
                                    createdAt: mainRealHunterTimestamp
                                };

                                // P0 shared intent factory call before executeMainRealAutoEntry
                                const mainRealOhlcv = GLOBAL_TRUE_OHLCV[normalizeSymbol(symbol)];
                                const mainRealIntentResult = createAutopilotTradeIntentFromScanner({
                                    scannerSignal: currentSig,
                                    symbol,
                                    rawSettings: globalSettings,
                                    rawMarketInput: {
                                        price: price,
                                        high: currentSig?.high !== undefined ? Number(currentSig.high) : (mainRealOhlcv?.high !== undefined ? Number(mainRealOhlcv.high) : undefined),
                                        low: currentSig?.low !== undefined ? Number(currentSig.low) : (mainRealOhlcv?.low !== undefined ? Number(mainRealOhlcv.low) : undefined),
                                        open: currentSig?.open !== undefined ? Number(currentSig.open) : (mainRealOhlcv?.open !== undefined ? Number(mainRealOhlcv.open) : undefined),
                                        vwap: currentSig?.indicators?.vwap !== undefined ? Number(currentSig.indicators.vwap) : (currentSig?.vwap !== undefined ? Number(currentSig.vwap) : (mainRealOhlcv?.vwap !== undefined ? Number(mainRealOhlcv.vwap) : undefined)),
                                        sar: currentSig?.indicators?.sar !== undefined ? Number(currentSig.indicators.sar) : (currentSig?.sar !== undefined ? Number(currentSig.sar) : (mainRealOhlcv?.sar !== undefined ? Number(mainRealOhlcv.sar) : undefined)),
                                        rsi: currentSig?.rsi !== undefined ? Number(currentSig.rsi) : (currentSig?.indicators?.rsi1h !== undefined ? Number(currentSig.indicators.rsi1h) : (mainRealOhlcv?.rsi !== undefined ? Number(mainRealOhlcv.rsi) : undefined)),
                                        change24h: currentSig?.change24h !== undefined ? Number(currentSig.change24h) : (mainRealOhlcv?.change24h !== undefined ? Number(mainRealOhlcv.change24h) : undefined),
                                        volume24h: Number(currentSig?.volume24h) || Number(currentSig?.volume) || (mainRealOhlcv?.volume24h !== undefined ? Number(mainRealOhlcv.volume24h) : undefined),
                                        avgVolume: Number(currentSig?.volume24h) || Number(currentSig?.volume) || (mainRealOhlcv?.volume24h !== undefined ? Number(mainRealOhlcv.volume24h) : undefined),
                                        orderBookImbalance: (realImbVal - 50) / 50
                                    },
                                    sourcePath: 'MAIN_REAL_STUB',
                                    correlationId: mainRealHunterDecision.correlationId,
                                    signalId: currentSig?.id || `sig_${mainRealHunterTimestamp}`
                                });

                                if (!mainRealIntentResult.ok) {
                                    const rej = (mainRealIntentResult as any).rejection;
                                    console.log(`[AUTOPILOT] [MAIN_REAL] Rejection before entry: ${rej?.reasonCode} - ${rej?.reason}`);
                                } else {
                                    const validatedRealIntent = mainRealIntentResult.intent;
                                    const realAutoEntryRes = await deps.executeMainRealAutoEntry({
                                        symbol,
                                        tradeIntent: validatedRealIntent,
                                        marketInput: {
                                            symbol,
                                            marketType: validatedRealIntent.marketType,
                                            tradingMode: validatedRealIntent.requestedMode,
                                            price: price,
                                            high: validatedRealIntent.marketSnapshot.high,
                                            low: validatedRealIntent.marketSnapshot.low,
                                            open: validatedRealIntent.marketSnapshot.open,
                                            vwap: validatedRealIntent.marketSnapshot.vwap,
                                            sar: validatedRealIntent.marketSnapshot.sar,
                                            rsi: validatedRealIntent.marketSnapshot.rsi,
                                            change24h: validatedRealIntent.marketSnapshot.change24h,
                                            volume24h: validatedRealIntent.marketSnapshot.volume24h,
                                            avgVolume: validatedRealIntent.marketSnapshot.avgVolume,
                                            orderBookImbalance: (realImbVal - 50) / 50,
                                            isCommitteeConsensusEnabled: (globalSettings as any).isCommitteeConsensusCheckEnabled !== false
                                        },
                                        currentSig,
                                        finalAiScore,
                                        calculatedAmount: step1Amount,
                                        leverage: realLeverage,
                                        stopLoss: formatNumericPrice(structuralSlReal.stopLoss),
                                        takeProfit: adjustedTakeProfit,
                                        tpStages: [
                                            { targetPrice: stage1Target, targetPercent: Number((tpLadderReal.tp4DistancePct * 0.15).toFixed(2)), closeRatio: realRatios[0], executed: false },
                                            { targetPrice: stage2Target, targetPercent: Number((tpLadderReal.tp4DistancePct * 0.30).toFixed(2)), closeRatio: realRatios[1], executed: false },
                                            { targetPrice: stage3Target, targetPercent: Number((tpLadderReal.tp4DistancePct * 0.55).toFixed(2)), closeRatio: realRatios[2], executed: false },
                                            { targetPrice: stage4Target, targetPercent: Number(tpLadderReal.tp4DistancePct.toFixed(2)), closeRatio: realRatios[3], executed: false }
                                        ],
                                        gridOrders: (() => {
                                            const dcaMultFactor = Math.min(1.0, globalSettings.dcaMultiplierFactor || 1.0);
                                            return [
                                                { price: formatNumericPrice(price + (validatedRealIntent.side === 'SHORT' ? 1 : -1) * (slDistVal * 0.5)), amount: Number((step1Amount * 0.20 * dcaMultFactor).toFixed(1)), executed: false },
                                                { price: formatNumericPrice(price + (validatedRealIntent.side === 'SHORT' ? 1 : -1) * (slDistVal * 1.0)), amount: Number((step1Amount * 0.30 * dcaMultFactor).toFixed(1)), executed: false }
                                            ];
                                        })()
                                    }, {
                                        executionPort: realExecutionPort,
                                        hunterDecision: mainRealHunterDecision,
                                        bearDecision: mainRealBearDecision,
                                        isCommitteeConsensusEnabled: (globalSettings as any).isCommitteeConsensusCheckEnabled !== false
                                    });

                                    if (realAutoEntryRes.executed && realAutoEntryRes.trade) {
                                        deps.pushVirtualTrade(realAutoEntryRes.trade);
                                        virtualTrades.push(realAutoEntryRes.trade);
                                    } else if (!realAutoEntryRes.executed && realAutoEntryRes.reason) {
                                        const failReason = realAutoEntryRes.reason;
                                        const lowerReason = failReason.toLowerCase();
                                        if (lowerReason.includes('1058') || lowerReason.includes('permission') || lowerReason.includes('trading pair')) {
                                            autopilotFailedSymbols.add(symbol.toUpperCase().trim());
                                            await deps.saveSettings();
                                        }
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        console.log('[REAL AUTOPILOT POSITION OPEN FAILURE]:', err.message || err);
                    } finally {
                        symbolsUndergoingRealOpen.delete(normalizedSymbol);
                    }
                })();
            }
        }
    }
  } catch (error: any) {
    console.error('[AUTOPILOT MAIN ENTRY ERROR]', error);
  }
}
