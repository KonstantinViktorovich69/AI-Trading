import express from 'express';
import type { Request, Response, Router } from 'express';

export interface StreamRouterContext {
  getSignalsCache: () => any;
  getMarketPulse: () => any;
  getSocialSentiment: () => any;
  getVirtualTrades: () => any[];
  getVirtualBalance: () => number;
  getProlivPeaks: () => any[];
  getAgentExchangeLogs: () => any[];
  getCachedDB: () => any;
  getWsTickers: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, any>;
  findTickerInMap: (sym: string, map: any) => any;
  streamEmitter: {
    on: (event: string, listener: (...args: any[]) => void) => any;
    off: (event: string, listener: (...args: any[]) => void) => any;
    emit: (event: string, ...args: any[]) => boolean;
  };
  getFundingRates: () => Record<string, number>;
  isFetchingGlobalTickers?: () => boolean;
  updateGlobalTickers?: () => void;
  historyData?: Record<string, any[]>;
  globalTrueOhlcv?: Record<string, any>;
  serverStartTime?: number;
  getStartOfDayBalance?: () => number;
  getStartOfDayRealBalance?: () => number;
  getStartOfWeekBalance?: () => number;
}

export function createStreamRouter(ctx: StreamRouterContext): Router {
  const router = express.Router();

  // GET /api/stream
  router.get('/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastDataHash = '';
    let lastFullSendTime = 0;

    const sendData = (force = false) => {
      const virtualTrades = ctx.getVirtualTrades();
      const dbDataForSse = ctx.getCachedDB();
      const signalsCache = ctx.getSignalsCache();
      const data = {
        signals: signalsCache?.data || [],
        marketHealth: signalsCache?.marketHealth || 50,
        marketPulse: ctx.getMarketPulse(),
        socialSentiment: ctx.getSocialSentiment(),
        marketRegime: signalsCache?.marketRegime || 'FLAT',
        btcTrend24h: signalsCache?.btcTrend24h || 0,
        paperTrades: virtualTrades,
        balance: ctx.getVirtualBalance(),
        startOfDayBalance: ctx.getStartOfDayBalance ? ctx.getStartOfDayBalance() : undefined,
        startOfDayRealBalance: ctx.getStartOfDayRealBalance ? ctx.getStartOfDayRealBalance() : undefined,
        startOfWeekBalance: ctx.getStartOfWeekBalance ? ctx.getStartOfWeekBalance() : undefined,
        prolivPeaks: ctx.getProlivPeaks(),
        retrospectiveMemory: dbDataForSse.retrospectiveMemory || [],
        agentExchangeLogs: ctx.getAgentExchangeLogs()
      };

      // Оптимизация трафика: сравниваем быструю сигнатуру состояния, чтобы не забивать VPN дубликатами
      const sigsCount = data.signals.length;
      const topSig = data.signals[0] ? `${data.signals[0].symbol}_${data.signals[0].price}_${data.signals[0].aiScore}` : '';
      const openTradesCount = virtualTrades.filter((t: any) => t.status === 'OPEN').length;
      const curHash = `${sigsCount}_${topSig}_${openTradesCount}_${data.balance}_${data.marketHealth}_${data.prolivPeaks.length}`;
      const now = Date.now();

      if (!force && curHash === lastDataHash && (now - lastFullSendTime < 10000)) {
        // Данные не изменились — отправляем легковесный heartbeat вместо повторного 500 КБ JSON
        res.write(`event: heartbeat\ndata: {"ts":${now}}\n\n`);
        return;
      }

      lastDataHash = curHash;
      lastFullSendTime = now;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendData(true);

    const onUpdate = () => sendData(false);
    ctx.streamEmitter.on('signals_updated', onUpdate);

    // Heartbeat каждые 3 секунды с отправкой события 'heartbeat' для моментального обнаружения обрыва VPN на клиенте
    const fallbackPing = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
        res.write(': ping\n\n');
      } catch (err) {
        // соединение прервано
      }
    }, 3000);

    req.on('close', () => {
      ctx.streamEmitter.off('signals_updated', onUpdate);
      clearInterval(fallbackPing);
    });
  });

  // GET /api/stream/prices
  router.get('/stream/prices', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastSentPrices: Record<string, number> = {};
    let lastPriceSendTime = 0;

    const sendPrices = (forceAll = false) => {
      const now = Date.now();
      // Троттлинг: отправка цен не чаще чем раз в 300 мс для защиты от переполнения сокета VPN
      if (!forceAll && (now - lastPriceSendTime < 300)) {
        return;
      }

      const prices: Record<string, number> = {};
      const symbolsToInclude = new Set<string>();

      ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].forEach(s => symbolsToInclude.add(s));

      const virtualTrades = ctx.getVirtualTrades();
      virtualTrades.filter(t => t.status === 'OPEN').forEach(t => symbolsToInclude.add(t.symbol));

      const signalsCache = ctx.getSignalsCache();
      if (signalsCache?.data) {
        signalsCache.data.slice(0, 50).forEach((s: any) => symbolsToInclude.add(s.symbol));
      }

      const cleanSymbolsToInclude = new Set<string>();
      symbolsToInclude.forEach(s => {
        cleanSymbolsToInclude.add(s.replace(/[\/:]/g, ''));
        cleanSymbolsToInclude.add(s);
      });

      const wsTickers = ctx.getWsTickers();
      for (const ex in wsTickers) {
        if (!wsTickers[ex]) continue;
        Object.values(wsTickers[ex]).forEach((t: any) => {
          const tPure = t.pair.replace(/[\/:]/g, '').toUpperCase();
          if (symbolsToInclude.has(t.pair) || cleanSymbolsToInclude.has(tPure)) {
            const lastPrice = t.last || t.bid || t.close;
            if (lastPrice) {
              prices[t.pair] = lastPrice;
              prices[tPure] = lastPrice;
              const base = t.pair.split('/')[0].toUpperCase();
              const quote = t.pair.split('/')[1]?.split(':')[0].toUpperCase();
              if (base && quote) prices[`${base}/${quote}`] = lastPrice;
            }
          }
        });
      }

      const globalCcxt = ctx.getGlobalCcxtTickers();
      symbolsToInclude.forEach(sym => {
        const symPure = sym.replace(/[\/:]/g, '');
        if (prices[sym] || prices[symPure]) return;
        for (const ex in globalCcxt) {
          const tick = ctx.findTickerInMap(sym, globalCcxt[ex]);
          if (tick) {
            const p = tick.last || tick.close || tick.bid;
            if (p) {
              prices[sym] = p;
              prices[symPure] = p;
              break;
            }
          }
        }
      });

      // Передаем дельту изменившихся цен или полный пакет раз в 10 секунд / при подключении
      const deltaPrices: Record<string, number> = {};
      let hasChanges = false;
      const isPeriodicFull = (now - lastPriceSendTime >= 10000);

      for (const [k, v] of Object.entries(prices)) {
        if (forceAll || isPeriodicFull || lastSentPrices[k] !== v) {
          deltaPrices[k] = v;
          hasChanges = true;
        }
      }

      if (hasChanges) {
        lastSentPrices = { ...lastSentPrices, ...prices };
        lastPriceSendTime = now;
        res.write(`data: ${JSON.stringify(deltaPrices)}\n\n`);
      }
    };

    sendPrices(true);

    const onPriceUpdate = () => sendPrices(false);
    ctx.streamEmitter.on('prices_updated', onPriceUpdate);

    // Heartbeat каждые 3 секунды с явным SSE-событием
    const fallbackPing = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
        res.write(': ping\n\n');
      } catch (err) {
        // сокет закрыт
      }
    }, 3000);

    req.on('close', () => {
      ctx.streamEmitter.off('prices_updated', onPriceUpdate);
      clearInterval(fallbackPing);
    });
  });

  // GET /api/debug/state
  router.get('/debug/state', (req: Request, res: Response) => {
    const globalCcxt = ctx.getGlobalCcxtTickers();
    const signalsCache = ctx.getSignalsCache();
    const weexKeys = Object.keys(globalCcxt).filter(k => k === 'weex');
    const activeExchanges = weexKeys.length > 0 ? weexKeys : ['weex'];
    res.json({
      exchanges: activeExchanges,
      tickerCounts: activeExchanges.map(ex => ({ ex, count: Object.keys(globalCcxt[ex] || {}).length })),
      ohlcvCount: ctx.globalTrueOhlcv ? Object.keys(ctx.globalTrueOhlcv).length : 0,
      signalsCount: signalsCache?.data?.length || 0,
      virtualBalance: ctx.getVirtualBalance(),
      isFetchingTickers: ctx.isFetchingGlobalTickers ? ctx.isFetchingGlobalTickers() : false,
      serverUptime: ctx.serverStartTime ? (Date.now() - ctx.serverStartTime) / 1000 : 0
    });
  });

  // POST /api/sync
  router.post('/sync', (req: Request, res: Response) => {
    if (ctx.updateGlobalTickers) {
      console.log('[API] Manual sync requested');
      ctx.updateGlobalTickers();
    }
    res.json({ success: true, message: 'Sync started' });
  });

  // GET /api/debug/cache
  router.get('/debug/cache', (req: Request, res: Response) => {
    const globalCcxt = ctx.getGlobalCcxtTickers();
    const signalsCache = ctx.getSignalsCache();
    const weexKeys = Object.keys(globalCcxt).filter(k => k === 'weex');
    const activeExchanges = weexKeys.length > 0 ? weexKeys : ['weex'];
    res.json({
      exchanges: activeExchanges,
      counts: activeExchanges.reduce((acc: any, ex: string) => {
        acc[ex] = Object.keys(globalCcxt[ex] || {}).length;
        return acc;
      }, {}),
      historyCount: ctx.historyData ? Object.keys(ctx.historyData).length : 0,
      indicatorsCount: ctx.globalTrueOhlcv ? Object.keys(ctx.globalTrueOhlcv).length : 0,
      signalsCount: signalsCache?.data?.length || 0,
      nonNeutral: signalsCache?.data?.filter((s: any) => s.signal !== 'NEUTRAL').length || 0
    });
  });

  // GET /api/funding-arbitrage/opportunities
  router.get('/funding-arbitrage/opportunities', (req: Request, res: Response) => {
    try {
      const opportunities: any[] = [];
      const fundingRates = ctx.getFundingRates();
      const signalsCache = ctx.getSignalsCache();
      const signals = signalsCache?.data || [];

      for (const [symbolKey, rate] of Object.entries(fundingRates)) {
        const cleanSymbol = symbolKey.replace(/[\/:]/g, '').toUpperCase();
        const fundingRateDecimal = Number(rate);
        const fundingRatePercent = fundingRateDecimal * 100;
        const fundingRateApy = fundingRateDecimal * 3 * 365 * 100;
        const dailyYieldPct = fundingRateDecimal * 3 * 100;
        const dailyYieldUsd10k = (10000 * dailyYieldPct) / 100;

        const sig = signals.find((s: any) => s.symbol === cleanSymbol);
        const price = sig?.price || 1.0;
        const volume24h = sig?.volume || 500000;

        let strategyType = 'DELTA_NEUTRAL_SPOT_SHORT';
        let strategyName = 'Delta-Neutral Spot + Short';
        let riskLevel = 'LOW';
        let aiRecommendation = 'Стабильный положительный фандинг. Фарминг выплат шортом с хеджем на споте.';

        if (fundingRateDecimal < -0.001) {
          strategyType = 'FUNDING_SQUEEZE_LONG';
          strategyName = 'Short Squeeze (Лонг 1x-2x)';
          riskLevel = 'MEDIUM';
          aiRecommendation = 'Отрицательный фандинг. Ожидается сквиз шортистов + получение выплат от продавцов.';
        } else if (fundingRateApy > 100) {
          strategyType = 'HIGH_YIELD_FARM';
          strategyName = 'Агрессивный Фарминг (Spot/Short)';
          riskLevel = 'LOW';
          aiRecommendation = 'Сверхвысокая процентная ставка APY (>100%). Идеально для удержания от 24ч.';
        }

        opportunities.push({
          symbol: cleanSymbol,
          exchange: sig?.exchange || 'weex',
          fundingRate: fundingRateDecimal,
          fundingRateApy,
          dailyYieldPct,
          dailyYieldUsd10k,
          strategyType,
          strategyName,
          riskLevel,
          netYield8h: Math.abs(fundingRateDecimal) * 100 - 0.07,
          minHoldingHours: 8,
          aiRecommendation,
          price,
          volume24h
        });
      }

      opportunities.sort((a, b) => b.fundingRateApy - a.fundingRateApy);

      res.json({
        success: true,
        count: opportunities.length,
        opportunities: opportunities.slice(0, 50)
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/funding-arbitrage/execute
  router.post('/funding-arbitrage/execute', (req: Request, res: Response) => {
    try {
      const { symbol, capital = 1000, leverage = 1, strategyType = 'DELTA_NEUTRAL_SPOT_SHORT' } = req.body;
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'Symbol is required' });
      }

      const cleanSymbol = symbol.replace(/[\/:]/g, '').toUpperCase();
      const fundingRates = ctx.getFundingRates();
      const rate = fundingRates[cleanSymbol] || 0.0015;
      const signalsCache = ctx.getSignalsCache();
      const signals = signalsCache?.data || [];
      const sig = signals.find((s: any) => s.symbol === cleanSymbol);
      const entryPrice = sig?.price || 100.0;

      const side = strategyType === 'FUNDING_SQUEEZE_LONG' ? 'LONG' : 'SHORT';
      const virtualBalance = ctx.getVirtualBalance();
      const newTrade = {
        id: `FT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        symbol: cleanSymbol,
        exchange: sig?.exchange || 'weex',
        entryPrice,
        amount: Math.min(capital, virtualBalance),
        leverage,
        side,
        status: 'OPEN',
        openTime: Date.now(),
        signalAiScore: 95,
        history: [{ time: Date.now(), type: 'OPEN', price: entryPrice, amount: Math.min(capital, virtualBalance) }],
        mode: 'FUNDING_FARM',
        isFundingFarm: true,
        fundingRateHarvest: rate,
        takeProfit: side === 'LONG' ? entryPrice * 1.05 : entryPrice * 0.95,
        stopLoss: side === 'LONG' ? entryPrice * 0.93 : entryPrice * 1.07,
        userId: 'polyakovats3110@gmail.com'
      };

      const virtualTrades = ctx.getVirtualTrades();
      virtualTrades.unshift(newTrade as any);

      res.json({
        success: true,
        message: `Фарминг фандинга по ${cleanSymbol} успешно запущен`,
        trade: newTrade
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
