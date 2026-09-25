import { evaluateExitPolicy } from './exitPolicy.ts';
import { getUnifiedTradeClosePnl } from '../quant.ts';
import { cleanSymbol, findTickerInMap } from '../utils/symbolUtils.ts';
import { safeJsonParse } from '../utils/jsonRepair.ts';
import { getOtePendingCandidates, processOtePendingQueue } from './oteVirtualQueue.ts';
import { updatePatternBlacklistFromStats } from './signalEngine.ts';

export interface VirtualTradeEngineDependencies {
  getVirtualTrades: () => any[];
  getGlobalSettings: () => any;
  getGlobalCcxtTickers: () => Record<string, any>;
  getWsTickers: () => Record<string, any>;
  getGlobalTrueOhlcv: () => Record<string, any>;
  getGlobalMarketPulse: () => { sentiment: string; bias: number };
  getAiKnowledgeBase: () => any[];
  getVirtualBalance: () => number;
  setVirtualBalance: (val: number) => void;
  getStartOfDayRealBalance: () => number;
  setStartOfDayRealBalance: (val: number) => void;
  getStartOfWeekBalance: () => number;
  setStartOfWeekBalance: (val: number) => void;
  isCircuitBreakerActive: () => boolean;
  triggerCircuitBreaker: (reason: string) => Promise<void>;
  getCcxtClient: (config: any) => any;
  fetchCachedRealBalance: (client: any, type: string, force: boolean, context: string) => Promise<any>;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  saveBalanceDB: () => void;
  saveKnowledgeDB: (rule: any) => void;
  sendTelegramMessage: (text: string) => void;
  emitSignalsUpdated: () => void;
  executeRealCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT') => Promise<any>;
  executeRealPartialCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT', ratio: number) => Promise<any>;
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number) => Promise<any>;
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  runAiGeneration: (params: any) => Promise<{ text?: string }>;
}

let lastWeekCheckTime = 0;
let lastRealDrawdownCheckTime = 0;

/**
 * Core Watchdog & Active Trade Lifecycle Manager
 * Handles:
 * - Trailing Stop / Progressive Break-Even
 * - Canonical Exit Policy (PTTP, Timeouts, Hard Stops)
 * - Real and Paper Position PnL calculation and SL/TP triggering
 * - DCA Averaging Grid execution
 * - AI Knowledge Base continuous self-learning evaluation on trade closure
 */
export async function manageActiveTrades(deps: VirtualTradeEngineDependencies): Promise<void> {
  const virtualTrades = deps.getVirtualTrades();
  const globalSettings = deps.getGlobalSettings();
  const wsTickers = deps.getWsTickers();
  const globalCcxtTickers = deps.getGlobalCcxtTickers();
  const globalTrueOhlcv = deps.getGlobalTrueOhlcv();
  const globalMarketPulse = deps.getGlobalMarketPulse();
  const aiKnowledgeBase = deps.getAiKnowledgeBase();

  const pending = getOtePendingCandidates();
  if (pending.length > 0) {
    const currentPrices: Record<string, number> = {};
    for (const c of pending) {
      const t = findTickerInMap(c.symbol, globalCcxtTickers ? globalCcxtTickers['weex'] : undefined);
      if (t && typeof t.last === 'number') currentPrices[c.symbol] = t.last;
    }
    const result = processOtePendingQueue(currentPrices);
    for (const candidate of result.filled) {
      try {
        if (candidate.context && typeof candidate.context.executeVirtualEntry === 'function') {
          await candidate.context.executeVirtualEntry(currentPrices[candidate.symbol]);
        } else {
          console.log(`[OTE VIRTUAL FILLED] Missing executeVirtualEntry in context for candidate ${candidate.id}`);
        }
      } catch (err: any) {
        console.log(`[OTE VIRTUAL FILLED ERROR] Failed to execute entry for candidate ${candidate.id}:`, err?.message || err);
      }
    }
    for (const candidate of result.timedOut) {
      console.log(`[OTE VIRTUAL TIMEOUT] ${candidate.symbol} ${candidate.id}`);
    }
  }

  let openTradesCache: any[] = [];
  if (typeof virtualTrades !== 'undefined' && Array.isArray(virtualTrades)) {
    openTradesCache = virtualTrades.filter(t => t && t.status === 'OPEN');
  }

  // Weekly check for virtual balance reference
  const currentVirtualBalance = deps.getVirtualBalance();
  if (Date.now() - lastWeekCheckTime >= 7 * 24 * 60 * 60 * 1000) {
    deps.setStartOfWeekBalance(currentVirtualBalance);
    lastWeekCheckTime = Date.now();
    deps.saveBalanceDB();
  }

  // Check real exchange daily drawdown if api is active
  try {
    const config = globalSettings.exchangeApiConfig;
    if (!deps.isCircuitBreakerActive() && config && config.isEnabled && config.apiKey && (Date.now() - lastRealDrawdownCheckTime >= 60000)) {
      lastRealDrawdownCheckTime = Date.now();
      const client = deps.getCcxtClient(config);
      if (client) {
        const defaultType = config.exchange === 'weex' ? 'swap' : 'future';
        const balance = await deps.fetchCachedRealBalance(client, defaultType, false, 'fetchBalance for daily drawdown check').catch(() => null);
        if (balance) {
          const usdt = balance.USDT?.total || 0;
          let startOfDayRealBalance = deps.getStartOfDayRealBalance();
          if (startOfDayRealBalance <= 0) {
            deps.setStartOfDayRealBalance(usdt);
          } else if (usdt > 0) {
            const realDeltaPercent = ((usdt - startOfDayRealBalance) / startOfDayRealBalance) * 100;
            if (realDeltaPercent <= -3.0) {
              await deps.triggerCircuitBreaker(`Real Account Drawdown Limit (-3.0%) breached! Available: ${usdt.toFixed(2)} USDT (Day start: ${startOfDayRealBalance.toFixed(2)} USDT)`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    // Avoid active console spamming
  }

  if (openTradesCache.length === 0) return;
  let hasChanges = false;

  for (const trade of openTradesCache) {
    if (trade.isClosing) continue;

    // External manual exchange positions are never touched
    if (trade.isExternal || trade.isExchangeManual || trade.mode === 'EXTERNAL' || trade.id?.toString().includes('-external')) {
      continue;
    }

    // Grace period: Don't check for closing if trade was opened less than 5s ago
    if (Date.now() - (trade.openTime || 0) < 5000) continue;

    // Periodic synchronization of SL/TP on the real exchange in case of previous network failure
    if (trade.isReal && (!trade.isExchangeSlTpSynced || trade.needsSlTpSync)) {
      const now = Date.now();
      const lastSyncTime = (trade as any).lastSlTpSyncTime || 0;
      if (now - lastSyncTime >= 20000) {
        (trade as any).lastSlTpSyncTime = now;
        console.log(`[WATCHDOG EXCHANGE SL/TP SYNC] Attempting periodic SL/TP sync for ${trade.symbol} (ID: ${trade.id}). SL: ${trade.stopLoss}, TP: ${trade.takeProfit}`);
        deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit)
          .then(success => {
            if (success) {
              trade.isExchangeSlTpSynced = true;
              trade.needsSlTpSync = false;
              deps.saveTradeDB(trade);
              console.log(`[WATCHDOG EXCHANGE SL/TP SYNC] Successfully synced SL/TP for ${trade.symbol}`);
            } else {
              console.log(`[WATCHDOG EXCHANGE SL/TP SYNC] Sync returned false for ${trade.symbol}, will retry.`);
            }
          })
          .catch(err => {
            console.log(`[WATCHDOG EXCHANGE SL/TP SYNC FAILED] for ${trade.symbol}:`, err.message || err);
          });
      }
    }

    const symbol = trade.symbol;
    let currentPrice = 0;

    // 1. WebSocket search
    for (const ex in wsTickers) {
      const t = findTickerInMap(symbol, wsTickers[ex]);
      if (t) {
        currentPrice = t.last || t.bid || t.close || 0;
        if (currentPrice > 0) break;
      }
    }

    // 2. CCXT Cache fallback
    if (currentPrice <= 0) {
      for (const ex in globalCcxtTickers) {
        const t = findTickerInMap(symbol, globalCcxtTickers[ex]);
        if (t) {
          currentPrice = t.last || t.bid || t.close || 0;
          if (currentPrice > 0) break;
        }
      }
    }

    if (currentPrice <= 0) continue;

    // Update trade price in memory
    if (Math.abs(trade.currentPrice - currentPrice) / currentPrice > 0.0001) {
      trade.currentPrice = currentPrice;
      hasChanges = true;
    }

    // Highest/Lowest tracking
    if (!trade.highestPrice || currentPrice > trade.highestPrice) trade.highestPrice = currentPrice;
    if (!trade.lowestPrice || currentPrice < trade.lowestPrice) trade.lowestPrice = currentPrice;

    const unleveragedPnlNow = trade.side === 'SHORT'
      ? ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100
      : ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const leveragedPnlNow = unleveragedPnlNow * trade.leverage;
    const pnlNow = leveragedPnlNow - (0.1 * trade.leverage);

    // --- PROFESSIONAL TRAILING TAKE PROFIT (PTTP) ---
    if ((trade as any).maxReachedUnleveragedPnl === undefined) {
      (trade as any).maxReachedUnleveragedPnl = Math.max(0, unleveragedPnlNow);
    } else if (unleveragedPnlNow > (trade as any).maxReachedUnleveragedPnl) {
      (trade as any).maxReachedUnleveragedPnl = unleveragedPnlNow;
      hasChanges = true;
    }

    const maxUnleveragedReached = (trade as any).maxReachedUnleveragedPnl || 0;
    let shouldClose = false;
    let reason = '';

    // Canonical Deterministic Exit Policy Evaluation
    const canonicalExitDecision = evaluateExitPolicy(
      {
        id: String(trade.id),
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        currentPrice,
        highestPrice: trade.highestPrice,
        lowestPrice: trade.lowestPrice,
        amount: trade.amount,
        leverage: trade.leverage || 1,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        pnl: pnlNow,
        pnlPercent: pnlNow,
        createdAt: trade.openTime || (trade as any).createdAt || Date.now(),
        manualCloseRequested: (trade as any).manualCloseRequested
      },
      {
        currentPrice,
        bid: currentPrice * 0.9995,
        ask: currentPrice * 1.0005,
        currentTime: Date.now()
      },
      {
        minNormalAutoCloseNetPnlPct: 6.0,
        minPttpActivationNetPnlPct: 12.0,
        minPttpPeakNetPnlPct: 18.0,
        pttpTrailingDropPct: 35.0,
        maxLifetimeHours: (globalSettings as any).maxLifetimeHours ?? 24,
        allowEmergencyMaxLifetime: (globalSettings as any).allowEmergencyMaxLifetime ?? true,
        timeoutProfitHours: 18,
        minTimeoutProfitNetPnlPct: 6.0,
        enableStagnationTimeout: true,
        timeoutStagnationHours: (globalSettings as any).timeoutStagnationHours ?? 8.0,
        maxStagnationPnlPct: 0.5,
        enableMultiTp: trade.isMultiTp !== false,
        multiTpTargets: trade.tpStages,
        bypassProfitFloorForMultiTp: true,
        bypassProfitFloorForPrimaryTp: true,
        enableTrailingStop: true,
        trailingStopTriggerPnlPct: 14.0,
        trailingStopDistancePct: 3.0
      }
    );

    if ((canonicalExitDecision.kind === 'FULL_CLOSE' || canonicalExitDecision.kind === 'EMERGENCY_FULL_CLOSE') && !shouldClose) {
      shouldClose = true;
      reason = canonicalExitDecision.reasonText;
      (trade as any).closeReasonCode = canonicalExitDecision.reasonCode;
    } else if (canonicalExitDecision.kind === 'PARTIAL_CLOSE' && !shouldClose) {
      const stageIdx = canonicalExitDecision.stageIndex ?? 0;
      const ratioToClose = canonicalExitDecision.closeRatio ?? 0.25;
      const closedAmount = Number((trade.amount * ratioToClose).toFixed(2));
      let partialClosePrice = currentPrice;
      let realExecuted = true;

      if (trade.isReal) {
        if (globalSettings.isAiPartialCloseRealEnabled !== false) {
          try {
            console.log(`[WATCHDOG MULTI-TP REAL EXE] Partial close of ${ratioToClose * 100}% on exchange for ${trade.symbol}...`);
            const resPc = await deps.executeRealPartialCloseOnExchange(trade.symbol, trade.side, ratioToClose);
            if (resPc && resPc.success && resPc.data) {
              const ord = resPc.data;
              if (ord.average || ord.price) {
                partialClosePrice = ord.average || ord.price;
              }
            }
            console.log(`[WATCHDOG MULTI-TP REAL EXE] Partial close completed. Fill Price: $${partialClosePrice}. Scheduling SL/TP re-sync in 5s...`);
            setTimeout(() => {
              if (trade.stopLoss) {
                trade.isExchangeSlTpSynced = false;
                trade.needsSlTpSync = true;
                deps.saveTradeDB(trade, true);
                deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit)
                  .then(success => {
                    if (success) {
                      trade.isExchangeSlTpSynced = true;
                      trade.needsSlTpSync = false;
                      deps.saveTradeDB(trade, true);
                    }
                  })
                  .catch(err => {
                    console.log('[WATCHDOG MULTI-TP SL RE-SYNC ERR]:', err.message);
                  });
              }
            }, 5000);
          } catch (e: any) {
            console.log(`[WATCHDOG MULTI-TP REAL EXE] Failed to execute partial TP order for ${trade.symbol}:`, e.message || e);
            realExecuted = false;
          }
        } else {
          console.log(`[WATCHDOG MULTI-TP REAL BYPASS] Real partial close for ${trade.symbol} bypassed because isAiPartialCloseRealEnabled is false.`);
          deps.sendTelegramMessage(`🎯 <b>[Настройки] Фиксация Multi-TP пропущена</b>\n\nМонета: <b>${trade.symbol.replace(/[\/:]/g, '')}</b>\nУровень ТР достигнут (${(ratioToClose * 100).toFixed(0)}%), но частичная фиксация отключена в настройках.`);
          realExecuted = false;
        }
      }

      if (!trade.isReal || realExecuted) {
        if (trade.tpStages && trade.tpStages[stageIdx]) {
          trade.tpStages[stageIdx].executed = true;
        }
        trade.amount = Number((trade.amount - closedAmount).toFixed(2));
        if (!trade.history) trade.history = [];
        trade.history.push({ time: Date.now(), type: 'CLOSE' as any, price: partialClosePrice, amount: closedAmount });

        if (canonicalExitDecision.newStopLoss) {
          trade.stopLoss = canonicalExitDecision.newStopLoss;
          trade.isProtected = true;
        }

        if (trade.isReal) {
          deps.sendTelegramMessage(`🎯 <b>Multi-TP Шаг #${stageIdx + 1} Достигнут (закрыто ${(ratioToClose * 100).toFixed(0)}%)!</b>\n\nМонета: <b>${trade.symbol.replace(/[\/:]/g, '')}</b>\nЦена: $${currentPrice.toFixed(5)}\nСЛ перенесен: $${trade.stopLoss?.toFixed(5) || 'N/A'}`);
        }

        await deps.saveTradeDB(trade, true);
        hasChanges = true;
      }
    } else if (canonicalExitDecision.kind === 'MOVE_STOP' && canonicalExitDecision.newStopLoss) {
      trade.stopLoss = canonicalExitDecision.newStopLoss;
      trade.isProtected = true;
      await deps.saveTradeDB(trade, true);
      hasChanges = true;
    }

    if (shouldClose && trade.isReal && reason.startsWith('PTTP')) {
      deps.sendTelegramMessage(`🏆 <b>PTTP: Профессиональная фиксация прибыли!</b>\n\nМонета: <b>${trade.symbol.replace(/[\/:]/g, '')}</b>\nНаправление: <b>${trade.side}</b>\nДвижение цены: <b>+${unleveragedPnlNow.toFixed(2)}%</b> (чистый профит без плеча)\nЗафиксировано прибыли по позиции: <b>+${pnlNow.toFixed(2)}%</b> (с плечом)\nПиковое движение: +${maxUnleveragedReached.toFixed(2)}%\n\n<i>Агент зафиксировал прибыль, защитив доход от разворота рынка!</i>`);
    }

    const unleveragedPnl = (Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

    // Break-Even Trailing after DCA (DCA Break-Even Safeguard: locks break-even when price recovers to average entry)
    if ((trade as any).dcaAveraged && !(trade as any).dcaBreakEvenSet && !shouldClose) {
      const isPriceAtOrAboveEntry = trade.side === 'LONG'
        ? currentPrice >= trade.entryPrice * 0.9998
        : currentPrice <= trade.entryPrice * 1.0002;

      if (isPriceAtOrAboveEntry || pnlNow >= 0.2) {
        const breakevenPrice = trade.side === 'SHORT'
          ? Number((trade.entryPrice * 0.9995).toFixed(5))
          : Number((trade.entryPrice * 1.0005).toFixed(5));
        trade.stopLoss = breakevenPrice;
        trade.isProtected = true;
        (trade as any).dcaBreakEvenSet = true;
        await deps.saveTradeDB(trade, true);
        if (trade.isReal) {
          deps.sendTelegramMessage(`🛡️ <b>[DCA Break-Even Guard] Защита позиции в безубыток</b>\n\nМонета: <b>${trade.symbol}</b>\nУсредненный вход: $${trade.entryPrice}\nНовый SL: $${breakevenPrice}\n<i>Позиция после усреднения защищена в безубыток для исключения повторного падения на увеличенном объеме.</i>`);
          if (deps.setRealTradeSlTpOnExchange) {
            deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit).catch(() => {});
          }
        }
        hasChanges = true;
      }
    }

    // Защита позиции в безубыток: активируется только при чистом импульсе >= +1.2% (или +5% с плечом),
    // давая сделке возможность дышать и не закрываться преждевременно на микро-колебаниях стакана
    if ((unleveragedPnlNow >= 1.20 || pnlNow >= 5.00) && !trade.isProtected && !shouldClose) {
      const breakevenPrice = trade.side === 'SHORT'
        ? Number((trade.entryPrice * 0.9995).toFixed(5))
        : Number((trade.entryPrice * 1.0005).toFixed(5));

      const shouldUpdateSl = !trade.stopLoss || (
        trade.side === 'SHORT' ? breakevenPrice < trade.stopLoss : breakevenPrice > trade.stopLoss
      );

      if (shouldUpdateSl) {
        trade.stopLoss = breakevenPrice;
        trade.isProtected = true;
        deps.saveTradeDB(trade, true);
        if (trade.isReal) {
          deps.sendTelegramMessage(`🛡️ <b>Adaptive Watchdog: Break-even Protected</b>\n\nSymbol: ${trade.symbol}\nProfit: +${pnlNow.toFixed(2)}% (Unleveraged: +${unleveragedPnlNow.toFixed(2)}%)\nNew SL: $${breakevenPrice.toFixed(5)}`);
          if (deps.setRealTradeSlTpOnExchange) {
            deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit).catch(err => {
              console.log('[WATCHDOG BE SL SYNC ERR]:', err.message);
            });
          }
        }
        hasChanges = true;
      }
    }

    // Progressive Trailing Break-Even Ladder
    if (!shouldClose) {
      const currentProtLevel = (trade as any).protectionLevel || 0;
      if (pnlNow >= 6.0 && currentProtLevel < 1) {
        const lockProfitPrice = trade.side === 'SHORT'
          ? trade.entryPrice * (1 - (2.0 / trade.leverage) / 100)
          : trade.entryPrice * (1 + (2.0 / trade.leverage) / 100);
        trade.stopLoss = Number(lockProfitPrice.toFixed(5));
        trade.isProtected = true;
        (trade as any).protectionLevel = 1;
        deps.saveTradeDB(trade, true);
        if (trade.isReal) {
          deps.sendTelegramMessage(`🛡️ <b>[Adaptive Watchdog - Tier 1] Locking Profits</b>\n\nМонета: <b>${trade.symbol}</b>\nПрофит: +${pnlNow.toFixed(2)}%\nНовый SL (Защита +2% прибыли): $${trade.stopLoss.toFixed(5)}`);
          if (deps.setRealTradeSlTpOnExchange) {
            deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit).catch(err => {
              console.log('[WATCHDOG TIER1 SL SYNC ERR]:', err.message);
            });
          }
        }
        hasChanges = true;
      } else if (pnlNow >= 12.0 && currentProtLevel < 2) {
        const lockProfitPrice = trade.side === 'SHORT'
          ? trade.entryPrice * (1 - (5.0 / trade.leverage) / 100)
          : trade.entryPrice * (1 + (5.0 / trade.leverage) / 100);
        trade.stopLoss = Number(lockProfitPrice.toFixed(5));
        trade.isProtected = true;
        (trade as any).protectionLevel = 2;
        deps.saveTradeDB(trade, true);
        if (trade.isReal) {
          deps.sendTelegramMessage(`🛡️ <b>[Adaptive Watchdog - Tier 2] Locking High Profits</b>\n\nМонета: <b>${trade.symbol}</b>\nПрофит: +${pnlNow.toFixed(2)}%\nНовый SL (Защита +5% прибыли): $${trade.stopLoss.toFixed(5)}`);
          if (deps.setRealTradeSlTpOnExchange) {
            deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit).catch(err => {
              console.log('[WATCHDOG TIER2 SL SYNC ERR]:', err.message);
            });
          }
        }
        hasChanges = true;
      }
    }

    // Stop Loss check
    if (trade.stopLoss && trade.stopLoss > 0) {
      let isSlExceeded = false;
      if (trade.side === 'SHORT' && currentPrice >= trade.stopLoss) {
        isSlExceeded = true;
      } else if (trade.side === 'LONG' && currentPrice <= trade.stopLoss) {
        isSlExceeded = true;
      }

      if (isSlExceeded) {
        if (!trade.slViolationSeconds) trade.slViolationSeconds = 0;
        trade.slViolationSeconds++;
        const requiredSeconds = trade.isReal ? 25 : 5;

        if (trade.slViolationSeconds >= requiredSeconds && !shouldClose) {
          shouldClose = true;
          reason = `Stop Loss Hit at ${currentPrice} (SL was ${trade.stopLoss})`;
          (trade as any).closeReasonCode = 'STOP_LOSS';
        }
      } else {
        trade.slViolationSeconds = 0;
      }
    }

    // Take Profit check
    if (trade.takeProfit && trade.takeProfit > 0 && !shouldClose) {
      let isTpExceeded = false;
      if (trade.side === 'SHORT' && currentPrice <= trade.takeProfit) {
        isTpExceeded = true;
      } else if (trade.side === 'LONG' && currentPrice >= trade.takeProfit) {
        isTpExceeded = true;
      }

      if (isTpExceeded) {
        shouldClose = true;
        reason = `Take Profit Hit at ${currentPrice} (TP was ${trade.takeProfit})`;
        (trade as any).closeReasonCode = 'TAKE_PROFIT';
      }
    }

    // Auto-Learning specific closure checks
    if ((trade as any).isAutoLearning && !shouldClose) {
      if (pnlNow >= 150) {
        shouldClose = true;
        reason = `Auto-Learning: Сделка достигла максимальной прибыли (${pnlNow.toFixed(1)}%) и закрыта для анализа.`;
      } else if (pnlNow <= -150) {
        shouldClose = true;
        reason = `Auto-Learning: Сделка показала предельный убыток (${pnlNow.toFixed(1)}%) и закрыта для анализа ошибки.`;
      }
    }

    // Emergency Hard Stop
    const allDcaExecuted = trade.gridOrders && trade.gridOrders.length > 0 && trade.gridOrders.every((grid: any) => grid.executed);
    if (allDcaExecuted && pnlNow <= -35.0 && !shouldClose) {
      shouldClose = true;
      reason = `Emergency Hard Stop: Превышен критический лимит убытка (-35%) после полной отработки сетки усреднения! Позиция принудительно закрыта.`;
      if (trade.isReal) {
        deps.sendTelegramMessage(`💥 <b>Emergency Hard Stop (Аварийный Стоп)!</b>\n\nМонета: <b>${trade.symbol.replace(/[\/:]/g, '')}</b>\nНаправление: <b>${trade.side}</b>\nТекущий убыток: <b>${pnlNow.toFixed(2)}%</b>\n\n<i>Позиция закрыта аварийной системой защиты рисков для предотвращения ликвидации счета!</i>`);
      }
    }

    // Scalping Time-Stop Safeguard: Auto-close positions stagnant in flat/loss > 3.0h
    const tradeCreatedTime = trade.openTime || (trade as any).createdAt || Date.now();
    const tradeAgeHours = (Date.now() - tradeCreatedTime) / (3600 * 1000);
    const configuredStagnationHours = (globalSettings as any).timeoutStagnationHours ?? 3.0;
    // ЛЕГАСИ-ЛОГИКА: ранее условие (maxUnleveragedReached < 1.0) блокировало закрытие сделок, которые имели импульс в первый час, но затем часами зависли в боковике около нуля.
    // Если позиция стагнирует дольше тайм-аута и находится около нуля/в убытке (pnlNow <= 1.0), закрываем для высвобождения торгового слота:
    if (tradeAgeHours >= configuredStagnationHours && pnlNow <= 1.0 && !shouldClose) {
      shouldClose = true;
      reason = `Тайм-стоп скальпинга: позиция в боковике ${tradeAgeHours.toFixed(1)}ч (PnL: ${pnlNow > 0 ? '+' : ''}${pnlNow.toFixed(2)}%). Закрытие для высвобождения торгового слота.`;
      (trade as any).closeReasonCode = 'TIMEOUT_SAFETY';
    }

    // Auto-Average logic (Grid DCA) with Strict Stop-Loss, Cooldown, Margin Cap, and Settings Guards
    const isDcaAllowed = (globalSettings as any)?.isDcaEnabled !== false && ((globalSettings as any)?.dcaMultiplierFactor ?? 1.0) > 0;
    let isPriceInSlZone = false;
    if (trade.stopLoss && trade.stopLoss > 0) {
      if (trade.side === 'SHORT' && currentPrice >= trade.stopLoss * 0.995) {
        isPriceInSlZone = true;
      } else if (trade.side === 'LONG' && currentPrice <= trade.stopLoss * 1.005) {
        isPriceInSlZone = true;
      }
    }

    if (!shouldClose && isDcaAllowed && !isPriceInSlZone && trade.gridOrders && trade.gridOrders.length > 0) {
      const lastActionTime = (trade as any).lastGridTime || 0;
      const cooldownElapsed = lastActionTime === 0 ? true : (Date.now() - lastActionTime) >= 120000;

      if (cooldownElapsed) {
        // Execute strictly AT MOST ONE grid order per watchdog cycle to eliminate multi-order race conditions
        const nextGrid = trade.gridOrders.find((grid: any) => !grid.executed);
        if (nextGrid) {
          const hit = trade.side === 'SHORT' ? currentPrice >= nextGrid.price : currentPrice <= nextGrid.price;
          if (hit) {
            const initialAmount = (trade as any).initialAmount || (trade.history && trade.history[0]?.amount) || trade.amount;
            const maxAllowedAmount = Number((initialAmount * 1.5).toFixed(2));

            if (trade.amount >= maxAllowedAmount) {
              console.log(`[DCA MARGIN CAP] Averaging blocked for ${trade.symbol}: amount $${trade.amount} reached 1.5x cap ($${maxAllowedAmount})`);
              nextGrid.executed = true;
            } else {
              let orderAmount = nextGrid.amount;
              if (trade.amount + orderAmount > maxAllowedAmount) {
                orderAmount = Number((maxAllowedAmount - trade.amount).toFixed(2));
              }

              if (orderAmount < 1.0) {
                console.log(`[DCA MARGIN CAP] Averaging skipped for ${trade.symbol}: remaining margin room < 1.0 USDT`);
                nextGrid.executed = true;
              } else {
                const cleanSym = cleanSymbol(trade.symbol);
                const ohlcvInds = globalTrueOhlcv[cleanSym];
                let isRocketPump = false;

                if (trade.side === 'SHORT' && ohlcvInds) {
                  const rsiExtreme = ohlcvInds.rsi1m >= 88 || ohlcvInds.rsi15m >= 82;
                  const volumeSurge = ohlcvInds.volumeSpike >= 4.0;
                  let fastPriceRun = false;
                  const candles = ohlcvInds.candles1m;
                  if (candles && candles.length >= 3) {
                    const recentCandles = candles.slice(-3);
                    const openPrice = recentCandles[0].open;
                    const currentClose = recentCandles[recentCandles.length - 1].close;
                    const runPct = ((currentClose - openPrice) / openPrice) * 100;
                    if (runPct >= 2.2) fastPriceRun = true;
                  }
                  if (rsiExtreme && (volumeSurge || fastPriceRun)) {
                    isRocketPump = true;
                    console.log(`[SMART DCA PAUSE] Pausing short averaging for ${trade.symbol}. Parabolic rally detected: RSI 1m: ${ohlcvInds.rsi1m}, Surge: ${volumeSurge}, 120s run: ${fastPriceRun}`);
                  }
                }

                if (!isRocketPump) {
                  nextGrid.executed = true;
                  (trade as any).lastGridTime = Date.now();

                  let dcaPrice = nextGrid.price;
                  let executedSuccessfully = true;

                  if (trade.isReal) {
                    try {
                      console.log(`[WATCHDOG REAL DCA] Triggering grid average on exchange for ${trade.symbol}...`);
                      const res = await deps.executeRealOpenOnExchange(trade.symbol, trade.side, orderAmount, trade.leverage);
                      if (res && res.success && res.entryPrice) {
                        dcaPrice = res.entryPrice;
                        console.log(`[WATCHDOG REAL DCA RESULT] Average executed at $${dcaPrice}`);
                      } else {
                        console.log(`[WATCHDOG REAL DCA FAILED] Exchange failed to execute grid order:`, res?.error);
                        executedSuccessfully = false;
                      }
                    } catch (e: any) {
                      console.log(`[WATCHDOG REAL DCA ERROR] Failed to execute DCA for ${trade.symbol}:`, e.message || e);
                      executedSuccessfully = false;
                    }
                  }

                  if (executedSuccessfully) {
                    const oldEntry = trade.entryPrice;
                    const oldAmount = trade.amount;
                    const newAmount = oldAmount + orderAmount;
                    const newEntry = (oldEntry * oldAmount + dcaPrice * orderAmount) / newAmount;

                    trade.entryPrice = Number(newEntry.toFixed(5));
                    trade.amount = Number(newAmount.toFixed(2));
                    (trade as any).initialAmount = initialAmount;
                    (trade as any).dcaAveraged = true;
                    (trade as any).dcaBreakEvenPrice = trade.entryPrice;

                    if (trade.takeProfit) {
                      const tpRatio = trade.takeProfit / oldEntry;
                      trade.takeProfit = Number((trade.entryPrice * tpRatio).toFixed(5));
                    }

                    if (trade.tpStages) {
                      trade.tpStages.forEach((stage: any) => {
                        if (stage.targetPrice) {
                          const stageRatio = stage.targetPrice / oldEntry;
                          stage.targetPrice = Number((trade.entryPrice * stageRatio).toFixed(5));
                        }
                      });
                    }

                    if (trade.stopLoss) {
                      const slRatio = trade.stopLoss / oldEntry;
                      const ratioSl = Number((trade.entryPrice * slRatio).toFixed(5));
                      // Protect Stop Loss: never widen into deeper loss on DCA
                      trade.stopLoss = trade.side === 'LONG'
                        ? Math.max(trade.stopLoss, ratioSl)
                        : Math.min(trade.stopLoss, ratioSl);
                    }

                    if (!trade.history) trade.history = [];
                    trade.history.push({ time: Date.now(), type: 'AVERAGE', price: dcaPrice, amount: orderAmount });

                    if (trade.isReal) {
                      trade.isExchangeSlTpSynced = false;
                      trade.needsSlTpSync = true;
                      setTimeout(() => {
                        deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit)
                          .then(success => {
                            if (success) {
                              trade.isExchangeSlTpSynced = true;
                              trade.needsSlTpSync = false;
                              deps.saveTradeDB(trade, true);
                            }
                          })
                          .catch(err => {
                            console.log('[WATCHDOG DCA SL/TP RE-SYNC ERR]:', err.message);
                          });
                      }, 5000);
                    }

                    deps.saveTradeDB(trade, true);
                    hasChanges = true;

                    if (trade.isReal) {
                      deps.sendTelegramMessage(`🤖 <b>Watchdog: Executed Grid DCA</b>\n\nSymbol: ${trade.symbol}\nPrice: $${dcaPrice}\nNew Entry: $${trade.entryPrice.toFixed(5)}\nNew TP: $${trade.takeProfit?.toFixed(5)}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else if (isPriceInSlZone && trade.gridOrders && trade.gridOrders.some((g: any) => !g.executed)) {
      console.log(`[WATCHDOG DCA GUARD] Averaging blocked for ${trade.symbol}: price $${currentPrice} is inside or within 0.5% of Stop Loss ($${trade.stopLoss})`);
    }

    // Position Closure handling
    if (shouldClose) {
      trade.isClosing = true;
      let finalClosePrice = currentPrice;

      if (trade.isReal) {
        try {
          console.log(`[WATCHDOG REAL CLOSE] Requesting closure on exchange for ${trade.symbol}...`);
          const res = await deps.executeRealCloseOnExchange(trade.symbol, trade.side);
          if (res && res.success && res.data) {
            const ord = res.data;
            if (ord.average || ord.price) {
              finalClosePrice = ord.average || ord.price;
              console.log(`[WATCHDOG REAL CLOSE RESULT] Exchange completed successfully. Fill Price: $${finalClosePrice} vs feed: $${currentPrice}`);
            }
          }
        } catch (e: any) {
          trade.isClosing = false;
          console.log(`[WATCHDOG REAL CLOSE ERROR] Failed to close ${trade.symbol}:`, e.message || e);
        }
      }

      trade.status = 'CLOSED';
      trade.closeTime = Date.now();
      trade.closePrice = finalClosePrice;
      trade.closeReason = reason;
      trade.notes = reason;

      if (!trade.history) trade.history = [];
      trade.history.push({ time: Date.now(), type: 'CLOSE', price: finalClosePrice, amount: trade.amount });

      let totalPnlUsd = 0;
      let initialTradeAmount = trade.initialAmount || trade.amount;
      if (!trade.initialAmount) {
        trade.initialAmount = initialTradeAmount;
      }

      trade.history.forEach((h: any) => {
        if (h.type === 'CLOSE') {
          const { pnlUsd } = getUnifiedTradeClosePnl(trade.side, trade.entryPrice, h.price, h.amount, trade.leverage);
          totalPnlUsd += pnlUsd;
        }
      });

      const totalPnlPercent = initialTradeAmount > 0 ? (totalPnlUsd / initialTradeAmount) * 100 : 0;

      trade.pnl = totalPnlUsd;
      trade.pnlPercent = totalPnlPercent;
      (trade as any).outcome = totalPnlPercent > 0 ? 1 : 0;

      if (!(trade as any).isAutoLearning && !trade.isReal) {
        const tradeMargin = (trade as any).margin || (trade as any).initialMargin || (initialTradeAmount ? initialTradeAmount / (trade.leverage || 1) : 0);
        const newBal = Number((deps.getVirtualBalance() + tradeMargin + totalPnlUsd).toFixed(2));
        deps.setVirtualBalance(newBal);
        deps.saveBalanceDB();
      }

      // Update Knowledge Base Statistics
      if (trade.matchedRules && trade.matchedRules.length > 0) {
        for (const ruleId of trade.matchedRules) {
          const rule = aiKnowledgeBase.find(r => r.id === ruleId);
          if (rule) {
            const count = rule.usageCount || 0;
            const rate = rule.successRate ?? 0.5;
            const outcome = totalPnlPercent > 0 ? 1 : 0;
            rule.usageCount = count + 1;
            rule.successRate = ((rate * count) + outcome) / (count + 1);
            if (outcome === 1) rule.impact = Math.min(100, (rule.impact || 0) + 1);
            else rule.impact = Math.max(-100, (rule.impact || 0) - 2);
            deps.saveKnowledgeDB(rule);
          }
        }
      }

      console.log(`[Watchdog] Closing trade ${trade.symbol} at ${currentPrice} reason: ${reason}`);

      // Автоматическое обновление блэклиста паттернов на основе актуальных результатов
      try {
        updatePatternBlacklistFromStats(virtualTrades as any);
      } catch (err: any) {
        console.warn('[WATCHDOG BLACKLIST REFRESH ERROR]', err?.message || err);
      }

      // Background AI Evaluation
      (async () => {
        try {
          const features = (trade as any).features || [];
          const entryRsi = (features[1] !== undefined) ? (features[1] + 50).toFixed(1) : 'неизвестно';
          const volumeSpike = (features[5] !== undefined) ? (features[5] === 1 ? 'Да' : 'Нет') : 'неизвестно';
          const ema50Dist = (features[3] !== undefined) ? features[3].toFixed(2) : 'неизвестно';
          const ema200Dist = (features[4] !== undefined) ? features[4].toFixed(2) : 'неизвестно';
          const obImbalance = (features[6] !== undefined) ? (features[6] * 100).toFixed(1) : 'неизвестно';
          const breakout48h = (features[0] !== undefined) ? (features[0] === 1 ? 'Да' : 'Нет') : 'неизвестно';

          const evalPrompt = `Проанализируй закрытую фьючерсную сделку и сформируй уроки для торгового ИИ-агента.
Информация о сделке:
Монета: ${trade.symbol}
Направление: ${trade.side}
Вход (цена): ${trade.entryPrice}
Выход (цена): ${trade.closePrice}
PnL %: ${trade.pnlPercent?.toFixed(2)}% (${trade.pnl?.toFixed(2)} USDT)
Причина закрытия: ${trade.notes}

Показатели на момент входа в сделку:
1. RSI (15м): ${entryRsi}
2. Аномальный всплеск объема (Volume Spike): ${volumeSpike}
3. Пробой 48-часового максимума/минимума: ${breakout48h}
4. Расстояние от EMA50 (%): ${ema50Dist}%
5. Расстояние от EMA200 (%): ${ema200Dist}%
6. Дисбаланс стакана (Order Book Imbalance %): ${obImbalance}%
Глобальный пульс рынка (направление): ${globalMarketPulse.sentiment} (Bias score: ${globalMarketPulse.bias})

Если PnL отрицательный, сформулируй правило, помогающее избегать такой ошибки в будущем. Если PnL положительный, выдели успешные факторы.

Ответь СТРОГО в формате JSON:
{
  "evaluation": "Короткий профессиональный технический анализ причин исхода сделки (на русском)",
  "learnedRule": "Текст правила (на русском, до 150 символов) для фильтрации будущих сетапов",
  "structuredFilter": {
    "indicator": "rsi",
    "condition": "gt",
    "value": 65,
    "action": "penalty"
  }
}`;
          const aiResp = await deps.runAiGeneration({
            model: "gemini-3.7-flash",
            contents: [{ role: 'user', parts: [{ text: evalPrompt }] }],
            config: { responseMimeType: "application/json", temperature: 0.7 }
          });
          if (aiResp.text) {
            const resBody = safeJsonParse(aiResp.text, {});
            trade.aiEvaluation = resBody.evaluation;
            trade.learnedRule = resBody.learnedRule;

            if (resBody.learnedRule && resBody.learnedRule.length > 5) {
              const ruleTextLower = resBody.learnedRule.toLowerCase();
              let agentCat: 'SCANNER' | 'MANAGER' | 'GENERAL' = 'SCANNER';
              if (ruleTextLower.includes('усредне') || ruleTextLower.includes('dca') || ruleTextLower.includes('стоп') || ruleTextLower.includes('тейк') || ruleTextLower.includes('выход') || ruleTextLower.includes('закрыт')) {
                agentCat = 'MANAGER';
              }

              let filterInd = undefined;
              let filterCond = undefined;
              let filterVal = undefined;
              let filterAct = undefined;

              if (resBody.structuredFilter) {
                filterInd = resBody.structuredFilter.indicator;
                filterCond = resBody.structuredFilter.condition;
                filterVal = typeof resBody.structuredFilter.value === 'number' ? resBody.structuredFilter.value : undefined;
                filterAct = resBody.structuredFilter.action;
              }

              const newRule: any = {
                id: `al_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                agent: agentCat,
                text: `[Авто-Обучение | ${trade.symbol} | PnL ${trade.pnlPercent?.toFixed(1)}%] ${resBody.learnedRule}`,
                impact: (trade.pnlPercent || 0) > 0 ? 8 : -12,
                successRate: (trade.pnlPercent || 0) > 0 ? 0.85 : 0.15,
                usageCount: 1,
                filterIndicator: filterInd,
                filterCondition: filterCond,
                filterValue: filterVal,
                filterAction: filterAct
              };
              aiKnowledgeBase.push(newRule);
              deps.saveKnowledgeDB(newRule);
            }

            deps.saveTradeDB(trade);
            deps.emitSignalsUpdated();
          }
        } catch (err: any) {
          const isQuota = err?.message?.includes("429") || err?.message?.includes("quota") || err?.message?.includes("Too Many");
          if (!isQuota) {
            console.warn("[Watchdog AI Eval] Error:", err?.message || err);
          }
        }
      })();

      deps.saveBalanceDB();
      deps.saveTradeDB(trade);
      if (trade.isReal) {
        deps.sendTelegramMessage(`🛡️ <b>Watchdog: ${reason}</b>\n\nSymbol: ${trade.symbol}\nPnL: ${(trade.pnl ?? 0) > 0 ? '+' : ''}${(trade.pnl ?? 0).toFixed(2)} USDT (${(trade.pnlPercent ?? 0).toFixed(2)}%)`);
      }
      hasChanges = true;
    }
  }

  if (hasChanges) {
    deps.emitSignalsUpdated();
  }
}
