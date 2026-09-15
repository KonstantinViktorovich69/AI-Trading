import express from 'express';
import type { Request, Response, Router } from 'express';
import ccxt from 'ccxt';

export interface RealTradeRouterContext {
  getGlobalSettings: () => any;
  getVirtualTrades: () => any[];
  saveTradeDB: (trade: any) => void;
  sendTelegramMessage: (msg: string) => Promise<any>;
  sendTelegramTestMessage: (botToken: string, chatId: string) => Promise<{ success: boolean; error?: string }>;
  enrichExchangeError: (error: any) => string;
  getCcxtClient: (config: any) => any;
  getUnifiedTradeClosePnl: (side: string, entryPrice: number, closePrice: number, amount: number, leverage: number) => { pnlUsd: number; pnlPercent: number };
  findTickerInMap: (sym: string, map: any) => any;
  getWsTickers: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, any>;
  WEEX_HEADERS?: Record<string, string>;
  getTradeSyncAttempts: () => Map<string, number>;
  getRealPositionsCache: () => { data: any[]; lastUpdated: number };
  setRealPositionsCache: (cache: { data: any[]; lastUpdated: number }) => void;
  isRealTradingAllowed?: () => boolean;
  executeRealOpenOnExchange?: (symbol: string, side: string, amount: number, leverage: number, stopLoss?: number, takeProfit?: number) => Promise<any>;
  executeWithRetry?: <T>(fn: () => Promise<T>, opName?: string, retries?: number, delay?: number) => Promise<T>;
  formatFuturesSymbol?: (symbol: string, exchange?: string) => string;
}

export function createRealTradeRouter(ctx: RealTradeRouterContext): Router {
  const router = express.Router();

  const isAllowed = () => {
    if (ctx.isRealTradingAllowed) return ctx.isRealTradingAllowed();
    if (process.env.OFFLINE_MODE === '1' || process.env.TEST_MODE === '1') return false;
    return process.env.ENABLE_REAL_TRADING === 'true';
  };

  // POST /api/real-trade/open
  router.post('/real-trade/open', async (req: Request, res: Response) => {
    if (!isAllowed()) {
      return res.status(403).json({
        success: false,
        error: 'Real trading is disabled by ENABLE_REAL_TRADING guard (set ENABLE_REAL_TRADING=true in environment)'
      });
    }
    const { symbol, side, amount, leverage, stopLoss, takeProfit } = req.body;
    if (!symbol || !amount) {
      return res.status(400).json({ success: false, error: 'Symbol and amount are required' });
    }

    // Жесткое ограничение для реальной торговли: не более 6 открытых сделок и не более 3 в одном направлении
    const openRealTrades = ctx.getVirtualTrades().filter(t => t.status === 'OPEN' && t.isReal);
    const globalSettings = ctx.getGlobalSettings();
    const maxRealAllowed = Math.min(6, globalSettings?.maxActivePositionsReal ?? 6);
    if (openRealTrades.length >= maxRealAllowed) {
      return res.status(400).json({
        success: false,
        error: `Достигнут максимальный лимит открытых реальных сделок (${openRealTrades.length}/${maxRealAllowed}). Разрешено не более 6.`
      });
    }

    const reqSide = (side || 'SHORT').toUpperCase();
    const sameDirRealCount = openRealTrades.filter(t => t.side === reqSide).length;
    const maxSameReal = Math.min(3, globalSettings?.maxSameDirectionPositions ?? 3);
    if (sameDirRealCount >= maxSameReal) {
      return res.status(400).json({
        success: false,
        error: `Достигнут лимит реальных позиций в направлении ${reqSide} (${sameDirRealCount}/${maxSameReal}). Не более 3 в одном направлении.`
      });
    }
    if (ctx.executeRealOpenOnExchange) {
      const result = await ctx.executeRealOpenOnExchange(symbol, side || 'SHORT', amount, leverage || 1, stopLoss, takeProfit);
      if (!result.success) {
        return res.status(400).json(result);
      }
      return res.json(result);
    }
    res.status(500).json({ success: false, error: 'executeRealOpenOnExchange not configured in context' });
  });

  // POST /api/real-trade/close
  router.post('/real-trade/close', async (req: Request, res: Response) => {
    if (!isAllowed()) {
      return res.status(403).json({
        success: false,
        error: 'Real trading is disabled by ENABLE_REAL_TRADING guard (set ENABLE_REAL_TRADING=true in environment)'
      });
    }
    const { symbol, side, amount } = req.body;
    if (!symbol) {
      return res.status(400).json({ success: false, error: 'Symbol is required' });
    }
    const config = ctx.getGlobalSettings().exchangeApiConfig;
    if (!config || !config.isEnabled) {
      return res.status(400).json({ success: false, error: 'Exchange API is not configured or disabled' });
    }
    const client = ctx.getCcxtClient(config);
    if (!client) {
      return res.status(400).json({ success: false, error: 'Failed to initialize exchange client' });
    }
    const formatSym = ctx.formatFuturesSymbol || ((s: string) => s);
    const formattedSymbol = formatSym(symbol, config.exchange);
    const closeSide = (side === 'BUY' || side === 'LONG' || side === 'buy' || side === 'long') ? 'sell' : 'buy';
    try {
      const execRetry = ctx.executeWithRetry || (async (fn: any) => fn());
      const order = await execRetry(
        () => client.createOrder(formattedSymbol, 'market', closeSide, amount, undefined, { reduceOnly: true }),
        `realTradeClose for ${formattedSymbol}`
      );
      res.json({ success: true, data: order });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Error closing position on exchange' });
    }
  });

  // POST /api/settings/telegram/test
  router.post('/settings/telegram/test', async (req: Request, res: Response) => {
    const { botToken, chatId } = req.body;
    const result = await ctx.sendTelegramTestMessage(botToken, chatId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  });

  // POST /api/settings/exchange/test
  router.post('/settings/exchange/test', async (req: Request, res: Response) => {
    const exchange = req.body.exchange;
    const apiKey = req.body.apiKey?.trim();
    const apiSecret = req.body.apiSecret?.trim();
    const password = req.body.password?.trim();
    try {
      if (exchange === 'mexc' && apiKey && apiKey.toLowerCase().includes('weex')) {
        return res.json({ success: false, error: 'Вы выбрали биржу MEXC, но используете ключи от WEEX. Пожалуйста, выберите WEEX в списке бирж выше.' });
      }
      if (!(ccxt.pro as any)[exchange] && !(ccxt as any)[exchange]) {
        return res.json({ success: false, error: 'Биржа не поддерживается' });
      }
      const exClass = (ccxt.pro as any)[exchange] || (ccxt as any)[exchange];
      const defaultOptions = { defaultType: exchange === 'weex' ? 'swap' : 'future' };
      const client = new exClass({
        apiKey,
        secret: apiSecret,
        password,
        enableRateLimit: true,
        options: defaultOptions,
        headers: exchange === 'weex' ? ctx.WEEX_HEADERS : undefined
      });
      
      // Check balance to verify auth
      await client.fetchBalance({ type: defaultOptions.defaultType });
      
      res.json({ success: true, message: 'Успешное подключение к бирже' });
    } catch (error) {
      res.json({ success: false, error: ctx.enrichExchangeError(error) });
    }
  });

  // GET /api/exchange/balance
  router.get('/exchange/balance', async (req: Request, res: Response) => {
    try {
      const globalSettings = ctx.getGlobalSettings();
      const config = globalSettings.exchangeApiConfig;
      if (!config || !config.isEnabled || !config.apiKey) {
        return res.status(400).json({ success: false, error: 'API биржи не настроено' });
      }
      const exClass = (ccxt as any)[config.exchange] as typeof ccxt.Exchange;
      if (!exClass) return res.status(400).json({ success: false, error: 'Invalid exchange' });
      
      const typesToCheck: string[] = [];
      if (config.exchange === 'weex') {
        typesToCheck.push('swap', 'future', 'spot');
      } else if (config.exchange === 'bybit') {
        typesToCheck.push('future', 'swap', 'unified', 'spot', 'funding');
      } else if (config.exchange === 'mexc') {
        typesToCheck.push('swap', 'future', 'spot');
      } else {
        typesToCheck.push('future', 'swap', 'spot', 'margin');
      }

      let maxUsdt = 0;
      let balanceTypeUsed = 'unknown';

      for (const type of typesToCheck) {
        try {
          const client = new exClass({
            apiKey: config.apiKey,
            secret: config.apiSecret,
            password: config.password,
            enableRateLimit: true,
            options: { defaultType: type },
            headers: config.exchange === 'weex' ? ctx.WEEX_HEADERS : undefined
          });
          const balance = await client.fetchBalance();
          const anyBalance = balance as any;
          const usdt = anyBalance.USDT?.total || anyBalance.total?.USDT || 0;
          const numUsdt = parseFloat(String(usdt));
          if (!isNaN(numUsdt) && numUsdt > maxUsdt) {
            maxUsdt = numUsdt;
            balanceTypeUsed = type;
          }
        } catch (err) {
          // Suppress individual account type errors
        }
      }

      if (maxUsdt === 0) {
        try {
          const defaultOptions = { defaultType: config.exchange === 'weex' ? 'swap' : 'future' };
          const client = new exClass({
            apiKey: config.apiKey,
            secret: config.apiSecret,
            password: config.password,
            enableRateLimit: true,
            options: defaultOptions,
            headers: config.exchange === 'weex' ? ctx.WEEX_HEADERS : undefined
          });
          const balance = await client.fetchBalance({ type: defaultOptions.defaultType });
          const anyBalance = balance as any;
          const usdt = anyBalance.USDT?.total || anyBalance.total?.USDT || 0;
          const numUsdt = parseFloat(String(usdt));
          if (!isNaN(numUsdt) && numUsdt > 0) {
            maxUsdt = numUsdt;
            balanceTypeUsed = defaultOptions.defaultType;
          }
        } catch (fallbackErr) {
          // Soft logging
        }
      }

      res.json({ success: true, balance: maxUsdt, type: balanceTypeUsed });
    } catch (e: any) {
      res.status(500).json({ success: false, error: ctx.enrichExchangeError(e) });
    }
  });

  // GET /api/real-trade/positions
  router.get('/real-trade/positions', async (req: Request, res: Response) => {
    try {
      const globalSettings = ctx.getGlobalSettings();
      const config = globalSettings.exchangeApiConfig;
      if (!config || !config.isEnabled || !config.apiKey) {
        return res.status(400).json({ success: false, error: 'API биржи не настроено' });
      }

      const realPositionsCache = ctx.getRealPositionsCache();
      // Server-side cache to protect client from exceeding aggressive exchange rate limits (e.g. 429 errors from Weex)
      if (Date.now() - realPositionsCache.lastUpdated < 3000 && realPositionsCache.data.length > 0) {
        return res.json({ success: true, data: realPositionsCache.data, cached: true });
      }

      const client = ctx.getCcxtClient(config);
      if (!client) return res.status(400).json({ success: false, error: 'Не удалось инициализировать CCXT клиент' });
      
      // Fetch active positions
      const positions = await client.fetchPositions();
      const activePositions = positions.filter((p: any) => p.contracts && p.contracts > 0);
      
      // Fetch open trigger orders to locate active StopLoss/TakeProfit orders
      let openOrders: any[] = [];
      try {
        if (activePositions.length > 0 && client.has['fetchOpenOrders']) {
          openOrders = await client.fetchOpenOrders().catch(() => []);
        }
      } catch (orderErr) {
        console.log('[REAL SYNC] Failed to fetch open orders for SL/TP syncing:', orderErr);
      }

      const normalize = (sym: string) => sym.replace(/[\/:]/g, '').toUpperCase();
      const virtualTrades = ctx.getVirtualTrades();
      
      activePositions.forEach((pos: any) => {
        // Find matching database trade (virtualTrades)
        let dbTrade = virtualTrades.find(t => t.status === 'OPEN' && t.isReal && normalize(t.symbol) === normalize(pos.symbol));
        
        const slPriceEx = parseFloat(pos.stopLoss || pos.info?.stopLoss || pos.info?.stopLossPrice || pos.info?.sl || pos.info?.slPrice || pos.info?.stopLossPricePoint || 0);
        const tpPriceEx = parseFloat(pos.takeProfit || pos.info?.takeProfit || pos.info?.takeProfitPrice || pos.info?.tp || pos.info?.tpPrice || pos.info?.takeProfitPricePoint || 0);
        
        const entryPrice = parseFloat(pos.entryPrice || pos.price || 0);
        const side = (pos.side === 'long' || pos.side === 'LONG' || pos.side === 'buy' || pos.side === 'BUY') ? 'LONG' : 'SHORT';
        
        let stopLossVal = slPriceEx > 0 ? slPriceEx : undefined;
        let takeProfitVal = tpPriceEx > 0 ? tpPriceEx : undefined;

        // Search open trigger orders for this position
        const symbolOrders = openOrders.filter((o: any) => normalize(o.symbol) === normalize(pos.symbol));
        symbolOrders.forEach((order: any) => {
          const triggerPrice = parseFloat(order.stopPrice || order.triggerPrice || order.price || order.info?.triggerPrice || order.info?.stopPrice || order.info?.stopPricePoint || order.info?.triggerPricePoint || 0);
          if (triggerPrice > 0 && entryPrice > 0) {
            if (side === 'SHORT') {
              if (triggerPrice > entryPrice) {
                stopLossVal = triggerPrice;
              } else if (triggerPrice < entryPrice) {
                takeProfitVal = triggerPrice;
              }
            } else if (side === 'LONG') {
              if (triggerPrice < entryPrice) {
                stopLossVal = triggerPrice;
              } else if (triggerPrice > entryPrice) {
                takeProfitVal = triggerPrice;
              }
            }
          }
        });

        if (!dbTrade) {
          // Check if a real trade for this symbol was CLOSED very recently (e.g., within 45 seconds) in virtualTrades.
          const recentlyClosedReal = virtualTrades.find(t => 
            t.status === 'CLOSED' && 
            t.isReal && 
            normalize(t.symbol) === normalize(pos.symbol) && 
            (Date.now() - (t.closeTime || 0) < 45000)
          );
          if (recentlyClosedReal) {
            console.log(`[REAL SYNC] Skipping duplicate shadow trade creation for ${pos.symbol} (closed ${(Date.now() - (recentlyClosedReal.closeTime || 0)) / 1000}s ago).`);
            return;
          }

          // Auto-create a shadow db trade in virtualTrades
          const leverageVal = parseFloat(pos.leverage) || 10;
          const amountVal = parseFloat(pos.initialMargin || pos.margin || 0) || ((parseFloat(pos.contracts || pos.amount || 0) * entryPrice) / leverageVal) || 10;
          
          const newTradeId = 'real-' + normalize(pos.symbol) + '-' + Date.now() + '-external';
          dbTrade = {
            id: newTradeId,
            symbol: pos.symbol,
            exchange: config.exchange || 'real',
            entryPrice: entryPrice,
            amount: amountVal,
            leverage: leverageVal,
            side: side,
            status: 'OPEN',
            openTime: pos.timestamp || Date.now(),
            mode: 'EXTERNAL',
            isReal: true,
            isExternal: true,
            isExchangeManual: true,
            signalAiScore: 0,
            stopLoss: stopLossVal,
            takeProfit: takeProfitVal,
            highestPrice: entryPrice,
            lowestPrice: entryPrice,
            history: [{ time: Date.now(), type: 'OPEN', price: entryPrice, amount: amountVal }]
          };
          
          dbTrade.initialAmount = amountVal;
          virtualTrades.push(dbTrade);
          console.log(`[REAL SYNC] Automatically created shadow record for external position ${pos.symbol} (${side}) with status OPEN`);
          ctx.saveTradeDB(dbTrade);
        } else {
          let updated = false;
          
          if (stopLossVal && dbTrade.stopLoss !== stopLossVal) {
            dbTrade.stopLoss = stopLossVal;
            updated = true;
          }
          if (takeProfitVal && dbTrade.takeProfit !== takeProfitVal) {
            dbTrade.takeProfit = takeProfitVal;
            updated = true;
          }
          
          if (updated) {
            ctx.saveTradeDB(dbTrade);
          }
        }
        
        // Inject synced database properties back into ccxt position object so the client UI receives them instantly!
        pos.id = dbTrade.id;
        pos.mode = dbTrade.mode;
        pos.stopLoss = dbTrade.stopLoss;
        pos.takeProfit = dbTrade.takeProfit;
        pos.isExternal = dbTrade.isExternal || dbTrade.isExchangeManual || dbTrade.mode === 'EXTERNAL' || false;
        pos.isExchangeManual = dbTrade.isExchangeManual || dbTrade.mode === 'EXTERNAL' || false;

        let posPercentage = parseFloat(pos.percentage);
        if (isNaN(posPercentage) || posPercentage === 0) {
          const unrealizedPnlVal = parseFloat(pos.unrealizedPnl || 0);
          const marginVal = parseFloat(pos.initialMargin || pos.margin || 0);
          if (marginVal > 0) {
            pos.percentage = (unrealizedPnlVal / marginVal) * 100;
          } else {
            pos.percentage = 0;
          }
        }
      });

      // Auto-sync database trades that might have been closed externally on the exchange
      const activeExchangeSymbols = new Set(activePositions.map((pos: any) => normalize(pos.symbol)));
      
      const dbOpenedRealTrades = virtualTrades.filter(t => 
        t.isReal && (
          (t.status === 'OPEN' && (Date.now() - t.openTime > 20000)) ||
          (t.status === 'CLOSED' && (t.pnlPercent === 0 || t.closePrice === t.entryPrice) && (Date.now() - (t.closeTime || t.openTime || 0) < 48 * 3600 * 1000))
        )
      );
      
      const tradeSyncAttempts = ctx.getTradeSyncAttempts();
      const wsTickers = ctx.getWsTickers();
      const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();

      for (const dbTrade of dbOpenedRealTrades) {
        const dbNorm = normalize(dbTrade.symbol);
        const isAlreadyClosedInDb = dbTrade.status === 'CLOSED';
        
        if (!activeExchangeSymbols.has(dbNorm) || isAlreadyClosedInDb) {
          const lastAttempt = tradeSyncAttempts.get(dbTrade.id) || 0;
          if (Date.now() - lastAttempt < 60000) {
            continue;
          }
          tradeSyncAttempts.set(dbTrade.id, Date.now());

          if (!isAlreadyClosedInDb) {
            console.log(`[REAL SYNC] Trade ${dbTrade.id} (${dbTrade.symbol}) is no longer active on the exchange. Closing it locally with real prices.`);
          } else {
            console.log(`[REAL SYNC] Healing previously zeroed closed trade ${dbTrade.id} (${dbTrade.symbol}).`);
          }
          
          let clPrice = dbTrade.closePrice || dbTrade.entryPrice;
          let foundActualValueFromExchange = false;

          // 1. Try to fetch user's trades for this symbol
          try {
            if (client.has['fetchMyTrades']) {
              const sinceTime = Math.max(dbTrade.openTime - 1800 * 1000, Date.now() - 48 * 3600 * 1000);
              const trades = await client.fetchMyTrades(dbTrade.symbol, sinceTime, 30).catch(() => []);
              if (trades && trades.length > 0) {
                const sortedTrades = [...trades].sort((a: any, b: any) => b.timestamp - a.timestamp);
                const closingSide = dbTrade.side === 'SHORT' ? 'buy' : 'sell';
                const closingTrade = sortedTrades.find((t: any) => t.side === closingSide);
                if (closingTrade && closingTrade.price > 0) {
                  clPrice = parseFloat(closingTrade.price);
                  foundActualValueFromExchange = true;
                  console.log(`[REAL SYNC] Found actual closing trade on exchange for ${dbTrade.symbol}. Close price: ${clPrice}`);
                }
              }
            }
          } catch (tradeErr: any) {
            console.log(`[REAL SYNC] fetchMyTrades failed for ${dbTrade.symbol}:`, tradeErr.message || tradeErr);
          }

          // 2. Try to fetch closed orders
          if (!foundActualValueFromExchange) {
            try {
              if (client.has['fetchClosedOrders']) {
                const sinceTime = Math.max(dbTrade.openTime - 1800 * 1000, Date.now() - 48 * 3600 * 1000);
                const closedOrders = await client.fetchClosedOrders(dbTrade.symbol, sinceTime, 30).catch(() => []);
                if (closedOrders && closedOrders.length > 0) {
                  const sortedOrders = [...closedOrders].sort((a: any, b: any) => b.timestamp - a.timestamp);
                  const closingSide = dbTrade.side === 'SHORT' ? 'buy' : 'sell';
                  const closeOrder = sortedOrders.find((o: any) => o.side === closingSide && (o.status === 'closed' || o.filled > 0));
                  if (closeOrder) {
                    const avgPrice = parseFloat(closeOrder.average || closeOrder.price || 0);
                    if (avgPrice > 0) {
                      clPrice = avgPrice;
                      foundActualValueFromExchange = true;
                      console.log(`[REAL SYNC] Found actual closed order on exchange for ${dbTrade.symbol}. Close price: ${clPrice}`);
                    }
                  }
                }
              }
            } catch (orderHistoryErr: any) {
              console.log(`[REAL SYNC] fetchClosedOrders failed for ${dbTrade.symbol}:`, orderHistoryErr.message || orderHistoryErr);
            }
          }

          // 3. Fall back to fetching ticker directly from CCXT
          if (!foundActualValueFromExchange) {
            try {
              const ticker = await client.fetchTicker(dbTrade.symbol).catch(() => null);
              if (ticker && ticker.last > 0) {
                clPrice = ticker.last;
                foundActualValueFromExchange = true;
                console.log(`[REAL SYNC] Fell back to Live fetchTicker price for closed position ${dbTrade.symbol}. Price: ${clPrice}`);
              }
            } catch (tickerErr: any) {
              console.log(`[REAL SYNC] fetchTicker fallback failed for ${dbTrade.symbol}:`, tickerErr.message || tickerErr);
            }
          }

          // 4. Try memory wsTickers
          if (!foundActualValueFromExchange) {
            const sym = dbTrade.symbol;
            for (const ex in wsTickers) {
              const t = ctx.findTickerInMap(sym, wsTickers[ex]);
              if (t && t.last > 0) {
                clPrice = t.last;
                foundActualValueFromExchange = true;
                break;
              }
            }
          }

          // 5. Try GLOBAL_CCXT_TICKERS
          if (!foundActualValueFromExchange) {
            const sym = dbTrade.symbol;
            for (const ex in GLOBAL_CCXT_TICKERS) {
              const t = ctx.findTickerInMap(sym, GLOBAL_CCXT_TICKERS[ex]);
              if (t && t.last > 0) {
                clPrice = t.last;
                foundActualValueFromExchange = true;
                break;
              }
            }
          }

          if (!isAlreadyClosedInDb || foundActualValueFromExchange || clPrice !== dbTrade.entryPrice) {
            const wasOpen = dbTrade.status === 'OPEN';
            dbTrade.status = 'CLOSED';
            if (wasOpen) {
              dbTrade.closeTime = Date.now();
            }
            dbTrade.closePrice = clPrice;
            
            if (!dbTrade.history) dbTrade.history = [];
            if (wasOpen) {
              dbTrade.history.push({ time: Date.now(), type: 'CLOSE', price: clPrice, amount: dbTrade.amount });
            }

            let totalPnlUsd = 0;
            const initialTradeAmount = dbTrade.initialAmount || dbTrade.amount;
            if (!dbTrade.initialAmount) {
              dbTrade.initialAmount = initialTradeAmount;
            }

            dbTrade.history.forEach((h: any) => {
              if (h.type === 'CLOSE') {
                const { pnlUsd } = ctx.getUnifiedTradeClosePnl(dbTrade.side, dbTrade.entryPrice, h.price, h.amount, dbTrade.leverage);
                totalPnlUsd += pnlUsd;
              }
            });

            const totalPnlPercent = initialTradeAmount > 0 ? (totalPnlUsd / initialTradeAmount) * 100 : 0;
            dbTrade.pnlPercent = totalPnlPercent;
            dbTrade.pnl = totalPnlUsd;
            dbTrade.feedback = totalPnlPercent > 0 ? 'SUCCESS' : (totalPnlPercent === 0 ? 'BREAKEVEN' : 'FAILED');
            dbTrade.closeReason = 'Закрыто внешне на бирже вручную или по ордеру СЛ/ТП';
            dbTrade.notes = dbTrade.closeReason;
            
            ctx.saveTradeDB(dbTrade);
            
            if (wasOpen) {
              ctx.sendTelegramMessage(
                `🔔 <b>Синхронизация закрытия сделки</b>\n\n` +
                `Монета: <b>${dbTrade.symbol.replace(/[\/:]/g, '')}</b> была закрыта вручную или по СЛ/ТП на самой бирже.\n` +
                `Терминал синхронизировал эту информацию и перевел сделку в архив.\n` +
                `Финансовый результат зафиксирован: <b>${totalPnlPercent > 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%</b> (Выход: $${clPrice.toFixed(5)})`
              ).catch(() => {});
            } else {
              console.log(`[REAL SYNC] Healed trade ${dbTrade.id} successfully. New close price: $${clPrice}, PnL: ${totalPnlPercent.toFixed(2)}%`);
            }
          }
        }
      }

      ctx.setRealPositionsCache({
        data: activePositions,
        lastUpdated: Date.now()
      });
      res.json({ success: true, data: activePositions });
    } catch (e: any) {
      res.status(500).json({ success: false, error: ctx.enrichExchangeError(e) });
    }
  });

  return router;
}
