import type { CloseReasonCode } from './tradeSchema.ts';

export type ExitActionKind = 'HOLD' | 'MOVE_STOP' | 'PARTIAL_CLOSE' | 'FULL_CLOSE' | 'EMERGENCY_FULL_CLOSE';
export type ExitDecisionKind = ExitActionKind;

export interface ExitTradeSnapshot {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice?: number;
  highestPrice?: number;
  lowestPrice?: number;
  amount: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  tpStages?: Array<{ targetPrice?: number; targetPnlPct?: number; closeRatio: number; executed?: boolean }>;
  pnl?: number;
  pnlPercent?: number;
  createdAt: number;
  isManual?: boolean;
  manualCloseRequested?: boolean;
  partialTpStepsDone?: number[];
}

export interface ExitMarketSnapshot {
  currentPrice: number;
  bid: number;
  ask: number;
  vwap?: number;
  sar?: number;
  fundingFeeUsdt?: number;
  estimatedFeePct?: number; // e.g. 0.0006 = 0.06%
  estimatedSlippagePct?: number; // e.g. 0.0004 = 0.04%
  currentTime?: number;
}

export interface ExitPolicySettings {
  enablePttp?: boolean;                 // Default true
  enableTimeLimitExit?: boolean;        // Default true
  minNormalAutoCloseNetPnlPct?: number; // Default 4.0%
  minPttpActivationNetPnlPct?: number;  // Default 4.0%
  minPttpPeakNetPnlPct?: number;        // Default 6.0%
  pttpTrailingDropPct?: number;         // Default 25.0% (i.e. give back 25% of peak profit)
  maxLifetimeHours?: number;            // Default 24 hours
  allowEmergencyMaxLifetime?: boolean;  // Default false; when false, MAX_LIFETIME requires net PnL >= floor or returns HOLD
  timeoutProfitHours?: number;          // Default 12 hours
  minTimeoutProfitNetPnlPct?: number;   // Default 4.0%
  enableMultiTp?: boolean;
  bypassProfitFloorForPrimaryTp?: boolean; // Default false (enforces minNormalAutoCloseNetPnlPct on TP)
  bypassProfitFloorForMultiTp?: boolean; // Default false (enforces minNormalAutoCloseNetPnlPct on Multi-TP)
  multiTpTargets?: Array<{ targetPnlPct?: number; targetPrice?: number; closeRatio: number; executed?: boolean }>; // e.g. [{targetPnlPct: 8, closeRatio: 0.5}]
  trailingStopTriggerPnlPct?: number;   // Default 5.0%
  trailingStopDistancePct?: number;      // Default 1.5%
  enableTrailingStop?: boolean;
  enableStagnationTimeout?: boolean;     // Default false; when true, closes trades that have stalled in flat/loss
  timeoutStagnationHours?: number;       // Default 3.5 hours
  maxStagnationPnlPct?: number;          // Default 1.0% (PnL threshold below which trade is considered stagnant)
}

export interface ExitDecision {
  kind: ExitDecisionKind;
  action?: ExitActionKind; // Direct alias for ergonomic compatibility
  reasonCode: CloseReasonCode;
  reasonText: string;
  newStopLoss?: number;
  closeRatio?: number;
  stageIndex?: number;
  peakNetPnlPct: number;
  currentNetPnlPct: number;
  diagnostics: Record<string, any>;
}

/**
 * Calculates net PnL percent taking leverage, fees, and estimated slippage into account.
 */
export function calculateNetPnlPct(
  trade: ExitTradeSnapshot,
  market: ExitMarketSnapshot
): { grossPnlPct: number; netPnlPct: number; peakNetPnlPct: number } {
  const entry = trade.entryPrice;
  const current = market.currentPrice;
  const leverage = trade.leverage || 1;

  if (entry <= 0 || current <= 0) {
    return { grossPnlPct: 0, netPnlPct: 0, peakNetPnlPct: 0 };
  }

  let priceChangeRatio = (current - entry) / entry;
  if (trade.side === 'SHORT') {
    priceChangeRatio = (entry - current) / entry;
  }

  const grossPnlPct = priceChangeRatio * leverage * 100;

  const totalFeePct = ((market.estimatedFeePct || 0.0006) * 2 + (market.estimatedSlippagePct || 0.0004)) * leverage * 100;
  const netPnlPct = grossPnlPct - totalFeePct;

  // Calculate peak net PnL
  let peakPrice = trade.highestPrice || current;
  if (trade.side === 'SHORT') {
    peakPrice = trade.lowestPrice || current;
  }

  let peakPriceChangeRatio = (peakPrice - entry) / entry;
  if (trade.side === 'SHORT') {
    peakPriceChangeRatio = (entry - peakPrice) / entry;
  }
  const peakGrossPnlPct = Math.max(grossPnlPct, peakPriceChangeRatio * leverage * 100);
  const peakNetPnlPct = Math.max(netPnlPct, peakGrossPnlPct - totalFeePct);

  return { grossPnlPct, netPnlPct, peakNetPnlPct };
}

/**
 * Deterministic Exit Policy Evaluator (Canonical Single Source of Truth for Exits)
 */
export function evaluateExitPolicy(
  trade: ExitTradeSnapshot,
  market: ExitMarketSnapshot,
  settings: ExitPolicySettings = {}
): ExitDecision {
  const result = _evaluateExitPolicyInternal(trade, market, settings);
  return {
    ...result,
    action: result.kind
  };
}

function _evaluateExitPolicyInternal(
  trade: ExitTradeSnapshot,
  market: ExitMarketSnapshot,
  settings: ExitPolicySettings = {}
): ExitDecision {
  const currentTime = market.currentTime || Date.now();
  const { grossPnlPct, netPnlPct, peakNetPnlPct } = calculateNetPnlPct(trade, market);

  const minNormalAutoCloseThreshold = settings.minNormalAutoCloseNetPnlPct ?? 4.0;
  const minPttpActivation = settings.minPttpActivationNetPnlPct ?? 12.0;
  const minPttpPeak = settings.minPttpPeakNetPnlPct ?? 18.0;
  const pttpDropPct = settings.pttpTrailingDropPct ?? 35.0; // % drop from peak
  const maxLifetimeMs = (settings.maxLifetimeHours ?? 24) * 3600 * 1000;
  const timeoutProfitMs = (settings.timeoutProfitHours ?? 18) * 3600 * 1000;

  const tradeAgeMs = currentTime - trade.createdAt;

  const diagnostics: Record<string, any> = {
    grossPnlPct: Number(grossPnlPct.toFixed(2)),
    netPnlPct: Number(netPnlPct.toFixed(2)),
    peakNetPnlPct: Number(peakNetPnlPct.toFixed(2)),
    tradeAgeHours: Number((tradeAgeMs / (3600 * 1000)).toFixed(2)),
    minNormalAutoCloseThreshold
  };

  // PRIORITY 1: Manual / User Request
  if (trade.manualCloseRequested || trade.isManual) {
    return {
      kind: 'FULL_CLOSE',
      reasonCode: 'MANUAL',
      reasonText: 'Ручное закрытие по запросу пользователя',
      peakNetPnlPct,
      currentNetPnlPct: netPnlPct,
      diagnostics
    };
  }

  // PRIORITY 2: Validated Hard Stop Loss (SL)
  if (trade.stopLoss && trade.stopLoss > 0) {
    const isSlHit = trade.side === 'LONG'
      ? market.currentPrice <= trade.stopLoss
      : market.currentPrice >= trade.stopLoss;

    if (isSlHit) {
      return {
        kind: 'FULL_CLOSE',
        reasonCode: 'STOP_LOSS',
        reasonText: `Сработал стоп-лосс на уровне $${trade.stopLoss} (PnL: ${netPnlPct.toFixed(2)}%)`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    }
  }

  // PRIORITY 3: Emergency Hard Stop / Liquidation Risk
  if (netPnlPct <= -18.0) {
    return {
      kind: 'EMERGENCY_FULL_CLOSE',
      reasonCode: 'EMERGENCY_HARD_STOP',
      reasonText: `Экстренная защита от ликвидации (PnL: ${netPnlPct.toFixed(2)}% <= -18%)`,
      peakNetPnlPct,
      currentNetPnlPct: netPnlPct,
      diagnostics
    };
  }

  // PRIORITY 4: Primary Take Profit (TP) - Constrained by profit floor
  if (trade.takeProfit && trade.takeProfit > 0) {
    const isTpHit = trade.side === 'LONG'
      ? market.currentPrice >= trade.takeProfit
      : market.currentPrice <= trade.takeProfit;

    if (isTpHit) {
      if (netPnlPct >= minNormalAutoCloseThreshold || settings.bypassProfitFloorForPrimaryTp === true) {
        diagnostics.exitClass = 'PROFIT_TAKING';
        return {
          kind: 'FULL_CLOSE',
          reasonCode: 'TAKE_PROFIT',
          reasonText: `Достигнут целевой тейк-профит $${trade.takeProfit} (PnL: +${netPnlPct.toFixed(2)}%)`,
          peakNetPnlPct,
          currentNetPnlPct: netPnlPct,
          diagnostics
        };
      } else {
        diagnostics.tpBlockedByMinPnlThreshold = true;
      }
    }
  }

  // PRIORITY 4b: Multi-TP Partial Exit
  const effectiveMultiTpStages = trade.tpStages || settings.multiTpTargets;
  if ((settings.enableMultiTp || (trade.tpStages && trade.tpStages.length > 0)) && effectiveMultiTpStages && effectiveMultiTpStages.length > 0) {
    const completed = trade.partialTpStepsDone || [];
    for (let i = 0; i < effectiveMultiTpStages.length; i++) {
      const stage = effectiveMultiTpStages[i];
      if (stage.executed || completed.includes(i)) continue;

      let isStageHit = false;
      if (stage.targetPrice && stage.targetPrice > 0) {
        isStageHit = trade.side === 'SHORT'
          ? market.currentPrice <= stage.targetPrice
          : market.currentPrice >= stage.targetPrice;
      } else if (typeof stage.targetPnlPct === 'number') {
        isStageHit = netPnlPct >= stage.targetPnlPct;
      }

      if (isStageHit) {
        if (netPnlPct >= minNormalAutoCloseThreshold || settings.bypassProfitFloorForMultiTp === true) {
          const rawRatio = stage.closeRatio || 0.5;
          const normRatio = rawRatio > 1 ? rawRatio / 100 : rawRatio;

          // If this is final stage with 100% close ratio, or 4th step
          if ((i === effectiveMultiTpStages.length - 1 && normRatio >= 0.99) || (i === 3 && normRatio >= 0.99)) {
            diagnostics.exitClass = 'PROFIT_TAKING';
            return {
              kind: 'FULL_CLOSE',
              reasonCode: 'TAKE_PROFIT',
              reasonText: `Целевой TP${i + 1} достигнут полностью на отметке $${market.currentPrice} (PnL: +${netPnlPct.toFixed(2)}%)`,
              stageIndex: i,
              peakNetPnlPct,
              currentNetPnlPct: netPnlPct,
              diagnostics: { ...diagnostics, tpStepIndex: i }
            };
          }

          // Calculate lock-in Stop Loss price for previous TP steps
          let lockSlPrice: number | undefined;
          if (i === 0) { // TP1: lock +1.0%
            lockSlPrice = trade.side === 'SHORT'
              ? Number((trade.entryPrice * 0.990).toFixed(5))
              : Number((trade.entryPrice * 1.010).toFixed(5));
          } else if (i === 1) { // TP2: lock +3.0%
            lockSlPrice = trade.side === 'SHORT'
              ? Number((trade.entryPrice * 0.970).toFixed(5))
              : Number((trade.entryPrice * 1.030).toFixed(5));
          } else if (i === 2) { // TP3: lock +5.0%
            lockSlPrice = trade.side === 'SHORT'
              ? Number((trade.entryPrice * 0.950).toFixed(5))
              : Number((trade.entryPrice * 1.050).toFixed(5));
          }

          diagnostics.exitClass = 'PROFIT_TAKING';
          return {
            kind: 'PARTIAL_CLOSE',
            reasonCode: 'MULTI_TP_PARTIAL',
            reasonText: `Частичный фикс прибыли Multi-TP Step #${i + 1} (${(normRatio * 100).toFixed(0)}%) на отметке $${market.currentPrice}`,
            closeRatio: normRatio,
            stageIndex: i,
            newStopLoss: lockSlPrice,
            peakNetPnlPct,
            currentNetPnlPct: netPnlPct,
            diagnostics: { ...diagnostics, tpStepIndex: i }
          };
        } else {
          diagnostics.multiTpBlockedByMinPnlThreshold = true;
        }
      }
    }
  }

  // PRIORITY 5: Peak-To-Trough Protection (PTTP)
  if (peakNetPnlPct >= minPttpPeak && netPnlPct >= minPttpActivation) {
    const profitGaveBackPct = ((peakNetPnlPct - netPnlPct) / peakNetPnlPct) * 100;
    diagnostics.profitGaveBackPct = Number(profitGaveBackPct.toFixed(2));

    if (profitGaveBackPct >= pttpDropPct) {
      if (netPnlPct >= minNormalAutoCloseThreshold) {
        return {
          kind: 'FULL_CLOSE',
          reasonCode: 'PTTP',
          reasonText: `Защита пиковой прибыли PTTP: сброс ${profitGaveBackPct.toFixed(1)}% от пика +${peakNetPnlPct.toFixed(2)}% (Текущий PnL: +${netPnlPct.toFixed(2)}%)`,
          peakNetPnlPct,
          currentNetPnlPct: netPnlPct,
          diagnostics
        };
      } else {
        diagnostics.pttpBlockedByMinPnlThreshold = true;
      }
    }
  }

  // PRIORITY 6: Time-based Scalping Stagnation Timeout Exit
  const enableStagnation = settings.enableStagnationTimeout ?? false;
  const timeoutStagnationHours = settings.timeoutStagnationHours ?? 8.0;
  const timeoutStagnationMs = timeoutStagnationHours * 3600 * 1000;
  const maxStagnationPnl = settings.maxStagnationPnlPct ?? 0.5;

  if (enableStagnation && tradeAgeMs >= timeoutStagnationMs) {
    // ЛЕГАСИ-ЛОГИКА: ранее требовалось (netPnlPct <= maxStagnationPnl && peakNetPnlPct < 3.5), что блокировало закрытие
    // зависших сделок, если они в первый час имели кратковременный всплеск, но затем часами стагнировали в боковике около нуля.
    // Позиция, удерживаемая в боковике без развития импульса (netPnlPct <= maxStagnationPnl), закрывается по тайм-стопу для освобождения слота.
    if (netPnlPct <= maxStagnationPnl) {
      diagnostics.exitClass = 'STAGNATION_TIMEOUT';
      return {
        kind: 'FULL_CLOSE',
        reasonCode: 'TIMEOUT_SAFETY',
        reasonText: `Тайм-стоп скальпинга: позиция в боковике ${(tradeAgeMs / 3600000).toFixed(1)}ч (PnL: ${netPnlPct > 0 ? '+' : ''}${netPnlPct.toFixed(2)}%). Слот освобожден для новых импульсов.`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    }
  }

  // PRIORITY 7: Protective Trailing Stop Adjustment / Exit
  const trailingTriggerPnl = settings.trailingStopTriggerPnlPct ?? 14.0;
  const trailingDistancePct = settings.trailingStopDistancePct ?? 3.0;

  if (peakNetPnlPct >= trailingTriggerPnl) {
    const calcTrailPrice = trade.side === 'LONG'
      ? (trade.highestPrice || market.currentPrice) * (1 - trailingDistancePct / 100)
      : (trade.lowestPrice || market.currentPrice) * (1 + trailingDistancePct / 100);

    // If current market price breached through the trailing stop level:
    const isTrailBreached = trade.side === 'LONG'
      ? market.currentPrice <= calcTrailPrice
      : market.currentPrice >= calcTrailPrice;

    if (isTrailBreached) {
      diagnostics.exitClass = 'TRAILING_STOP_HIT';
      return {
        kind: 'FULL_CLOSE',
        reasonCode: 'TRAILING_STOP',
        reasonText: `Сработал скользящий трейлинг-стоп на отметке $${market.currentPrice} (пик: +${peakNetPnlPct.toFixed(2)}%, трейлинг: $${calcTrailPrice.toFixed(5)})`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    }

    // If current stop loss is below/above trailing stop, update stop loss
    if (!trade.stopLoss || (trade.side === 'LONG' && calcTrailPrice > trade.stopLoss) || (trade.side === 'SHORT' && calcTrailPrice < trade.stopLoss)) {
      diagnostics.trailingStopPrice = Number(calcTrailPrice.toFixed(5));
      return {
        kind: 'MOVE_STOP',
        reasonCode: 'TRAILING_STOP',
        reasonText: `Перенос трейлинг стопа на $${calcTrailPrice.toFixed(5)} при пике +${peakNetPnlPct.toFixed(2)}%`,
        newStopLoss: Number(calcTrailPrice.toFixed(5)),
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    }
  }

  // PRIORITY 8: Lifetime Exits (Timeout Profit & Max Lifetime)

  if (tradeAgeMs >= maxLifetimeMs) {
    if (netPnlPct >= minNormalAutoCloseThreshold) {
      diagnostics.exitClass = 'NORMAL_TIME_EXIT';
      return {
        kind: 'FULL_CLOSE',
        reasonCode: 'MAX_LIFETIME',
        reasonText: `Превышено максимальное время удержания позиции (${(tradeAgeMs / 3600000).toFixed(1)}ч >= ${settings.maxLifetimeHours || 24}ч, PnL: +${netPnlPct.toFixed(2)}%)`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    } else if (settings.allowEmergencyMaxLifetime === true) {
      diagnostics.exitClass = 'LIVENESS_OVERRIDE';
      return {
        kind: 'EMERGENCY_FULL_CLOSE',
        reasonCode: 'EMERGENCY_MAX_LIFETIME',
        reasonText: `Превышено максимальное время удержания позиции (Экстренный сброс: ${(tradeAgeMs / 3600000).toFixed(1)}ч >= ${settings.maxLifetimeHours || 24}ч, PnL: ${netPnlPct.toFixed(2)}%)`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    } else {
      diagnostics.maxLifetimeBlockedByMinPnlThreshold = true;
      return {
        kind: 'HOLD',
        reasonCode: 'UNKNOWN',
        reasonText: `Превышено время удержания (${(tradeAgeMs / 3600000).toFixed(1)}ч), но PnL ${netPnlPct.toFixed(2)}% ниже порога +${minNormalAutoCloseThreshold}%. Удержание позиции (Emergency Max Lifetime отключен).`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    }
  }

  if (tradeAgeMs >= timeoutProfitMs && netPnlPct >= (settings.minTimeoutProfitNetPnlPct ?? 4.0)) {
    if (netPnlPct >= minNormalAutoCloseThreshold) {
      return {
        kind: 'FULL_CLOSE',
        reasonCode: 'TIMEOUT_PROFIT',
        reasonText: `Таймаут удержания в плюсе: ${(tradeAgeMs / 3600000).toFixed(1)}ч (PnL: +${netPnlPct.toFixed(2)}%)`,
        peakNetPnlPct,
        currentNetPnlPct: netPnlPct,
        diagnostics
      };
    } else {
      diagnostics.timeoutProfitBlockedByMinPnlThreshold = true;
    }
  }

  // PRIORITY 8: DEFAULT HOLD
  return {
    kind: 'HOLD',
    reasonCode: 'UNKNOWN',
    reasonText: 'Позиция удерживается в пределах допустимого риска',
    peakNetPnlPct,
    currentNetPnlPct: netPnlPct,
    diagnostics
  };
}
