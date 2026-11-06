/**
 * @file timeMachineService.ts
 * Сервис многосценарного бэктестинга и ретроспективного проигрывания сделок («Машина времени»).
 * Позволяет параллельно проигрывать ранее завершённые сделки на исторических минутных свечах,
 * моделировать альтернативные исходы (OTE-вход, Trailing Stop, PTTP, Breakeven)
 * и передавать синтезированный опыт в контур самообучения ИИ-агентов.
 */

import { calculateOteEntryZone } from './oteEntryCalculator.ts';
import { calculateStructuralStopLoss, calculateStructuralTpLadder } from './structuralExitLevels.ts';
import { evaluateExitPolicy, type ExitTradeSnapshot, type ExitMarketSnapshot } from './exitPolicy.ts';

export type SimulationScenarioId = 'ACTUAL' | 'OTE_ENTRY' | 'TRAILING_STOP' | 'PTTP_PROFIT' | 'BREAKEVEN_QUICK';

export interface ScenarioSimulationResult {
  scenarioId: SimulationScenarioId;
  scenarioName: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlUsdt: number;
  closeReason: string;
  isWin: boolean;
  maxFavorableExcursionPct: number; // MFE (максимальная прибыль внутри сделки)
  maxAdverseExcursionPct: number;    // MAE (максимальная просадка внутри сделки)
  durationMinutes: number;
  executedOtePullback: boolean;
}

export interface TradeTimeMachineAnalysis {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  patternName: string;
  openTime: number;
  closeTime: number;
  amount: number;
  leverage: number;
  actualResult: ScenarioSimulationResult;
  scenarios: Record<SimulationScenarioId, ScenarioSimulationResult>;
  bestScenario: SimulationScenarioId;
  deltaPnlVsActual: number; // Насколько лучший сценарий превзошел фактический результат
  recommendedAction: string;
}

export interface TimeMachineBatchSummary {
  totalAnalyzedTrades: number;
  actualTotalPnlPct: number;
  actualWinRate: number;
  scenarioSummaries: Record<SimulationScenarioId, {
    totalPnlPct: number;
    winRate: number;
    deltaPnlVsActualPct: number;
    bestScenarioTradeCount: number;
  }>;
  overallBestScenario: SimulationScenarioId;
  topAdaptiveLessons: Array<{
    patternName: string;
    bestScenario: SimulationScenarioId;
    advantagePct: number;
    sampleSize: number;
    recommendation: string;
  }>;
  simulatedAt: number;
}

/**
 * Симулирует одну завершенную сделку по нескольким альтернативным стратегиям выхода и входа.
 */
export function simulateTradeAlternatives(
  trade: any,
  candles: Array<[number, number, number, number, number, number]> // [ts, open, high, low, close, vol]
): TradeTimeMachineAnalysis {
  const side: 'LONG' | 'SHORT' = trade.side === 'LONG' ? 'LONG' : 'SHORT';
  const leverage = trade.leverage || 5;
  const amount = trade.amount || trade.initialMargin || 25;
  const actualEntry = trade.entryPrice || (candles.length > 0 ? candles[0][1] : 100);
  const actualExit = trade.closePrice || trade.exitPrice || actualEntry;
  const actualPnlPct = typeof trade.pnlPercent === 'number' ? trade.pnlPercent : ((actualExit - actualEntry) / actualEntry) * (side === 'LONG' ? 1 : -1) * leverage * 100;
  const actualCloseReason = trade.closeReason || (trade as any).closeReasonCode || 'MARKET_CLOSE';
  const openTime = trade.openTime || trade.createdAt || (candles.length > 0 ? candles[0][0] : Date.now() - 3600000);
  const closeTime = trade.closeTime || trade.closedAt || (candles.length > 0 ? candles[candles.length - 1][0] : Date.now());

  // Базовый фактический результат
  const actualResult: ScenarioSimulationResult = {
    scenarioId: 'ACTUAL',
    scenarioName: 'Фактический результат',
    entryPrice: actualEntry,
    exitPrice: actualExit,
    pnlPercent: Number(actualPnlPct.toFixed(2)),
    pnlUsdt: Number(((actualPnlPct / 100) * amount).toFixed(2)),
    closeReason: actualCloseReason,
    isWin: actualPnlPct > 0,
    maxFavorableExcursionPct: Math.max(0, actualPnlPct),
    maxAdverseExcursionPct: Math.min(0, actualPnlPct),
    durationMinutes: Math.max(1, Math.round((closeTime - openTime) / 60000)),
    executedOtePullback: false
  };

  // Если свечи недоступны, возвращаем фактический результат для всех сценариев
  if (!candles || candles.length === 0) {
    return {
      tradeId: trade.id || `trade_${Date.now()}`,
      symbol: trade.symbol,
      side,
      patternName: trade.matchedPattern || trade.pattern || 'Квантовый импульс',
      openTime,
      closeTime,
      amount,
      leverage,
      actualResult,
      scenarios: {
        ACTUAL: actualResult,
        OTE_ENTRY: { ...actualResult, scenarioId: 'OTE_ENTRY', scenarioName: 'Вход в зоне OTE (0.618 Fib)' },
        TRAILING_STOP: { ...actualResult, scenarioId: 'TRAILING_STOP', scenarioName: 'Динамический Trailing Stop' },
        PTTP_PROFIT: { ...actualResult, scenarioId: 'PTTP_PROFIT', scenarioName: 'PTTP трейлинг от пика' },
        BREAKEVEN_QUICK: { ...actualResult, scenarioId: 'BREAKEVEN_QUICK', scenarioName: 'Быстрый безубыток (+2%)' }
      },
      bestScenario: 'ACTUAL',
      deltaPnlVsActual: 0,
      recommendedAction: 'Недостаточно минутных данных для ретроспективного перебора'
    };
  }

  // Сценарий 1: OTE Entry (Optimal Trade Entry 0.50-0.618 Fib)
  const oteRes = simulateOteEntryScenario(trade, candles, side, leverage, amount, actualResult);

  // Сценарий 2: Dynamic Trailing Stop (активация при +5%, дистанция 1.5%)
  const trailingRes = simulateTrailingStopScenario(trade, candles, side, leverage, amount, actualEntry, actualResult);

  // Сценарий 3: PTTP (Partial Take Profit Trailing: откат 35% от пика при достижении +12%)
  const pttpRes = simulatePttpScenario(trade, candles, side, leverage, amount, actualEntry, actualResult);

  // Сценарий 4: Quick Breakeven (перенос стопа в +0.3% при достижении +2.0%)
  const breakevenRes = simulateBreakevenScenario(trade, candles, side, leverage, amount, actualEntry, actualResult);

  const scenarios: Record<SimulationScenarioId, ScenarioSimulationResult> = {
    ACTUAL: actualResult,
    OTE_ENTRY: oteRes,
    TRAILING_STOP: trailingRes,
    PTTP_PROFIT: pttpRes,
    BREAKEVEN_QUICK: breakevenRes
  };

  // Поиск лучшего сценария по конечному PnL
  let bestScenario: SimulationScenarioId = 'ACTUAL';
  let bestPnl = actualResult.pnlPercent;

  for (const [sId, res] of Object.entries(scenarios)) {
    if (res.pnlPercent > bestPnl) {
      bestPnl = res.pnlPercent;
      bestScenario = sId as SimulationScenarioId;
    }
  }

  const deltaPnlVsActual = Number((bestPnl - actualResult.pnlPercent).toFixed(2));
  let recommendedAction = 'Фактический сценарий был оптимальным';
  if (bestScenario === 'OTE_ENTRY') {
    recommendedAction = `Лимитный OTE-вход улучшил бы PnL на +${deltaPnlVsActual}% за счет лучшей цены входа`;
  } else if (bestScenario === 'TRAILING_STOP') {
    recommendedAction = `Динамический Trailing Stop зафиксировал бы прибыль на +${deltaPnlVsActual}% выше`;
  } else if (bestScenario === 'PTTP_PROFIT') {
    recommendedAction = `Фиксация PTTP защитила откат от пика, дав преимущество +${deltaPnlVsActual}%`;
  } else if (bestScenario === 'BREAKEVEN_QUICK') {
    recommendedAction = `Ранний перевод в безубыток предотвратил бы просадку (+${deltaPnlVsActual}%)`;
  }

  return {
    tradeId: trade.id || `trade_${Date.now()}`,
    symbol: trade.symbol,
    side,
    patternName: trade.matchedPattern || trade.pattern || 'Квантовый импульс',
    openTime,
    closeTime,
    amount,
    leverage,
    actualResult,
    scenarios,
    bestScenario,
    deltaPnlVsActual,
    recommendedAction
  };
}

/**
 * Симуляция входа по OTE (Optimal Trade Entry)
 */
function simulateOteEntryScenario(
  trade: any,
  candles: Array<[number, number, number, number, number, number]>,
  side: 'LONG' | 'SHORT',
  leverage: number,
  amount: number,
  fallback: ScenarioSimulationResult
): ScenarioSimulationResult {
  const firstCandle = candles[0];
  const refPrice = trade.entryPrice || firstCandle[1];
  
  // Расчет экстремумов для зоны OTE
  const localLow = firstCandle[3];
  const localHigh = firstCandle[2];
  
  const oteCalc = calculateOteEntryZone({
    isSellSignal: side === 'SHORT',
    price: refPrice,
    localLow5m: localLow,
    localHigh5m: localHigh
  });

  const targetOteEntry = oteCalc.isValid ? oteCalc.targetPrice : refPrice;
  let oteFilled = false;
  let filledCandleIdx = 0;

  for (let i = 0; i < Math.min(candles.length, 15); i++) {
    const c = candles[i];
    const cLow = c[3];
    const cHigh = c[2];
    if (side === 'LONG' && cLow <= targetOteEntry) {
      oteFilled = true;
      filledCandleIdx = i;
      break;
    } else if (side === 'SHORT' && cHigh >= targetOteEntry) {
      oteFilled = true;
      filledCandleIdx = i;
      break;
    }
  }

  if (!oteFilled) {
    // Если откат в OTE не произошел в первые 15 минут, используем фактическую цену входа со штрафом за проскальзывание
    return {
      ...fallback,
      scenarioId: 'OTE_ENTRY',
      scenarioName: 'Вход в зоне OTE (0.618 Fib)',
      executedOtePullback: false
    };
  }

  // Расчет результата от цены OTE до цены выхода фактической сделки
  const exitPrice = fallback.exitPrice;
  const pnlPct = side === 'LONG'
    ? ((exitPrice - targetOteEntry) / targetOteEntry) * leverage * 100
    : ((targetOteEntry - exitPrice) / targetOteEntry) * leverage * 100;

  return {
    scenarioId: 'OTE_ENTRY',
    scenarioName: 'Вход в зоне OTE (0.618 Fib)',
    entryPrice: Number(targetOteEntry.toFixed(5)),
    exitPrice,
    pnlPercent: Number(pnlPct.toFixed(2)),
    pnlUsdt: Number(((pnlPct / 100) * amount).toFixed(2)),
    closeReason: `OTE-вход исполнен на ${filledCandleIdx}m от начала; закрыт по ${fallback.closeReason}`,
    isWin: pnlPct > 0,
    maxFavorableExcursionPct: Math.max(0, pnlPct),
    maxAdverseExcursionPct: Math.min(0, pnlPct),
    durationMinutes: Math.max(1, fallback.durationMinutes - filledCandleIdx),
    executedOtePullback: true
  };
}

/**
 * Симуляция Trailing Stop (активация при +5% прибыли, дистанция 1.5%)
 */
function simulateTrailingStopScenario(
  trade: any,
  candles: Array<[number, number, number, number, number, number]>,
  side: 'LONG' | 'SHORT',
  leverage: number,
  amount: number,
  entryPrice: number,
  fallback: ScenarioSimulationResult
): ScenarioSimulationResult {
  let highestPnlPct = 0;
  let trailingActive = false;
  let exitPrice = fallback.exitPrice;
  let exitPnlPct = fallback.pnlPercent;
  let closeReason = fallback.closeReason;
  let duration = fallback.durationMinutes;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c[2];
    const low = c[3];
    const close = c[4];

    const currentPnlHigh = side === 'LONG'
      ? ((high - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - low) / entryPrice) * leverage * 100;

    const currentPnlLow = side === 'LONG'
      ? ((low - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - high) / entryPrice) * leverage * 100;

    if (currentPnlHigh > highestPnlPct) {
      highestPnlPct = currentPnlHigh;
    }

    if (highestPnlPct >= 5.0) {
      trailingActive = true;
    }

    if (trailingActive) {
      const dropFromPeak = highestPnlPct - currentPnlLow;
      if (dropFromPeak >= 1.5) {
        exitPnlPct = highestPnlPct - 1.5;
        exitPrice = side === 'LONG'
          ? entryPrice * (1 + (exitPnlPct / (leverage * 100)))
          : entryPrice * (1 - (exitPnlPct / (leverage * 100)));
        closeReason = `Trailing Stop Hit (-1.5% от пика +${highestPnlPct.toFixed(1)}%)`;
        duration = i + 1;
        break;
      }
    }
  }

  return {
    scenarioId: 'TRAILING_STOP',
    scenarioName: 'Динамический Trailing Stop',
    entryPrice,
    exitPrice: Number(exitPrice.toFixed(5)),
    pnlPercent: Number(exitPnlPct.toFixed(2)),
    pnlUsdt: Number(((exitPnlPct / 100) * amount).toFixed(2)),
    closeReason,
    isWin: exitPnlPct > 0,
    maxFavorableExcursionPct: Number(highestPnlPct.toFixed(2)),
    maxAdverseExcursionPct: Math.min(0, fallback.maxAdverseExcursionPct),
    durationMinutes: duration,
    executedOtePullback: false
  };
}

/**
 * Симуляция PTTP (Partial Take Profit Trailing)
 */
function simulatePttpScenario(
  trade: any,
  candles: Array<[number, number, number, number, number, number]>,
  side: 'LONG' | 'SHORT',
  leverage: number,
  amount: number,
  entryPrice: number,
  fallback: ScenarioSimulationResult
): ScenarioSimulationResult {
  let highestPnlPct = 0;
  let pttpTriggered = false;
  let exitPrice = fallback.exitPrice;
  let exitPnlPct = fallback.pnlPercent;
  let closeReason = fallback.closeReason;
  let duration = fallback.durationMinutes;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c[2];
    const low = c[3];

    const currentPnlHigh = side === 'LONG'
      ? ((high - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - low) / entryPrice) * leverage * 100;

    const currentPnlLow = side === 'LONG'
      ? ((low - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - high) / entryPrice) * leverage * 100;

    if (currentPnlHigh > highestPnlPct) {
      highestPnlPct = currentPnlHigh;
    }

    if (highestPnlPct >= 12.0) {
      pttpTriggered = true;
    }

    if (pttpTriggered) {
      const allowedGiveback = highestPnlPct * 0.35; // 35% откат от пика
      const currentGiveback = highestPnlPct - currentPnlLow;
      if (currentGiveback >= allowedGiveback) {
        exitPnlPct = highestPnlPct - allowedGiveback;
        exitPrice = side === 'LONG'
          ? entryPrice * (1 + (exitPnlPct / (leverage * 100)))
          : entryPrice * (1 - (exitPnlPct / (leverage * 100)));
        closeReason = `PTTP Trailing Lock (зафиксировано +${exitPnlPct.toFixed(1)}% после пика +${highestPnlPct.toFixed(1)}%)`;
        duration = i + 1;
        break;
      }
    }
  }

  return {
    scenarioId: 'PTTP_PROFIT',
    scenarioName: 'PTTP трейлинг от пика',
    entryPrice,
    exitPrice: Number(exitPrice.toFixed(5)),
    pnlPercent: Number(exitPnlPct.toFixed(2)),
    pnlUsdt: Number(((exitPnlPct / 100) * amount).toFixed(2)),
    closeReason,
    isWin: exitPnlPct > 0,
    maxFavorableExcursionPct: Number(highestPnlPct.toFixed(2)),
    maxAdverseExcursionPct: Math.min(0, fallback.maxAdverseExcursionPct),
    durationMinutes: duration,
    executedOtePullback: false
  };
}

/**
 * Симуляция быстрого безубытка (+0.3% при достижении +2.0%)
 */
function simulateBreakevenScenario(
  trade: any,
  candles: Array<[number, number, number, number, number, number]>,
  side: 'LONG' | 'SHORT',
  leverage: number,
  amount: number,
  entryPrice: number,
  fallback: ScenarioSimulationResult
): ScenarioSimulationResult {
  let reachedThreshold = false;
  let exitPrice = fallback.exitPrice;
  let exitPnlPct = fallback.pnlPercent;
  let closeReason = fallback.closeReason;
  let duration = fallback.durationMinutes;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c[2];
    const low = c[3];

    const currentPnlHigh = side === 'LONG'
      ? ((high - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - low) / entryPrice) * leverage * 100;

    const currentPnlLow = side === 'LONG'
      ? ((low - entryPrice) / entryPrice) * leverage * 100
      : ((entryPrice - high) / entryPrice) * leverage * 100;

    if (currentPnlHigh >= 2.0) {
      reachedThreshold = true;
    }

    if (reachedThreshold && currentPnlLow <= 0.3) {
      exitPnlPct = 0.3;
      exitPrice = side === 'LONG'
        ? entryPrice * (1 + (0.3 / (leverage * 100)))
        : entryPrice * (1 - (0.3 / (leverage * 100)));
      closeReason = 'Quick Breakeven Stop (+0.3% гарантированный безубыток)';
      duration = i + 1;
      break;
    }
  }

  return {
    scenarioId: 'BREAKEVEN_QUICK',
    scenarioName: 'Быстрый безубыток (+2%)',
    entryPrice,
    exitPrice: Number(exitPrice.toFixed(5)),
    pnlPercent: Number(exitPnlPct.toFixed(2)),
    pnlUsdt: Number(((exitPnlPct / 100) * amount).toFixed(2)),
    closeReason,
    isWin: exitPnlPct > 0,
    maxFavorableExcursionPct: Math.max(0, fallback.maxFavorableExcursionPct),
    maxAdverseExcursionPct: Math.min(0, fallback.maxAdverseExcursionPct),
    durationMinutes: duration,
    executedOtePullback: false
  };
}

/**
 * Прогоняет пакет исторических сделок через Машину Времени и формирует сводный аналитический отчёт.
 */
export function runTimeMachineBatch(
  trades: any[],
  ohlcvMap: Record<string, Array<[number, number, number, number, number, number]>> = {}
): { analyses: TradeTimeMachineAnalysis[]; summary: TimeMachineBatchSummary } {
  const closedTrades = (trades || []).filter(t => t && t.status === 'CLOSED');
  const analyses: TradeTimeMachineAnalysis[] = [];

  const counts: Record<SimulationScenarioId, number> = {
    ACTUAL: 0,
    OTE_ENTRY: 0,
    TRAILING_STOP: 0,
    PTTP_PROFIT: 0,
    BREAKEVEN_QUICK: 0
  };

  const pnlSums: Record<SimulationScenarioId, number> = {
    ACTUAL: 0,
    OTE_ENTRY: 0,
    TRAILING_STOP: 0,
    PTTP_PROFIT: 0,
    BREAKEVEN_QUICK: 0
  };

  const winCounts: Record<SimulationScenarioId, number> = {
    ACTUAL: 0,
    OTE_ENTRY: 0,
    TRAILING_STOP: 0,
    PTTP_PROFIT: 0,
    BREAKEVEN_QUICK: 0
  };

  const patternStats: Record<string, { total: number; scenarioWins: Record<SimulationScenarioId, number>; pnlDeltaSum: number }> = {};

  for (const trade of closedTrades) {
    const cleanSym = (trade.symbol || '').replace(/[\/:]/g, '').toUpperCase();
    const candles = ohlcvMap[cleanSym] || ohlcvMap[trade.symbol] || [];
    const analysis = simulateTradeAlternatives(trade, candles);
    analyses.push(analysis);

    counts[analysis.bestScenario] = (counts[analysis.bestScenario] || 0) + 1;

    for (const [sId, res] of Object.entries(analysis.scenarios)) {
      const scenarioId = sId as SimulationScenarioId;
      pnlSums[scenarioId] = (pnlSums[scenarioId] || 0) + res.pnlPercent;
      if (res.isWin) {
        winCounts[scenarioId] = (winCounts[scenarioId] || 0) + 1;
      }
    }

    const pat = analysis.patternName;
    if (!patternStats[pat]) {
      patternStats[pat] = {
        total: 0,
        scenarioWins: { ACTUAL: 0, OTE_ENTRY: 0, TRAILING_STOP: 0, PTTP_PROFIT: 0, BREAKEVEN_QUICK: 0 },
        pnlDeltaSum: 0
      };
    }
    patternStats[pat].total += 1;
    patternStats[pat].scenarioWins[analysis.bestScenario] = (patternStats[pat].scenarioWins[analysis.bestScenario] || 0) + 1;
    patternStats[pat].pnlDeltaSum += analysis.deltaPnlVsActual;
  }

  const total = closedTrades.length || 1;
  const actualPnl = pnlSums.ACTUAL;

  const scenarioSummaries: Record<SimulationScenarioId, any> = {
    ACTUAL: {
      totalPnlPct: Number(pnlSums.ACTUAL.toFixed(2)),
      winRate: Number(((winCounts.ACTUAL / total) * 100).toFixed(1)),
      deltaPnlVsActualPct: 0,
      bestScenarioTradeCount: counts.ACTUAL
    },
    OTE_ENTRY: {
      totalPnlPct: Number(pnlSums.OTE_ENTRY.toFixed(2)),
      winRate: Number(((winCounts.OTE_ENTRY / total) * 100).toFixed(1)),
      deltaPnlVsActualPct: Number((pnlSums.OTE_ENTRY - actualPnl).toFixed(2)),
      bestScenarioTradeCount: counts.OTE_ENTRY
    },
    TRAILING_STOP: {
      totalPnlPct: Number(pnlSums.TRAILING_STOP.toFixed(2)),
      winRate: Number(((winCounts.TRAILING_STOP / total) * 100).toFixed(1)),
      deltaPnlVsActualPct: Number((pnlSums.TRAILING_STOP - actualPnl).toFixed(2)),
      bestScenarioTradeCount: counts.TRAILING_STOP
    },
    PTTP_PROFIT: {
      totalPnlPct: Number(pnlSums.PTTP_PROFIT.toFixed(2)),
      winRate: Number(((winCounts.PTTP_PROFIT / total) * 100).toFixed(1)),
      deltaPnlVsActualPct: Number((pnlSums.PTTP_PROFIT - actualPnl).toFixed(2)),
      bestScenarioTradeCount: counts.PTTP_PROFIT
    },
    BREAKEVEN_QUICK: {
      totalPnlPct: Number(pnlSums.BREAKEVEN_QUICK.toFixed(2)),
      winRate: Number(((winCounts.BREAKEVEN_QUICK / total) * 100).toFixed(1)),
      deltaPnlVsActualPct: Number((pnlSums.BREAKEVEN_QUICK - actualPnl).toFixed(2)),
      bestScenarioTradeCount: counts.BREAKEVEN_QUICK
    }
  };

  // Определение абсолютного лучшего сценария по общему PnL
  let overallBestScenario: SimulationScenarioId = 'ACTUAL';
  let maxPnl = scenarioSummaries.ACTUAL.totalPnlPct;
  for (const [sId, data] of Object.entries(scenarioSummaries)) {
    if (data.totalPnlPct > maxPnl) {
      maxPnl = data.totalPnlPct;
      overallBestScenario = sId as SimulationScenarioId;
    }
  }

  // Генерация ключевых уроков для адаптивного самообучения
  const topAdaptiveLessons: Array<{
    patternName: string;
    bestScenario: SimulationScenarioId;
    advantagePct: number;
    sampleSize: number;
    recommendation: string;
  }> = [];

  for (const [pat, stat] of Object.entries(patternStats)) {
    if (stat.total < 2) continue; // Минимум 2 сделки для статистической значимости
    let topScenarioForPat: SimulationScenarioId = 'ACTUAL';
    let topWins = 0;
    for (const [sId, wCount] of Object.entries(stat.scenarioWins)) {
      if (wCount > topWins) {
        topWins = wCount;
        topScenarioForPat = sId as SimulationScenarioId;
      }
    }
    const avgDelta = stat.pnlDeltaSum / stat.total;
    let rec = `Для паттерна "${pat}" фактическое сопровождение стабильно`;
    if (topScenarioForPat === 'OTE_ENTRY') {
      rec = `Для паттерна "${pat}" вход лимитным ордером по OTE 0.618 Fib дает +${avgDelta.toFixed(1)}% PnL`;
    } else if (topScenarioForPat === 'TRAILING_STOP') {
      rec = `Для паттерна "${pat}" перевод в Trailing Stop после +5% защищает пиковую прибыль`;
    } else if (topScenarioForPat === 'PTTP_PROFIT') {
      rec = `Для паттерна "${pat}" стратегия PTTP позволяет высидеть длинные движения`;
    } else if (topScenarioForPat === 'BREAKEVEN_QUICK') {
      rec = `Для паттерна "${pat}" быстрый перевод в БУ при +2% отсекает ложные развороты`;
    }

    topAdaptiveLessons.push({
      patternName: pat,
      bestScenario: topScenarioForPat,
      advantagePct: Number(avgDelta.toFixed(1)),
      sampleSize: stat.total,
      recommendation: rec
    });
  }

  topAdaptiveLessons.sort((a, b) => b.advantagePct - a.advantagePct);

  const summary: TimeMachineBatchSummary = {
    totalAnalyzedTrades: closedTrades.length,
    actualTotalPnlPct: scenarioSummaries.ACTUAL.totalPnlPct,
    actualWinRate: scenarioSummaries.ACTUAL.winRate,
    scenarioSummaries,
    overallBestScenario,
    topAdaptiveLessons: topAdaptiveLessons.slice(0, 10),
    simulatedAt: Date.now()
  };

  return {
    analyses,
    summary
  };
}
