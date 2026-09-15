import express from 'express';
import type { Request, Response, Router } from 'express';
import { DirectionalMemoryAnalyticsService } from '../services/directionalMemoryAnalyticsService.ts';
import { SignalPerformanceAnalyticsService } from '../services/signalPerformanceAnalyticsService.ts';

export interface PaperTradeRouterContext {
  getVirtualTrades: () => any[];
  getVirtualBalance: () => number;
  setVirtualBalance: (bal: number) => void;
  getStartOfDayBalance: () => number;
  setStartOfDayBalance: (bal: number) => void;
  getStartOfDayRealBalance: () => number;
  setStartOfDayRealBalance: (bal: number) => void;
  getStartOfWeekBalance: () => number;
  setStartOfWeekBalance: (bal: number) => void;
  getIsCircuitBreakerActive: () => boolean;
  setIsCircuitBreakerActive: (active: boolean) => void;
  getLastBtcShockTime: () => number;
  getGlobalSettings: () => any;
  getWsTickers: () => any;
  getGlobalCcxtTickers: () => any;
  getSignalsData: () => any[];
  getModelWeights: () => any;
  getAtomicStoreRevision: () => number;
  saveTradeDB: (trade: any) => Promise<void>;
  saveBalanceDB: () => void;
  normalizeSymbol: (sym: string) => string;
  findTickerInMap: (sym: string, tickersMap: any) => any;
  validatePaperTradeInput: (input: any) => { valid: boolean; error?: string; value?: any };
  acquireExecutionLock: (sym: string) => boolean;
  releaseExecutionLock: (sym: string) => void;
  executeRealOpenOnExchange: (symbol: string, side: string, amount: number, leverage: number, stopLoss?: number, takeProfit?: number) => Promise<any>;
  getUnifiedTradeClosePnl: (side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) => { pnlUsd: number; feeUsd: number };
  getExchangeLink: (exchange: string, symbol: string) => string;
  getTradingAdvice: (side: string, mode: string) => string;
  getChartImageHtml: (symbol: string) => string;
  sendTelegramMessage: (msg: string) => Promise<any>;
  streamEmitter: { emit: (event: string, ...args: any[]) => boolean };
  log400: (route: string, msg: string) => void;
}

export function createPaperTradeRouter(ctx: PaperTradeRouterContext): Router {
  const router = express.Router();

  // GET /api/paper-trade
  router.get('/paper-trade', (req: Request, res: Response) => {
    const rawTrades = ctx.getVirtualTrades();
    const seenIds = new Set<string>();
    const deduplicatedTrades = rawTrades.filter(t => {
      if (!t || !t.id) return true;
      if (seenIds.has(t.id)) return false;
      seenIds.add(t.id);
      return true;
    });

    res.json({
      success: true,
      data: deduplicatedTrades,
      balance: ctx.getVirtualBalance(),
      startOfDayBalance: ctx.getStartOfDayBalance(),
      startOfDayRealBalance: ctx.getStartOfDayRealBalance(),
      startOfWeekBalance: ctx.getStartOfWeekBalance()
    });
  });

  // GET /api/analytics/directional-stats - Раздельная статистика LONG / SHORT и скоринг агентов
  router.get('/analytics/directional-stats', (req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades();
      const report = DirectionalMemoryAnalyticsService.generateSplitMemoryReport(trades);
      res.json({
        success: true,
        report
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || e });
    }
  });

  // GET /api/analytics/decision-traces - Получение трассировок решений
  router.get('/analytics/decision-traces', (req: Request, res: Response) => {
    try {
      const trades = ctx.getVirtualTrades();
      const traces = trades
        .filter(t => t.decisionTrace)
        .map(t => ({
          tradeId: t.id,
          symbol: t.symbol,
          side: t.side,
          status: t.status,
          pnl: t.pnl,
          openTime: t.openTime,
          decisionTrace: t.decisionTrace
        }));
      res.json({
        success: true,
        traces,
        total: traces.length
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || e });
    }
  });

  // GET /api/analytics/signal-performance - Data Collection & Performance Monitoring
  router.get('/analytics/signal-performance', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const trades = ctx.getVirtualTrades() || [];
      const activeSignals = ctx.getSignalsData() || [];
      const rawOrigin = req.query.origin;
      const originParam = typeof rawOrigin === 'string' ? rawOrigin : 'OUT_OF_SAMPLE';
      const validOrigins = ['OUT_OF_SAMPLE', 'ALL', 'HISTORICAL_SEED', 'LIVE_WEEX', 'PAPER_SIM'];
      const originFilter = validOrigins.includes(originParam) ? originParam as any : 'OUT_OF_SAMPLE';

      const report = SignalPerformanceAnalyticsService.generatePerformanceReport(trades, activeSignals, originFilter);
      return res.json({
        success: true,
        report
      });
    } catch (e: any) {
      console.error('[ANALYTICS] Error generating performance report:', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // GET /api/paper-trade/balance
  router.get('/paper-trade/balance', (req: Request, res: Response) => {
    res.json({
      success: true,
      balance: ctx.getVirtualBalance(),
      startOfDayBalance: ctx.getStartOfDayBalance(),
      startOfDayRealBalance: ctx.getStartOfDayRealBalance(),
      startOfWeekBalance: ctx.getStartOfWeekBalance()
    });
  });

  // POST /api/paper-trade/reset-circuit-breaker
  router.post('/paper-trade/reset-circuit-breaker', (req: Request, res: Response) => {
    ctx.setIsCircuitBreakerActive(false);
    const curBal = ctx.getVirtualBalance();
    ctx.setStartOfDayBalance(curBal);
    ctx.setStartOfWeekBalance(curBal);
    ctx.setStartOfDayRealBalance(0);
    ctx.saveBalanceDB();
    console.log(`[CIRCUIT BREAKER] 🟢 MANUALLY RESET by user request. New reference balance: $${curBal.toFixed(2)}`);
    res.json({
      success: true,
      message: 'Торговый предохранитель успешно сброшен!',
      balance: curBal,
      startOfDayBalance: curBal,
      startOfDayRealBalance: 0,
      startOfWeekBalance: curBal,
      isCircuitBreakerActive: false
    });
  });

  // POST /api/paper-trade/balance/topup
  router.post('/paper-trade/balance/topup', (req: Request, res: Response) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
    const newBal = ctx.getVirtualBalance() + amount;
    ctx.setVirtualBalance(newBal);
    ctx.saveBalanceDB();
    res.json({ success: true, balance: newBal });
  });

  // POST /api/paper-trade/balance/update
  router.post('/paper-trade/balance/update', (req: Request, res: Response) => {
    const { amount, closeActiveTrades } = req.body;
    console.log(`[BALANCE UPDATE] Request received to update virtual balance to $${amount}, closeActiveTrades=${closeActiveTrades}`);
    if (typeof amount !== 'number' || isNaN(amount) || amount < 0) {
      return res.status(400).json({ success: false, error: 'Invalid balance amount' });
    }

    if (closeActiveTrades) {
      const virtualTrades = ctx.getVirtualTrades();
      const tradesToClose = virtualTrades.filter(t => t.status === 'OPEN' && !t.isReal);
      console.log(`[BALANCE UPDATE] Found ${tradesToClose.length} active virtual trades to close.`);
      const globalCcxt = ctx.getGlobalCcxtTickers();
      const binanceTickers = globalCcxt.binance || {};
      const mexcTickers = globalCcxt.mexc || {};

      for (const trade of tradesToClose) {
        const ticker = ctx.findTickerInMap(trade.symbol, binanceTickers) || ctx.findTickerInMap(trade.symbol, mexcTickers);
        let actualClosePrice = ticker?.last || ticker?.price || ticker?.close || 0;
        
        if (actualClosePrice <= 0) {
          actualClosePrice = trade.entryPrice;
        }
        
        trade.status = 'CLOSED'; 
        trade.closeTime = Date.now(); 
        trade.closePrice = actualClosePrice; 
        trade.feedback = 'BREAKEVEN'; 
        trade.notes = 'Сделка принудительно закрыта при смене виртуального баланса';
        trade.aiEvaluation = 'Авто-закрытие при изменении баланса';
        
        if (!trade.history) trade.history = [];
        trade.history.push({ time: Date.now(), type: 'CLOSE', price: actualClosePrice, amount: trade.amount });

        const { pnlUsd } = ctx.getUnifiedTradeClosePnl(trade.side, trade.entryPrice, actualClosePrice, trade.amount, trade.leverage);

        trade.pnl = pnlUsd;
        trade.pnlPercent = (trade.pnl / trade.amount) * 100;
        (trade as any).outcome = trade.pnlPercent > 0 ? 1 : 0;

        console.log(`[BALANCE UPDATE] Closing trade ID ${trade.id} (${trade.symbol}) at $${actualClosePrice}, PnL: $${pnlUsd.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)`);
        ctx.saveTradeDB(trade);
      }
    }

    ctx.setVirtualBalance(amount);
    ctx.setStartOfDayBalance(amount);
    ctx.setStartOfWeekBalance(amount);
    ctx.saveBalanceDB();
    ctx.streamEmitter.emit('signals_updated');
    console.log(`[BALANCE UPDATE] 🟢 MANUALLY UPDATED (closeActiveTrades=${!!closeActiveTrades}) by user request to: $${amount.toFixed(2)}`);
    res.json({ success: true, balance: amount, startOfDayBalance: amount, startOfWeekBalance: amount });
  });

  // POST /api/paper-trade/start-balance
  router.post('/paper-trade/start-balance', (req: Request, res: Response) => {
    const { amount } = req.body;
    if (typeof amount === 'number' && amount >= 0) {
      ctx.setStartOfDayBalance(amount);
      ctx.saveBalanceDB();
      res.json({ success: true, startOfDayBalance: amount });
    } else {
      res.status(400).json({ success: false, error: 'Invalid amount' });
    }
  });

  // POST /api/paper-trade/start-balance-real
  router.post('/paper-trade/start-balance-real', (req: Request, res: Response) => {
    const { amount } = req.body;
    if (typeof amount === 'number' && amount >= 0) {
      ctx.setStartOfDayRealBalance(amount);
      ctx.saveBalanceDB();
      res.json({ success: true, startOfDayRealBalance: amount });
    } else {
      res.status(400).json({ success: false, error: 'Invalid amount' });
    }
  });

  // POST /api/paper-trade/open
  router.post('/paper-trade/open', async (req: Request, res: Response) => {
    let { symbol, exchange, entryPrice, amount, leverage, side, signalAiScore, mode, takeProfit, stopLoss, gridOrders, isAutoLearning, isReal } = req.body;
    if (isReal) {
      isAutoLearning = false;
    }
    
    if (ctx.getIsCircuitBreakerActive() && isReal) {
      return res.status(400).json({ success: false, error: 'Внимание: Торговый предохранитель (Circuit Breaker) активирован! Реальная торговля заблокирована до следующего дня.' });
    }

    const isBtcShockLock = (Date.now() - ctx.getLastBtcShockTime()) < (15 * 60 * 1000);
    if (isBtcShockLock) {
      return res.status(400).json({ success: false, error: 'Бумажная торговля приостановлена: зафиксирован резкий импульс BTC (Режим тишины). Входы заблокированы на 15 минут.' });
    }
    
    if (!symbol) {
      ctx.log400('/api/paper-trade/open', 'Missing required field: symbol');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const validation = ctx.validatePaperTradeInput({ entryPrice, amount, leverage, side, takeProfit, stopLoss });
    if (!validation.valid) {
      ctx.log400('/api/paper-trade/open', validation.error || 'Validation error');
      return res.status(400).json({ success: false, error: validation.error });
    }

    entryPrice = validation.value.entryPrice;
    amount = validation.value.amount;
    leverage = validation.value.leverage;
    side = validation.value.side;
    if (validation.value.takeProfit !== undefined) takeProfit = validation.value.takeProfit;
    if (validation.value.stopLoss !== undefined) stopLoss = validation.value.stopLoss;

    const normalizedSymbol = ctx.normalizeSymbol(symbol);
    if (!ctx.acquireExecutionLock(normalizedSymbol)) {
       console.warn(`[EXECUTION LOCK] Concurrent order placement blocked for ${normalizedSymbol}`);
       return res.status(429).json({ success: false, error: 'Данный инструмент сейчас обрабатывается другой транзакцией. Пожалуйста, повторите попытку.' });
    }

    try {
      let finalAmount = amount;
      let finalLeverage = leverage;
      let finalGridOrders = gridOrders;

      if (isReal) {
        finalAmount = Math.max(20, amount || 0);
        finalLeverage = Math.max(5, leverage || 0);
        if (gridOrders && gridOrders.length > 0 && amount > 0) {
          const scaleRatio = finalAmount / amount;
          finalGridOrders = gridOrders.map((g: any) => ({
            ...g,
            amount: Number((g.amount * scaleRatio).toFixed(1))
          }));
        }
      }

      console.log(`[DEBUG] Attempting to open trade: ${symbol} (${side}), entry: ${entryPrice}, amount: ${finalAmount}`);

      if (!entryPrice || !finalAmount) {
        ctx.log400('/api/paper-trade/open', `Missing fields: sym=${symbol}, entry=${entryPrice}, amt=${finalAmount}`);
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }
      if (finalAmount <= 0 || finalLeverage <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid margin or leverage value' });
      }

      const requiredMargin = Number((finalAmount / Math.max(1, Number(finalLeverage || 1))).toFixed(2));
      const currentBalance = ctx.getVirtualBalance();
      if (!isAutoLearning && !isReal && requiredMargin > currentBalance) {
        console.log(`[DEBUG] Trade rejected: Insufficient balance. Need margin ${requiredMargin} (Amount ${finalAmount} / Lev ${finalLeverage}), have ${currentBalance}`);
        ctx.log400('/api/paper-trade/open', `Insufficient: margin=${requiredMargin}, bal=${currentBalance}`);
        return res.status(400).json({ success: false, error: `Недостаточно средств. Требуемая маржа: $${requiredMargin.toFixed(2)}, ваш баланс: $${currentBalance.toFixed(2)}` });
      }
      
      const virtualTrades = ctx.getVirtualTrades();
      const openVirtualTrades = virtualTrades.filter(t => t.status === 'OPEN' && (t as any).isAutoLearning === isAutoLearning);
      const globalSettings = ctx.getGlobalSettings();

      // Жесткое ограничение: максимум 6 одновременно открытых сделок во всей системе
      const maxPositionsAllowed = Math.min(6, (globalSettings as any)?.maxActivePositionsVirtual ?? 6);
      if (openVirtualTrades.length >= maxPositionsAllowed) {
        console.warn(`[PAPER-TRADE] Rejecting trade for ${symbol}: global open positions limit reached (${openVirtualTrades.length}/${maxPositionsAllowed})`);
        return res.status(400).json({
          success: false,
          error: `Достигнут максимальный лимит одновременно открытых сделок (${openVirtualTrades.length}/${maxPositionsAllowed}). Разрешено не более 6.`
        });
      }

      // Балансировка очередей: максимум 3 сделки в одном направлении (LONG / SHORT) для исключения перекоса
      const requestedSide = (side || 'SHORT').toUpperCase();
      const sameDirectionCount = openVirtualTrades.filter(t => t.side === requestedSide).length;
      const maxSameDirAllowed = Math.min(3, (globalSettings as any)?.maxSameDirectionPositions ?? 3);
      if (sameDirectionCount >= maxSameDirAllowed) {
        console.warn(`[PAPER-TRADE] Rejecting trade for ${symbol}: directional limit reached (${sameDirectionCount}/${maxSameDirAllowed} for ${requestedSide})`);
        return res.status(400).json({
          success: false,
          error: `Достигнут лимит позиций в направлении ${requestedSide} (${sameDirectionCount}/${maxSameDirAllowed}). Не более 3 в одном направлении.`
        });
      }

      const existingTrade = virtualTrades.find(t => {
         const tNorm = ctx.normalizeSymbol(t.symbol);
         return t.status === 'OPEN' && tNorm === normalizedSymbol && (t as any).isAutoLearning === isAutoLearning;
      });
      if (existingTrade) {
         console.warn(`[PAPER-TRADE] Rejecting duplicate trade for ${normalizedSymbol}. ID: ${existingTrade.id}`);
         return res.status(400).json({ success: false, error: `Сделка по ${symbol} уже открыта` });
      }

      const recentlyClosed = virtualTrades.find(t => {
         const tNorm = ctx.normalizeSymbol(t.symbol);
         return tNorm === normalizedSymbol && t.status === 'CLOSED' && (Date.now() - (t.closeTime || 0) < 120000) && (t as any).isAutoLearning === isAutoLearning;
      });
      if (recentlyClosed && (mode === 'AUTO' || mode === 'SEMI_AUTO')) {
         console.warn(`[PAPER-TRADE] Anti-churn: Rejecting re-opening for ${normalizedSymbol} (too soon)`);
         return res.status(400).json({ success: false, error: `Защита от частых сделок: Подождите 2 минуты перед повторным открытием ${symbol}` });
      }

      const tradeId = `VT-${Date.now()}-${Math.floor(Math.random() * 100000).toString(36).toUpperCase()}`;
      const existingSignal = ctx.getSignalsData().find((s: any) => s.symbol === symbol.replace('/', ''));
      
      let finalEntryPrice = entryPrice;
      if (isReal) {
        const config = ctx.getGlobalSettings().exchangeApiConfig;
        if (config && config.isEnabled) {
           console.log(`[REAL MANUAL OPEN] Triggering live position open for ${symbol} on exchange ${exchange}...`);
           const resOpen = await ctx.executeRealOpenOnExchange(symbol, side || 'SHORT', finalAmount, finalLeverage, stopLoss, takeProfit);
           if (resOpen && resOpen.success) {
              if (resOpen.entryPrice) {
                 finalEntryPrice = resOpen.entryPrice;
              }
           } else {
              return res.status(400).json({ success: false, error: `Не удалось запустить сделку на бирже: ${resOpen.error || 'Ошибка исполнения ордера'}.` });
           }
        } else {
           return res.status(400).json({ success: false, error: 'Выбран режим реального счета, но API биржи выключено или не настроено в настройках!' });
        }
      } else {
         const signalVol = existingSignal?.volatility || 2.0;
         let slippagePercent = Math.min(0.0015, 0.0005 * (1 + Math.max(0, signalVol - 2.0) * 0.15));
         
         let realBookSpread = 0;
         const wsTickers = ctx.getWsTickers();
         for (const exKey of ['Binance', 'Bybit', 'Weex']) {
           const t = ctx.findTickerInMap(symbol, wsTickers[exKey]);
           if (t && t.bid > 0 && t.ask > 0) {
             const spread = (t.ask - t.bid) / t.bid;
             if (spread > 0 && spread < 0.005) {
               realBookSpread = spread;
               break;
             }
           }
         }
         
         if (realBookSpread > slippagePercent) {
            slippagePercent = Math.min(0.0035, realBookSpread);
         }
         
         if (side === 'SHORT') {
            finalEntryPrice = Number((finalEntryPrice * (1 - slippagePercent)).toFixed(5));
         } else {
            finalEntryPrice = Number((finalEntryPrice * (1 + slippagePercent)).toFixed(5));
         }
      }

      let updatedBalance = ctx.getVirtualBalance();
      if (!isAutoLearning && !isReal) {
        if (requiredMargin <= updatedBalance) {
           updatedBalance = Number((updatedBalance - requiredMargin).toFixed(2));
           ctx.setVirtualBalance(updatedBalance);
        } else {
           console.log(`[MANUAL OPEN] Virtual Balance too low to deduct ($${updatedBalance.toFixed(2)}), keeping open status.`);
        }
        ctx.saveBalanceDB();
      }

      const newTrade: any = {
        id: tradeId,
        symbol,
        exchange,
        entryPrice: finalEntryPrice,
        amount: finalAmount,
        initialAmount: finalAmount,
        margin: requiredMargin,
        initialMargin: requiredMargin,
        leverage: finalLeverage,
        side: side || 'SHORT',
        status: 'OPEN',
        openTime: Date.now(),
        signalAiScore: signalAiScore || 0,
        history: [{ time: Date.now(), type: 'OPEN', price: finalEntryPrice, amount: finalAmount, margin: requiredMargin }],
        mode: mode || 'MANUAL',
        takeProfit,
        stopLoss,
        gridOrders: finalGridOrders,
        isReal: isReal || false
      };
      newTrade.correlationId = tradeId;
      newTrade.dataOrigin = isReal ? 'LIVE' : (isAutoLearning ? 'PAPER' : 'PAPER');
      newTrade.decisionSource = mode === 'AUTO' ? 'AUTOPILOT_CANONICAL' : 'MANUAL';
      newTrade.strategyId = 'CANONICAL_QUANT_SCALP_V2';
      newTrade.strategyVersion = '2.1.0';
      newTrade.stateRevision = ctx.getAtomicStoreRevision();
      if (isAutoLearning) {
        newTrade.isAutoLearning = true;
      }
      if (existingSignal && existingSignal.features) {
         newTrade.features = existingSignal.features;
         newTrade.betaSnapshot = { ...ctx.getModelWeights() };
      }

      virtualTrades.push(newTrade);
      ctx.saveTradeDB(newTrade);
      console.log(`[PAPER-TRADE] Opened trade ${tradeId} for ${symbol}`);
      res.json({ success: true, data: newTrade, balance: ctx.getVirtualBalance() });
      
      setTimeout(() => {
        if (mode === 'AUTO' && isReal) {
          const exLink = ctx.getExchangeLink(exchange, symbol);
          const advice = ctx.getTradingAdvice(side || 'SHORT', 'Auto-Pilot');
          const chart = ctx.getChartImageHtml(symbol);
          ctx.sendTelegramMessage(`${chart}🤖 <b>Auto-Pilot: Opened Trade</b>\n\nSymbol: ${symbol}\nSide: ${side || 'SHORT'}\nEntry: $${entryPrice}\nMargin: $${amount}\nLeverage: ${leverage || 1}x\n\n🔗 <a href="${exLink}">Перейти к сделке</a>\n\n${advice}`);
        }
        ctx.streamEmitter.emit('signals_updated');
      }, 100);

    } finally {
      ctx.releaseExecutionLock(normalizedSymbol);
    }
  });

  // POST /api/paper-trade/close
  router.post('/api/paper-trade/close', (req: Request, res: Response) => {
    handleTradeClose(req, res, ctx);
  });
  // Also handle without prefix if router is mounted at /api
  router.post('/paper-trade/close', (req: Request, res: Response) => {
    handleTradeClose(req, res, ctx);
  });

  // POST /api/paper-trade/mode
  router.post('/paper-trade/mode', (req: Request, res: Response) => {
    const { id, mode } = req.body;
    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    trade.mode = mode;
    ctx.saveTradeDB(trade);
    res.json({ success: true, data: trade });
  });

  // POST /api/paper-trade/leverage
  router.post('/paper-trade/leverage', (req: Request, res: Response) => {
    const { id, leverage } = req.body;
    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    if (trade.status === 'CLOSED') return res.status(400).json({ success: false, error: 'Trade already closed' });
    trade.leverage = leverage;
    ctx.saveTradeDB(trade);
    ctx.streamEmitter.emit('signals_updated');
    res.json({ success: true, data: trade });
  });

  // POST /api/paper-trade/average
  router.post('/paper-trade/average', (req: Request, res: Response) => {
    const { id, price, amount, isGrid } = req.body;
    const virtualTrades = ctx.getVirtualTrades();
    const trade = virtualTrades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    if (trade.status === 'CLOSED') return res.status(400).json({ success: false, error: 'Trade already closed' });
    
    const finalPrice = price || 0;
    if (finalPrice <= 0) {
      ctx.log400('/api/paper-trade/average', `Invalid price for ${trade.symbol}: ${price}`);
      return res.status(400).json({ success: false, error: 'Invalid average price' });
    }

    if (!amount || amount <= 0) {
      ctx.log400('/api/paper-trade/average', `Invalid amount for ${trade.symbol}: ${amount}`);
      return res.status(400).json({ success: false, error: 'Invalid average amount' });
    }

    const tradeLeverage = Math.max(1, Number(trade.leverage || 1));
    const requiredDcaMargin = Number((amount / tradeLeverage).toFixed(2));
    const curBal = ctx.getVirtualBalance();
    if (!(trade as any).isAutoLearning && requiredDcaMargin > curBal) {
      return res.status(400).json({ success: false, error: `Недостаточно средств. Требуемая маржа: $${requiredDcaMargin.toFixed(2)}, ваш баланс: $${curBal.toFixed(2)}` });
    }
    
    if (!(trade as any).isAutoLearning) {
      ctx.setVirtualBalance(Number((curBal - requiredDcaMargin).toFixed(2)));
      ctx.saveBalanceDB();
    }
    const currentCoins = trade.amount / trade.entryPrice;
    const newCoins = amount / finalPrice;
    const totalMargin = trade.amount + amount;
    const totalCoins = currentCoins + newCoins;
    trade.entryPrice = totalMargin / totalCoins;
    trade.amount = totalMargin;
    trade.margin = Number(((trade.margin || (trade.amount / tradeLeverage)) + requiredDcaMargin).toFixed(2));
    trade.initialMargin = trade.margin;
    if (!trade.history) trade.history = [];
    trade.history.push({ time: Date.now(), type: 'AVERAGE', price: finalPrice, amount, margin: requiredDcaMargin });
    if (isGrid && trade.gridOrders) {
      const pendingGrid = trade.gridOrders.find((g: any) => !g.executed && ((trade.side === 'SHORT' && finalPrice >= g.price) || (trade.side === 'LONG' && finalPrice <= g.price)));
      if (pendingGrid) pendingGrid.executed = true;
      if (trade.isReal) {
        ctx.sendTelegramMessage(`🤖 <b>AI Manager: Executed DCA</b>\n\nSymbol: ${trade.symbol}\nPrice: $${finalPrice}\nAmount: $${amount}`);
      }
    }
    ctx.saveTradeDB(trade);
    res.json({ success: true, data: trade });
  });

  return router;
}

function handleTradeClose(req: Request, res: Response, ctx: PaperTradeRouterContext) {
  const { id, closePrice, feedback, notes, aiEvaluation } = req.body;
  
  if (!id) {
    ctx.log400('/api/paper-trade/close', 'Missing trade ID');
    return res.status(400).json({ success: false, error: 'Missing trade ID' });
  }

  const virtualTrades = ctx.getVirtualTrades();
  const trade = virtualTrades.find(t => t.id === id);
  if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
  
  if (trade.status === 'CLOSED') {
    if (aiEvaluation) {
      trade.aiEvaluation = aiEvaluation;
      ctx.saveTradeDB(trade);
      ctx.streamEmitter.emit('signals_updated');
      return res.json({ success: true, data: trade, balance: ctx.getVirtualBalance() });
    }
    ctx.log400('/api/paper-trade/close', `Trade already closed: ${id}`);
    return res.status(400).json({ success: false, error: 'Trade already closed' });
  }

  const finalClosePrice = closePrice || 0;
  let actualClosePrice = finalClosePrice;

  if (actualClosePrice <= 0) {
    const symbolClean = ctx.normalizeSymbol(trade.symbol);
    const globalCcxt = ctx.getGlobalCcxtTickers();
    const fallbackPrice = globalCcxt.binance?.[symbolClean]?.last || 0;
    if (fallbackPrice > 0) {
       actualClosePrice = fallbackPrice;
       ctx.log400('/api/paper-trade/close', `Close price missing for ${trade.symbol}, using fallback: ${fallbackPrice}`);
    } else {
       actualClosePrice = trade.entryPrice;
       ctx.log400('/api/paper-trade/close', `Close price is invalid for ${trade.symbol}: ${closePrice}. Falling back to entryPrice ${trade.entryPrice}`);
    }
  }
  
  trade.status = 'CLOSED'; 
  trade.closeTime = Date.now(); 
  trade.closePrice = actualClosePrice; 
  trade.feedback = feedback; 
  trade.notes = notes;
  
  if (aiEvaluation) trade.aiEvaluation = aiEvaluation;
  if (!trade.history) trade.history = [];
  
  trade.history.push({ time: Date.now(), type: 'CLOSE', price: actualClosePrice, amount: trade.amount });
  
  const { pnlUsd } = ctx.getUnifiedTradeClosePnl(trade.side, trade.entryPrice, actualClosePrice, trade.amount, trade.leverage);
  
  trade.pnl = pnlUsd;
  trade.pnlPercent = (trade.pnl / trade.amount) * 100;
  (trade as any).outcome = trade.pnlPercent > 0 ? 1 : 0;
  if (!(trade as any).isAutoLearning && !trade.isReal) {
    const tradeMargin = (trade as any).margin || (trade as any).initialMargin || (trade.amount ? trade.amount / (trade.leverage || 1) : 0);
    const newBal = Number((ctx.getVirtualBalance() + tradeMargin + trade.pnl).toFixed(2));
    ctx.setVirtualBalance(newBal);
    ctx.saveBalanceDB();
  }
  
  ctx.saveTradeDB(trade);
  if (notes && notes.includes('Auto-closed') && trade.isReal) {
    ctx.sendTelegramMessage(`🤖 <b>AI Manager: Closed Trade</b>\n\nSymbol: ${trade.symbol}\nSide: ${trade.side}\nExit: $${closePrice}\nPnL: ${trade.pnl > 0 ? '+' : ''}${trade.pnl?.toFixed(2)} USDT\nReason: ${notes}`);
  }
  ctx.streamEmitter.emit('signals_updated');
  res.json({ success: true, data: trade, balance: ctx.getVirtualBalance() });
}
