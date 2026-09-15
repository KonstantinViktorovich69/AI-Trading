import { cleanSymbol, findTickerInMap } from '../utils/symbolUtils.ts';
import { safeJsonParse } from '../utils/jsonRepair.ts';

export interface ExpertAdvisorDependencies {
  getVirtualTrades: () => any[];
  getGlobalSettings: () => any;
  getGlobalCcxtTickers: () => Record<string, any>;
  getGlobalTrueOhlcv: () => Record<string, any>;
  getAiKnowledgeBase: () => any[];
  getVirtualBalance: () => number;
  readLocalDB: () => any;
  saveTradeDB: (trade: any, immediate?: boolean) => Promise<void>;
  emitSignalsUpdated: () => void;
  sendTelegramMessage: (text: string) => void;
  executeRealCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT') => Promise<any>;
  executeRealPartialCloseOnExchange: (symbol: string, side: 'LONG' | 'SHORT', ratio: number) => Promise<any>;
  executeRealOpenOnExchange: (symbol: string, side: 'LONG' | 'SHORT', amount: number, leverage: number) => Promise<any>;
  setRealTradeSlTpOnExchange: (symbol: string, side: 'LONG' | 'SHORT', stopLoss?: number, takeProfit?: number) => Promise<boolean>;
  runAiGeneration: (params: any) => Promise<{ text?: string }>;
}

/**
 * Deterministic rule-based fallback when AI is unavailable or rate-limited.
 */
export async function executeRuleBasedTradeFallback(
  trade: any,
  currentPrice: number,
  pnlPct: number,
  pnlUsd: number,
  availableBalance: number,
  isQuota: boolean,
  deps: ExpertAdvisorDependencies
): Promise<void> {
  if (!trade || trade.status !== 'OPEN' || trade.isClosing) return;

  const symbol = trade.symbol;
  const isShort = trade.side === 'SHORT';
  const dcaCount = trade.history ? trade.history.filter((h: any) => h.type === 'AVERAGE').length : 0;

  const priceDevPct = trade.entryPrice > 0
    ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
    : 0;

  const isDrawdown = isShort ? priceDevPct >= 1.8 : priceDevPct <= -1.8;

  const cleanSym = cleanSymbol(symbol);
  const globalTrueOhlcv = deps.getGlobalTrueOhlcv();
  const localInds = globalTrueOhlcv[cleanSym] || {};
  const isSarReversal = isShort ? (localInds.isSarBearishFlipped1m || localInds.isSarBearishFlipped15m) : (localInds.isSarBullishFlipped1m || localInds.isSarBullishFlipped15m);
  const isRsiExtreme = isShort ? (localInds.rsi15m >= 68 || localInds.rsi1m >= 70) : (localInds.rsi15m <= 32 || localInds.rsi1m <= 30);

  // 1. RULE-BASED DCA CHECK with Stop Loss Proximity and Margin Cap Guards
  const lastActionTime = (trade as any).lastGridTime || 0;
  const cooldownElapsed = lastActionTime === 0 ? true : (Date.now() - lastActionTime) >= 120000;

  let isPriceInSlZone = false;
  if (trade.stopLoss && trade.stopLoss > 0) {
    if (isShort && currentPrice >= trade.stopLoss * 0.995) {
      isPriceInSlZone = true;
    } else if (!isShort && currentPrice <= trade.stopLoss * 1.005) {
      isPriceInSlZone = true;
    }
  }

  const initialAmount = (trade as any).initialAmount || (trade.history && trade.history[0]?.amount) || trade.amount;
  const maxAllowedAmount = Number((initialAmount * 1.5).toFixed(2));
  const hasMarginRoom = trade.amount < maxAllowedAmount;

  if (trade.mode === 'AUTO' && isDrawdown && dcaCount < 3 && !isPriceInSlZone && cooldownElapsed && hasMarginRoom) {
    let triggerDca = false;
    if (dcaCount === 0 && (pnlPct <= -8.0 || Math.abs(priceDevPct) >= 1.8)) {
      triggerDca = true;
    } else if (dcaCount === 1 && (pnlPct <= -16.0 || Math.abs(priceDevPct) >= 3.6)) {
      triggerDca = true;
    } else if (dcaCount === 2 && (pnlPct <= -25.0 || Math.abs(priceDevPct) >= 5.5)) {
      triggerDca = true;
    }

    const dcaMult = 0.5;
    let dcaAmount = trade.amount * dcaMult;
    if (trade.amount + dcaAmount > maxAllowedAmount) {
      dcaAmount = Number((maxAllowedAmount - trade.amount).toFixed(2));
    }

    if (triggerDca && dcaAmount >= 1.0 && availableBalance >= dcaAmount) {
      let dcaPrice = currentPrice;

      if (trade.isReal) {
        try {
          const resDca = await deps.executeRealOpenOnExchange(symbol, trade.side, dcaAmount, trade.leverage);
          if (resDca && resDca.success && resDca.entryPrice) {
            dcaPrice = resDca.entryPrice;
          } else {
            console.warn(`[RULE-FALLBACK DCA SKIPPED] Real DCA failed for ${symbol}:`, resDca?.error);
            triggerDca = false;
          }
        } catch (e: any) {
          console.warn(`[RULE-FALLBACK DCA ERROR] ${symbol}:`, e.message || e);
          triggerDca = false;
        }
      }

      if (triggerDca) {
        const oldEntry = trade.entryPrice;
        const currentCoins = trade.amount / oldEntry;
        const newCoins = dcaAmount / dcaPrice;
        const totalMargin = trade.amount + dcaAmount;
        const totalCoins = currentCoins + newCoins;
        const newEntryPrice = totalMargin / totalCoins;

        if (trade.takeProfit) {
          trade.takeProfit = Number((newEntryPrice * (trade.takeProfit / oldEntry)).toFixed(5));
        }
        if (trade.stopLoss) {
          const ratioSl = Number((newEntryPrice * (trade.stopLoss / oldEntry)).toFixed(5));
          trade.stopLoss = trade.side === 'LONG'
            ? Math.max(trade.stopLoss, ratioSl)
            : Math.min(trade.stopLoss, ratioSl);
        }
        (trade as any).dcaAveraged = true;
        (trade as any).dcaBreakEvenPrice = Number(newEntryPrice.toFixed(5));
        (trade as any).initialAmount = initialAmount;
        if (trade.tpStages) {
          trade.tpStages.forEach((stage: any) => {
            stage.targetPrice = Number((newEntryPrice * (stage.targetPrice / oldEntry)).toFixed(5));
          });
        }

        trade.entryPrice = Number(newEntryPrice.toFixed(5));
        trade.amount = Number(totalMargin.toFixed(2));
        const now = Date.now();
        (trade as any).lastGridTime = now;
        (trade as any).lastAiCheck = now;
        (trade as any).lastAiAction = 'DCA';

        const quotaTag = isQuota ? " [Квант-Режим]" : "";
        trade.aiAdvice = `[Авто-правила Агента №1${quotaTag}] Выполнено усреднение (DCA #${dcaCount + 1}). Вход: $${oldEntry} ➡️ $${trade.entryPrice}. TP смещен к $${trade.takeProfit}.`;

        if (!trade.history) trade.history = [];
        trade.history.push({ time: now, type: 'AVERAGE', price: dcaPrice, amount: dcaAmount, notes: trade.aiAdvice });

        if (trade.isReal) {
          trade.isExchangeSlTpSynced = false;
          trade.needsSlTpSync = true;
          setTimeout(() => {
            deps.setRealTradeSlTpOnExchange(symbol, trade.side, trade.stopLoss, trade.takeProfit)
              .then(success => {
                if (success) {
                  trade.isExchangeSlTpSynced = true;
                  trade.needsSlTpSync = false;
                  deps.saveTradeDB(trade, true);
                }
              })
              .catch(() => {});
          }, 5000);
        }

        await deps.saveTradeDB(trade, true);
        deps.emitSignalsUpdated();

        const telegramText = `🧑‍💼 <b>ИИ-Ведущий Трейдер${quotaTag}: Усреднение (DCA #${dcaCount + 1})</b>\n\n` +
          `Монета: <b>${trade.symbol}</b>\n` +
          `Новая средняя цена: $${trade.entryPrice}\n` +
          `Новый Take Profit: $${trade.takeProfit}\n` +
          `Маржа увеличена: +$${dcaAmount.toFixed(2)} (Всего: $${trade.amount.toFixed(2)})\n\n` +
          `💬 ${trade.aiAdvice}`;

        try {
          deps.sendTelegramMessage(telegramText);
        } catch (e) {}

        return;
      }
    }
  }

  // 2. RULE-BASED TAKE PROFIT / PARTIAL CLOSE
  if (pnlPct >= 8.0) {
    const isStageDone = trade.tpStages && trade.tpStages.some((st: any) => st.executed);
    if (!isStageDone && trade.amount >= 10.0) {
      const ratioToClose = 0.5;
      const closedAmount = Number((trade.amount * ratioToClose).toFixed(2));
      let partialClosePrice = currentPrice;
      let realExecuted = true;

      if (trade.isReal) {
        try {
          const resPc = await deps.executeRealPartialCloseOnExchange(trade.symbol, trade.side, ratioToClose);
          if (resPc && resPc.success && resPc.data) {
            const ord = resPc.data;
            if (ord.average || ord.price) {
              partialClosePrice = ord.average || ord.price;
            }
          }
        } catch (e: any) {
          realExecuted = false;
        }
      }

      if (!trade.isReal || realExecuted) {
        trade.amount = Number((trade.amount - closedAmount).toFixed(2));
        const now = Date.now();
        (trade as any).lastAiCheck = now;
        (trade as any).lastAiAction = 'PARTIAL_CLOSE';

        const quotaTag = isQuota ? " [Квант-Режим]" : "";
        trade.aiAdvice = `[Авто-правила Агента №1${quotaTag}] Зафиксировано 50% прибыли при PnL +${pnlPct.toFixed(2)}%. СЛ подтянут в безубыток.`;

        if (!trade.history) trade.history = [];
        trade.history.push({ time: now, type: 'CLOSE', price: partialClosePrice, amount: closedAmount, notes: trade.aiAdvice });

        const bePrice = isShort ? Number((trade.entryPrice * 0.999).toFixed(5)) : Number((trade.entryPrice * 1.001).toFixed(5));
        trade.stopLoss = bePrice;
        trade.isProtected = true;

        if (trade.tpStages && trade.tpStages[0]) {
          trade.tpStages[0].executed = true;
        }

        if (trade.isReal) {
          trade.isExchangeSlTpSynced = false;
          trade.needsSlTpSync = true;
          setTimeout(() => {
            deps.setRealTradeSlTpOnExchange(symbol, trade.side, trade.stopLoss, trade.takeProfit)
              .then(success => {
                if (success) {
                  trade.isExchangeSlTpSynced = true;
                  trade.needsSlTpSync = false;
                  deps.saveTradeDB(trade, true);
                }
              })
              .catch(() => {});
          }, 5000);
        }

        await deps.saveTradeDB(trade, true);
        deps.emitSignalsUpdated();

        const telegramText = `🧑‍💼 <b>ИИ-Ведущий Трейдер${quotaTag}: Частичная фиксация (50%)</b>\n\n` +
          `Монета: <b>${trade.symbol}</b>\n` +
          `Зафиксировано: +$${((closedAmount * pnlPct) / 100).toFixed(2)} (${pnlPct.toFixed(2)}%)\n` +
          `Остаток маржи: $${trade.amount.toFixed(2)}\n` +
          `Стоп-лосс перемещен в безубыток: $${trade.stopLoss}\n\n` +
          `💬 ${trade.aiAdvice}`;

        try {
          deps.sendTelegramMessage(telegramText);
        } catch (e) {}

        return;
      }
    }
  }

  // 3. RULE-BASED EMERGENCY SL/TP ADJUSTMENT
  const oldSl = trade.stopLoss;
  let targetSl = trade.stopLoss;
  let targetTp = trade.takeProfit;
  let adjustReason = '';

  if (pnlPct >= 4.0 && !trade.isProtected) {
    targetSl = isShort ? Number((trade.entryPrice * 0.9995).toFixed(5)) : Number((trade.entryPrice * 1.0005).toFixed(5));
    adjustReason = `Перенос SL в безубыток при PnL +${pnlPct.toFixed(2)}%`;
  } else if (pnlPct <= -12.0 && isSarReversal) {
    targetTp = isShort ? Number((trade.entryPrice * 0.995).toFixed(5)) : Number((trade.entryPrice * 1.005).toFixed(5));
    adjustReason = `Снижение цели TP ближе к точке безубытка из-за локального отскока SAR`;
  }

  if (targetSl !== oldSl || targetTp !== trade.takeProfit) {
    trade.stopLoss = targetSl;
    trade.takeProfit = targetTp;
    if (targetSl !== oldSl) trade.isProtected = true;

    const now = Date.now();
    (trade as any).lastAiCheck = now;
    (trade as any).lastAiAction = 'UPDATE_SL';

    const quotaTag = isQuota ? " [Квант-Режим]" : "";
    const fullAdvice = `[Авто-правила Агента №1${quotaTag}] Уровни скорректированы: ${adjustReason}. SL: ${targetSl}, TP: ${targetTp}.`;
    trade.aiAdvice = fullAdvice;

    if (!trade.history) trade.history = [];
    trade.history.push({ time: now, type: 'ADJUST_SL_TP', price: targetSl, amount: targetTp, notes: fullAdvice });

    if (trade.isReal) {
      deps.setRealTradeSlTpOnExchange(symbol, trade.side, targetSl, targetTp).catch(() => {});
    }

    deps.saveTradeDB(trade);
    deps.emitSignalsUpdated();

    const telegramText = `🧑‍💼 <b>ИИ-Ведущий Трейдер${quotaTag}: Корректировка уровней SL/TP</b>\n\n` +
      `Монета: <b>${trade.symbol}</b>\n` +
      `Стоп-лосс изменен: ${oldSl || 'N/A'} ➡️ <b>${targetSl}</b>\n` +
      `Тейк-профит: <b>${targetTp}</b>\n\n` +
      `💬 ${adjustReason}`;

    try {
      deps.sendTelegramMessage(telegramText);
    } catch (e) {}

    return;
  }

  // 4. RULE-BASED SCALPING TIME-STOP (STAGNATION CHECK)
  const tradeAgeHours = (Date.now() - (trade.openTime || (trade as any).createdAt || Date.now())) / (3600 * 1000);
  if (trade.mode === 'AUTO' && tradeAgeHours >= 3.5 && pnlPct <= 1.0 && !(trade as any).manualCloseRequested) {
    (trade as any).manualCloseRequested = true;
    (trade as any).closeReason = `Тайм-стоп скальпинга: позиция в боковике ${tradeAgeHours.toFixed(1)}ч (PnL: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%). Высвобождение торгового слота.`;
    (trade as any).closeReasonCode = 'TIMEOUT_SAFETY';
    (trade as any).lastAiAction = 'CLOSE';
    const quotaTag = isQuota ? " [Квант-Режим]" : "";
    trade.aiAdvice = `[Авто-правила Агента №1${quotaTag}] Позиция находилась в боковике более ${tradeAgeHours.toFixed(1)}ч. Передана на закрытие по тайм-стопу скальпинга.`;
    deps.sendTelegramMessage(`🧑‍💼 <b>ИИ-Ведущий Трейдер${quotaTag}: Тайм-стоп скальпинга (${trade.symbol})</b>\n\nУдержание: ${tradeAgeHours.toFixed(1)}ч в боковике (PnL: ${pnlPct.toFixed(2)}%)\nПозиция закрывается для освобождения слота.`);
    await deps.saveTradeDB(trade, true);
    deps.emitSignalsUpdated();
    return;
  }

  // 5. DEFAULT RULE-BASED HOLD
  const quotaNote = isQuota ? " [Пауза Gemini / Квант-Защита]" : "";
  trade.aiAdvice = `[Авто-правила Агента №1${quotaNote}] Позиция удерживается (HOLD). PnL: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%. Защитные механизмы PTTP, Z-Shield и стоп-ордера активны.`;
  deps.saveTradeDB(trade);
  deps.emitSignalsUpdated();
}

/**
 * AI Expert Advisor evaluation cycle
 */
export async function runAiExpertTraderLoop(deps: ExpertAdvisorDependencies): Promise<void> {
  try {
    const globalSettings = deps.getGlobalSettings();
    if (!globalSettings || !(globalSettings as any).isAiExpertTraderEnabled) return;

    const virtualTrades = deps.getVirtualTrades();
    if (!virtualTrades || !Array.isArray(virtualTrades)) return;
    const openTrades = virtualTrades.filter(t => t.status === 'OPEN' && (t.mode === 'AUTO' || t.mode === 'SEMI_AUTO') && !t.isExternal && !t.isExchangeManual);
    if (openTrades.length === 0) return;

    const now = Date.now();
    const checkInterval = (globalSettings as any).aiExpertTraderInterval || 120000;
    const globalCcxtTickers = deps.getGlobalCcxtTickers();
    const aiKnowledgeBase = deps.getAiKnowledgeBase();
    const availableBalance = deps.getVirtualBalance();

    for (const trade of openTrades) {
      if (trade.lastAiCheck && (now - trade.lastAiCheck < checkInterval)) {
        continue;
      }
      if (!trade.lastAiCheck && trade.openTime && (now - trade.openTime < 30000)) {
        continue;
      }

      const ex = trade.exchange || 'mexc';
      const tickersForEx = globalCcxtTickers[ex] || {};
      const ticker = findTickerInMap(trade.symbol, tickersForEx);
      const currentPrice = ticker ? (ticker.last || ticker.close || trade.entryPrice) : trade.entryPrice;

      let pnlPct = 0;
      if (trade.entryPrice > 0) {
        if (trade.side === 'LONG') {
          pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
        } else {
          pnlPct = ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100 * trade.leverage;
        }
      }
      const pnlUsd = (trade.amount * (pnlPct / 100));

      if (pnlPct > ((trade as any).maxReachedPnl || 0)) {
        (trade as any).maxReachedPnl = pnlPct;
      }

      console.log(`[AI-EXPERT-TRADER SYSTEM] Live evaluating ${trade.symbol} (${trade.side}). Current PnL: ${pnlPct.toFixed(2)}%, Entry: ${trade.entryPrice}, Mark: ${currentPrice}`);

      const rules = aiKnowledgeBase.filter(r => {
        if (r.isArchived) return false;
        if (r.agent === 'GENERAL') return true;
        if (trade.side === 'LONG') {
          return r.agent === 'LONG_MANAGER';
        } else {
          return r.agent === 'MANAGER';
        }
      }).map(r => r.text).join('\n');

      const dbDataForMem = deps.readLocalDB();
      const recentMemories = (dbDataForMem.retrospectiveMemory || [])
        .filter((mem: any) => mem.symbol === trade.symbol || mem.symbol === cleanSymbol(trade.symbol))
        .slice(-3);
      const fallbackMemories = recentMemories.length > 0 ? [] : (dbDataForMem.retrospectiveMemory || []).slice(-3);
      const activeMemories = [...recentMemories, ...fallbackMemories];
      const memoryString = activeMemories.length > 0
        ? activeMemories.map((m: any) => `- Сделка по ${m.symbol} (${m.pnlPercent > 0 ? 'Профит' : 'Убыток'} ${m.pnlPercent?.toFixed(1)}%): Решение ${m.actionTaken}. Извлеченные уроки: ${m.lesson}`).join('\n')
        : "Нет накопленных уроков по этой паре. Будь предельно осторожен.";

      const historyStr = (trade.history || []).map((h: any) => `${new Date(h.time).toLocaleTimeString()}: ${h.type} at $${h.price} (amt: ${h.amount})`).join('; ');

      const prompt = `Ты — Ведущий Эксперт-Трейдер (AI Lead Trader), управляющий открытой позицией.
Твоя цель: максимизировать прибыль и жестко контролировать риски.

ДАННЫЕ ПОЗИЦИИ:
- Символ: ${trade.symbol}
- Направление: ${trade.side}
- Точка входа: $${trade.entryPrice}
- Текущая цена: $${currentPrice}
- Плечо: ${trade.leverage}x
- Маржа: $${trade.amount} USDT
- Текущий PnL: ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)} USDT)
- Максимальный достигнутый PnL: ${((trade as any).maxReachedPnl || pnlPct).toFixed(2)}%
- Stop Loss: $${trade.stopLoss || 'Не установлен'}
- Take Profit: $${trade.takeProfit || 'Не установлен'}
- История действий: ${historyStr || 'Новая позиция'}
- Доступный баланс: $${availableBalance.toFixed(2)} USDT

БАЗА ЗНАНИЙ И ПРАВИЛА:
${rules || 'Стандартные правила квант-риск-менеджмента'}

РЕТРОСПЕКТИВНЫЙ ОПЫТ:
${memoryString}

ВОЗМОЖНЫЕ ДЕЙСТВИЯ (action):
- "HOLD": Удерживать позицию без изменений.
- "CLOSE": Немедленно закрыть позицию по рынку.
- "PARTIAL_CLOSE": Зафиксировать часть позиции (указать partialCloseRatio от 0.1 до 0.9).
- "DCA": Усреднить позицию по текущей цене (указать dcaMultiplier от 0.2 до 1.0).
- "UPDATE_SL": Скорректировать уровни (указать newSl и/или newTp).

ОТВЕТЬ СТРОГО В ФОРМАТЕ JSON:
{
  "action": "HOLD" | "CLOSE" | "PARTIAL_CLOSE" | "DCA" | "UPDATE_SL",
  "advice": "Развернутый профессиональный анализ и обоснование решения на русском языке",
  "newSl": number | null,
  "newTp": number | null,
  "partialCloseRatio": number | null,
  "dcaMultiplier": number | null,
  "reasonCategory": "PROFIT_SECURED" | "TREND_REVERSAL" | "INVALIDATION" | "VOLATILITY_EXPANSION" | "AVERAGING_LOGIC" | "NOISE_EXCLUSION"
}`;

      try {
        const aiResponse = await deps.runAiGeneration({
          model: "gemini-3.7-flash",
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { responseMimeType: "application/json", temperature: 0.2 }
        });

        const result = safeJsonParse(aiResponse.text, { action: "HOLD", advice: "Позиция удерживается в рамках тренда." });

        trade.lastAiCheck = now;
        trade.aiAdvice = result.advice || "Позиция сопровождается ИИ.";

        if (trade.mode === 'AUTO') {
          if (result.action === 'UPDATE_SL' && (result.newSl || result.newTp)) {
            const oldSl = trade.stopLoss;
            const oldTp = trade.takeProfit;
            if (result.newSl) trade.stopLoss = result.newSl;
            if (result.newTp) trade.takeProfit = result.newTp;
            (trade as any).lastAiAction = 'UPDATE_SL';

            if (!trade.history) trade.history = [];
            trade.history.push({ time: now, type: 'ADJUST_SL_TP', price: trade.stopLoss, amount: trade.takeProfit, notes: result.advice });

            if (trade.isReal) {
              deps.setRealTradeSlTpOnExchange(trade.symbol, trade.side, trade.stopLoss, trade.takeProfit).catch(() => {});
            }

            const telegramText = `🧑‍💼 <b>ИИ-Ведущий Трейдер: Корректировка SL/TP (${trade.symbol})</b>\n\n` +
              `Стоп-лосс: ${oldSl || 'N/A'} ➡️ <b>${trade.stopLoss}</b>\n` +
              `Тейк-профит: ${oldTp || 'N/A'} ➡️ <b>${trade.takeProfit}</b>\n\n` +
              `💬 ${result.advice}`;
            deps.sendTelegramMessage(telegramText);
          } else if (result.action === 'DCA' && result.dcaMultiplier) {
            const dcaMult = Math.min(1.0, Math.max(0.2, result.dcaMultiplier));
            const dcaAmount = Number((trade.amount * dcaMult).toFixed(2));
            if (availableBalance >= dcaAmount) {
              let dcaPrice = currentPrice;
              let executedReal = true;
              if (trade.isReal) {
                try {
                  const res = await deps.executeRealOpenOnExchange(trade.symbol, trade.side, dcaAmount, trade.leverage);
                  if (res && res.success && res.entryPrice) dcaPrice = res.entryPrice;
                  else executedReal = false;
                } catch (e) { executedReal = false; }
              }
              if (!trade.isReal || executedReal) {
                const oldEntry = trade.entryPrice;
                const totalMargin = trade.amount + dcaAmount;
                const newEntry = (oldEntry * trade.amount + dcaPrice * dcaAmount) / totalMargin;
                trade.entryPrice = Number(newEntry.toFixed(5));
                trade.amount = Number(totalMargin.toFixed(2));
                (trade as any).lastAiAction = 'DCA';

                if (!trade.history) trade.history = [];
                trade.history.push({ time: now, type: 'AVERAGE', price: dcaPrice, amount: dcaAmount, notes: result.advice });

                deps.sendTelegramMessage(`🧑‍💼 <b>ИИ-Ведущий Трейдер: Усреднение DCA (${trade.symbol})</b>\n\nДобавлено: $${dcaAmount} USDT\nНовая точка входа: $${trade.entryPrice}\n\n💬 ${result.advice}`);
              }
            }
          } else if (result.action === 'CLOSE') {
            (trade as any).manualCloseRequested = true;
            (trade as any).closeReason = result.advice || 'Закрытие по рекомендации ИИ-Ведущего Трейдера';
            (trade as any).closeReasonCode = 'TIMEOUT_SAFETY';
            (trade as any).lastAiAction = 'CLOSE';
            deps.sendTelegramMessage(`🧑‍💼 <b>ИИ-Ведущий Трейдер: Сигнал на закрытие позиции (${trade.symbol})</b>\n\n💬 ${result.advice}`);
          }
        }

        await deps.saveTradeDB(trade);
        deps.emitSignalsUpdated();

      } catch (err: any) {
        const isQuota = err?.message?.includes("429") || err?.message?.includes("quota") || err?.message?.includes("Too Many");
        if (!isQuota) {
          console.warn(`[AI-EXPERT-TRADER MODULE EVAL ERROR] ${trade.symbol}:`, err.message || err);
        }
        await executeRuleBasedTradeFallback(trade, currentPrice, pnlPct, pnlUsd, availableBalance, isQuota, deps);
      }
    }
  } catch (e: any) {
    console.error(`[AI-EXPERT-TRADER CORE ERROR]`, e.getStack ? e.getStack() : e.message);
  }
}
