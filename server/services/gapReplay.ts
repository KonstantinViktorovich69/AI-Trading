import { evaluateExitPolicy, type ExitPolicySettings } from './exitPolicy.ts';

export const GAP_REPLAY_SL_SLIPPAGE_PCT = 0.05; // 0.05% slippage on Stop Loss during replay

export interface GapReplayEvent {
  type: 'PARTIAL_CLOSE' | 'MOVE_STOP' | 'BREAKEVEN' | 'LADDER' | 'TERMINAL';
  time: number;
  price: number;
  reason?: string;
  stageIndex?: number;
  closeRatio?: number;
  newStopLoss?: number;
  amountClosed?: number;
}

export interface GapReplayTerminal {
  kind: 'STOP_LOSS' | 'TAKE_PROFIT' | 'FULL_CLOSE' | 'EMERGENCY_FULL_CLOSE' | 'TIMEOUT_SAFETY';
  executionPrice: number;
  eventTime: number;
  reason: string;
}

export interface GapReplayResult {
  events: GapReplayEvent[];
  terminal?: GapReplayTerminal;
  stopLossAfter?: number;
  executedStages: number[];
  approximations: string[];
}

/**
 * Replays gap candles to simulate price action during downtime.
 * Pure deterministic function without I/O.
 *
 * Approximations explicitly tracked:
 * - DCA grid orders and temporal timeouts (stagnation hours) are evaluated on live ticks, not replayed here.
 * - Intra-candle ticks are approximated with 2 synthetic ticks: adverse extreme first, then favorable extreme.
 */
export function replayGapOnCandles(
  trade: any,
  candles: any[][],
  tfMs: number,
  exitCfg: ExitPolicySettings,
  nowTs: number
): GapReplayResult {
  const approximations: string[] = [
    'DCA-сетка не моделируется во время replay (оценивается живым тиком)',
    'Временные таймауты стагнации не моделируются во время replay (оцениваются живым тиком)',
    'Внутрисвечные тики синтезируются: сначала неблагоприятный экстремум (Low/High), затем благоприятный'
  ];

  const events: GapReplayEvent[] = [];
  const executedStages: number[] = [];

  if (!candles || !Array.isArray(candles) || candles.length === 0) {
    return { events, executedStages, approximations };
  }

  const isLong = trade.side === 'LONG';
  const startFilterTs = Math.max(trade.gapReplayFrom || 0, trade.openTime || 0);

  // Filter candles where ts + tfMs > startFilterTs (includes partial first candle)
  const relevantCandles = candles.filter((c) => {
    const candleTs = c[0];
    return typeof candleTs === 'number' && candleTs + tfMs > startFilterTs;
  });

  if (relevantCandles.length === 0) {
    return { events, executedStages, approximations };
  }

  // Work with a mutable copy of trade snapshot
  let currentAmount = trade.amount;
  let currentStopLoss = trade.stopLoss;
  let currentTakeProfit = trade.takeProfit;
  let highestPrice = trade.highestPrice ?? trade.entryPrice;
  let lowestPrice = trade.lowestPrice ?? trade.entryPrice;
  let isProtected = trade.isProtected || false;
  let protectionLevel = (trade as any).protectionLevel || 0;
  const leverage = trade.leverage || 1;
  const entryPrice = trade.entryPrice;

  // Clone tpStages if present
  const tpStages = Array.isArray(trade.tpStages)
    ? trade.tpStages.map((s: any) => ({ ...s }))
    : [];

  let terminal: GapReplayTerminal | undefined;

  for (const candle of relevantCandles) {
    if (terminal) break;

    const candleTime = candle[0];
    const open = candle[1];
    const high = candle[2];
    const low = candle[3];
    const close = candle[4];

    // Synthetic ticks:
    // For LONG: adverse extreme is LOW, favorable is HIGH
    // For SHORT: adverse extreme is HIGH, favorable is LOW
    const tick1Price = isLong ? low : high;
    const tick2Price = isLong ? high : low;
    const ticks = [tick1Price, tick2Price];

    for (const tickPrice of ticks) {
      if (typeof tickPrice !== 'number' || tickPrice <= 0) continue;

      // Update extremes
      if (tickPrice > highestPrice) highestPrice = tickPrice;
      if (tickPrice < lowestPrice) lowestPrice = tickPrice;

      // PnL computation as in watchdog: unleveraged * leverage - 0.1 * leverage
      const unleveragedPnl = isLong
        ? ((tickPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - tickPrice) / entryPrice) * 100;
      const leveragedPnl = unleveragedPnl * leverage;
      const netPnl = leveragedPnl - (0.1 * leverage);

      // 1. Raw Stop Loss hit check (without 5s requirement)
      const slHit = currentStopLoss && currentStopLoss > 0 &&
        (isLong ? tickPrice <= currentStopLoss : tickPrice >= currentStopLoss);

      // 2. Raw Take Profit hit check
      const tpHit = currentTakeProfit && currentTakeProfit > 0 &&
        (isLong ? tickPrice >= currentTakeProfit : tickPrice <= currentTakeProfit);

      // If both hit in the same candle/tick, SL triggers first
      if (slHit) {
        // Adverse slippage on SL:
        // LONG SL is executed lower by 0.05%, SHORT SL executed higher by 0.05%
        const executionPrice = isLong
          ? Number((currentStopLoss * (1 - GAP_REPLAY_SL_SLIPPAGE_PCT / 100)).toFixed(5))
          : Number((currentStopLoss * (1 + GAP_REPLAY_SL_SLIPPAGE_PCT / 100)).toFixed(5));

        terminal = {
          kind: 'STOP_LOSS',
          executionPrice,
          eventTime: candleTime,
          reason: `Stop Loss Hit at ${executionPrice} (SL was ${currentStopLoss})`
        };
        events.push({
          type: 'TERMINAL',
          time: candleTime,
          price: executionPrice,
          reason: terminal.reason
        });
        break;
      }

      if (tpHit) {
        terminal = {
          kind: 'TAKE_PROFIT',
          executionPrice: currentTakeProfit,
          eventTime: candleTime,
          reason: `Take Profit Hit at ${currentTakeProfit} (TP was ${currentTakeProfit})`
        };
        events.push({
          type: 'TERMINAL',
          time: candleTime,
          price: currentTakeProfit,
          reason: terminal.reason
        });
        break;
      }

      // 3. Mirror built-in watchdog protections (keep in sync with virtualTradeEngine.ts lines 382-445)
      // Breakeven Guard: unleveraged >= 1.50% or netPnl >= 5.50%
      if ((unleveragedPnl >= 1.50 || netPnl >= 5.50) && !isProtected) {
        const breakevenPrice = isLong
          ? Number((entryPrice * 1.0035).toFixed(5))
          : Number((entryPrice * 0.9965).toFixed(5));

        const shouldUpdateSl = !currentStopLoss || (
          isLong ? breakevenPrice > currentStopLoss : breakevenPrice < currentStopLoss
        );

        if (shouldUpdateSl) {
          currentStopLoss = breakevenPrice;
          isProtected = true;
          events.push({
            type: 'BREAKEVEN',
            time: candleTime,
            price: tickPrice,
            newStopLoss: breakevenPrice,
            reason: 'Breakeven protected'
          });
        }
      }

      // Progressive Trailing Break-Even Ladder
      if (netPnl >= 6.0 && protectionLevel < 1) {
        const lockProfitPrice = isLong
          ? entryPrice * (1 + (2.0 / leverage) / 100)
          : entryPrice * (1 - (2.0 / leverage) / 100);
        currentStopLoss = Number(lockProfitPrice.toFixed(5));
        isProtected = true;
        protectionLevel = 1;
        events.push({
          type: 'LADDER',
          time: candleTime,
          price: tickPrice,
          newStopLoss: currentStopLoss,
          reason: 'Tier 1 (+2% profit protected)'
        });
      } else if (netPnl >= 12.0 && protectionLevel < 2) {
        const lockProfitPrice = isLong
          ? entryPrice * (1 + (5.0 / leverage) / 100)
          : entryPrice * (1 - (5.0 / leverage) / 100);
        currentStopLoss = Number(lockProfitPrice.toFixed(5));
        isProtected = true;
        protectionLevel = 2;
        events.push({
          type: 'LADDER',
          time: candleTime,
          price: tickPrice,
          newStopLoss: currentStopLoss,
          reason: 'Tier 2 (+5% profit protected)'
        });
      }

      // 4. evaluateExitPolicy call
      const exitMarket = {
        currentPrice: tickPrice,
        bid: tickPrice * 0.9995,
        ask: tickPrice * 1.0005,
        currentTime: candleTime
      };

      const tradeSnapshot = {
        id: String(trade.id),
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        currentPrice: tickPrice,
        highestPrice,
        lowestPrice,
        amount: currentAmount,
        leverage,
        stopLoss: currentStopLoss,
        takeProfit: currentTakeProfit,
        tpStages,
        createdAt: trade.openTime || trade.createdAt || candleTime
      };

      const exitDecision = evaluateExitPolicy(tradeSnapshot, exitMarket, exitCfg);

      if (exitDecision.kind === 'FULL_CLOSE' || exitDecision.kind === 'EMERGENCY_FULL_CLOSE') {
        terminal = {
          kind: exitDecision.kind,
          executionPrice: tickPrice,
          eventTime: candleTime,
          reason: exitDecision.reasonText
        };
        events.push({
          type: 'TERMINAL',
          time: candleTime,
          price: tickPrice,
          reason: exitDecision.reasonText
        });
        break;
      } else if (exitDecision.kind === 'PARTIAL_CLOSE') {
        const stageIdx = exitDecision.stageIndex ?? 0;
        const ratioToClose = exitDecision.closeRatio ?? 0.25;
        const closedAmount = Number((currentAmount * ratioToClose).toFixed(2));

        if (stageIdx >= 0 && stageIdx < tpStages.length && !tpStages[stageIdx].executed) {
          tpStages[stageIdx].executed = true;
          executedStages.push(stageIdx);
        }

        currentAmount = Number(Math.max(0, currentAmount - closedAmount).toFixed(2));

        // When a TP stage executes, exitPolicy might propose stopLoss adjustment
        if (exitDecision.newStopLoss) {
          const shouldUpdate = !currentStopLoss || (
            isLong ? exitDecision.newStopLoss > currentStopLoss : exitDecision.newStopLoss < currentStopLoss
          );
          if (shouldUpdate) {
            currentStopLoss = exitDecision.newStopLoss;
          }
        }

        events.push({
          type: 'PARTIAL_CLOSE',
          time: candleTime,
          price: tickPrice,
          stageIndex: stageIdx,
          closeRatio: ratioToClose,
          amountClosed: closedAmount,
          newStopLoss: currentStopLoss,
          reason: exitDecision.reasonText
        });
      } else if (exitDecision.kind === 'MOVE_STOP' && exitDecision.newStopLoss) {
        const shouldUpdate = !currentStopLoss || (
          isLong ? exitDecision.newStopLoss > currentStopLoss : exitDecision.newStopLoss < currentStopLoss
        );
        if (shouldUpdate) {
          currentStopLoss = exitDecision.newStopLoss;
          events.push({
            type: 'MOVE_STOP',
            time: candleTime,
            price: tickPrice,
            newStopLoss: currentStopLoss,
            reason: exitDecision.reasonText
          });
        }
      }
    }
  }

  return {
    events,
    terminal,
    stopLossAfter: currentStopLoss,
    executedStages,
    approximations
  };
}
