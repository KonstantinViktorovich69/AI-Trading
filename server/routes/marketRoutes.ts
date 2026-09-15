import express from 'express';
import type { Request, Response, Router } from 'express';
import { calculateSMA, calculateEMA, calculateRSI } from '../quant.ts';

export interface MarketRouterContext {
  getSignalsCache: () => any;
  getMarketPulse: () => any;
  getSocialSentiment: () => any;
  getIsCircuitBreakerActive: () => boolean;
  getLastBtcShockTime: () => number;
  getFundingRates: () => Record<string, number>;
  getGlobalCcxtTickers: () => Record<string, any>;
  getWsTickers: () => Record<string, any>;
  getCcxtExchanges: () => Record<string, any>;
  getOhlcvCache: () => Record<string, { data: any[]; timestamp: number }>;
  getGlobalSettings: () => any;
  getIsBinanceGeoblocked: () => boolean;
  setIsBinanceGeoblocked: (val: boolean) => void;
  getRestBlockedExchanges: () => Set<string>;
  log400?: (path: string, error: string) => void;
}

export function createMarketRouter(ctx: MarketRouterContext): Router {
  const router = express.Router();

  // GET /api/search
  router.get('/search', (req: Request, res: Response) => {
    const qStr = req.query.q as string;
    if (!qStr || qStr.length < 1) return res.json({ success: true, data: [] });
    const q = qStr.toLowerCase().trim();
    const qClean = q.replace(/[^a-z0-9]/gi, '');

    const results: any[] = [];
    const added = new Set<string>();

    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    const wsTickers = ctx.getWsTickers();

    // Restrict search strictly to WEEX as requested by user
    const exchanges = ['weex'];
    for (const ex of exchanges) {
      const listCCXT = GLOBAL_CCXT_TICKERS[ex] || {};
      
      // Also include WS tickers
      const exCapitalized = ex.charAt(0).toUpperCase() + ex.slice(1);
      const listWS = (wsTickers as any)[exCapitalized] || {};
      
      const allKeys = new Set([...Object.keys(listCCXT), ...Object.keys(listWS)]);

      for (const sym of allKeys) {
        const symLower = sym.toLowerCase();
        const symCleanAll = symLower.replace(/[^a-z0-9]/gi, '');
        const baseCoin = sym.split(/[\/:\-_]/)[0].toLowerCase();
        const baseCoinClean = baseCoin.replace(/[^a-z0-9]/gi, '');

        // Exact base match ("m"), exact symbol match ("musdt"), or starts with
        const isMatch = baseCoinClean === qClean || 
                        baseCoinClean.startsWith(qClean) ||
                        symCleanAll === qClean || 
                        symCleanAll.startsWith(qClean) || 
                        symCleanAll.startsWith(qClean + 'usdt') ||
                        symLower.includes(q);
                        
        if (!isMatch) continue;

        const t1 = listCCXT[sym];
        const t2 = listWS[sym];
        const t = t1 || t2;
        if (!t) continue;
        
        const clean = sym.replace(/[\/:]/g, '').toUpperCase();
        const targetExchange = `${clean}:${ex}`;
        if (!added.has(targetExchange)) {
          added.add(targetExchange);
          
          const price = t.last || t.close || t.bid || (t.askQty ? t.ask : 0) || parseFloat(t.price || 0) || 0;
          if (price <= 0) {
            continue;
          }

          const volume = t.quoteVolume || t.baseVolume || parseFloat(t.vol || t.v || 0) || 0;
          const pct = t.percentage || parseFloat(t.change || 0) || 0;

          results.push({
            symbol: t.symbol || sym,
            rawSymbol: sym,
            coin: (t.symbol || sym).split(/[\/:\-_]/)[0] || sym,
            exchange: ex,
            price: price,
            change24h: pct,
            volume: volume,
            type: '🔍 РЫНОК', // "MARKET" signal type
            signal: 'MANUAL',
            riskLevel: 'UNKNOWN',
            aiScore: 0,
          });
        }
      }
    }

    try {
      // Sort by exact match first, then volume descending
      results.sort((a, b) => {
        if (!a || !b) return 0;
        const aClean = (a.symbol || '').toString().replace(/[^a-z0-9]/gi, '').toLowerCase();
        const bClean = (b.symbol || '').toString().replace(/[^a-z0-9]/gi, '').toLowerCase();
        const aCoin = (a.coin || '').toString().replace(/[^a-z0-9]/gi, '').toLowerCase();
        const bCoin = (b.coin || '').toString().replace(/[^a-z0-9]/gi, '').toLowerCase();
        
        const qCoin = qClean.endsWith('usdt') ? qClean.replace(/usdt$/, '') : qClean;

        const aExact = aClean === qClean || aClean === qClean + 'usdt' || aCoin === qClean || aCoin === qCoin;
        const bExact = bClean === qClean || bClean === qClean + 'usdt' || bCoin === qClean || bCoin === qCoin;
        
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        
        const volA = Number(a.volume) || 0;
        const volB = Number(b.volume) || 0;
        return volB - volA;
      });
    } catch (err: any) {
      console.error("Search sort error:", err);
    }
    
    // Dedup
    const dedupResults: any[] = [];
    const symbolSet = new Set<string>();
    for (const r of results) {
      if (!r) continue;
      const pureSym = r.symbol ? r.symbol.toString().replace(/[\/:\-_]/g, '').toUpperCase() : '';
      if (pureSym && !symbolSet.has(pureSym)) {
        symbolSet.add(pureSym);
        dedupResults.push(r);
      }
    }

    return res.json({ success: true, data: dedupResults.slice(0, 50) });
  });

  // GET /api/signals
  router.get('/signals', (req: Request, res: Response) => {
    const signalsCache = ctx.getSignalsCache();
    const lastBtcShockTime = ctx.getLastBtcShockTime();
    res.json({ 
      success: true, 
      data: signalsCache?.data || [], 
      marketRegime: signalsCache?.marketRegime || 'NEUTRAL',
      regimeDetails: signalsCache?.regimeDetails,
      marketHealth: signalsCache?.marketHealth,
      marketPulse: ctx.getMarketPulse(),
      socialSentiment: ctx.getSocialSentiment(),
      isCircuitBreakerActive: ctx.getIsCircuitBreakerActive(),
      isBtcShockLock: (Date.now() - lastBtcShockTime) < (15 * 60 * 1000),
      btcShockRemainingSeconds: Math.max(0, Math.ceil((15 * 60 * 1000 - (Date.now() - lastBtcShockTime)) / 1000))
    });
  });

  // GET /api/funding-arbitrage
  router.get('/funding-arbitrage', (req: Request, res: Response) => {
    try {
      const opportunities: any[] = [];
      const signalsCache = ctx.getSignalsCache();
      const signals = signalsCache?.data || [];
      const fundingRates = ctx.getFundingRates();
      
      for (const [key, rate] of Object.entries<number>(fundingRates)) {
        if (!rate || isNaN(rate) || Math.abs(rate) < 0.0001) continue;
        
        const cleanSymbol = key.replace(/[\/:]/g, '').toUpperCase();
        const sig = signals.find((s: any) => s.symbol === cleanSymbol || s.symbol === key);
        const price = sig?.price || sig?.close || 1.0;
        const volume24h = sig?.volume24h || sig?.volume || 100000;
        
        const fundingRateDecimal = Number(rate);
        const fundingRateApy = Math.abs(fundingRateDecimal) * 3 * 365 * 100;
        const dailyYieldPct = Math.abs(fundingRateDecimal) * 3 * 100;
        const dailyYieldUsd10k = (10000 * dailyYieldPct) / 100;
        
        let strategyType = 'DELTA_NEUTRAL_SPOT_SHORT';
        let strategyName = 'Спот Покупка + Шорт 1x';
        let riskLevel = 'LOW';
        let aiRecommendation = 'Дельта-нейтральный сбор комиссии с покупателей без направленного риска.';

        if (fundingRateDecimal < -0.0005) {
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

  // GET /api/market/all-tickers
  router.get('/market/all-tickers', (req: Request, res: Response) => {
    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    const result: Record<string, any[]> = {};
    const weexTickers = GLOBAL_CCXT_TICKERS['weex'] || {};
    const array: any[] = [];
    for (const rawSymbol in weexTickers) {
      const t = weexTickers[rawSymbol];
      const cleanSym = rawSymbol.replace(/:.*$/, '').replace('/', '');
      const base = rawSymbol.split('/')[0] || '';
      const quote = rawSymbol.split('/')[1]?.split(':')[0] || '';
      
      array.push({
        rawSymbol,
        symbol: cleanSym,
        base,
        quote,
        price: t.last ?? t.close ?? t.bid ?? 0,
        change24h: t.percentage ?? t.percentageChange ?? 0,
        high: t.high ?? 0,
        low: t.low ?? 0,
        volume: t.quoteVolume ?? t.volume ?? 0,
        baseVolume: t.baseVolume ?? 0
      });
    }
    result['weex'] = array;
    res.json({ success: true, exchanges: result });
  });

  // GET /api/market/indicator-summary
  router.get('/market/indicator-summary', async (req: Request, res: Response) => {
    const { exchange, symbol, tf } = req.query;
    if (!symbol) {
      return res.status(400).json({ success: false, error: 'Symbol is required' });
    }
    const globalSettings = ctx.getGlobalSettings();
    let exName = (exchange as string)?.toLowerCase() || 'weex';
    if (exName === 'real') {
      const config = globalSettings.exchangeApiConfig;
      exName = (config && config.isEnabled && config.exchange) ? config.exchange.toLowerCase() : 'weex';
    }
    const timeframe = (tf as string) || '15m';

    const ccxtExchanges = ctx.getCcxtExchanges();
    const ex = ccxtExchanges[exName];
    if (!ex) {
      return res.status(404).json({ success: false, error: `Exchange ${exName} not found` });
    }

    try {
      let realSymbol = symbol as string;
      if (!realSymbol.includes('/')) {
        const matches = realSymbol.match(/^([A-Z0-9]+)(USDT)$/);
        if (matches) realSymbol = `${matches[1]}/${matches[2]}`;
        else if (!realSymbol.includes(':')) realSymbol = realSymbol + '/USDT'; 
      }
      if (exName === 'mexc' && !realSymbol.includes(':') && realSymbol.includes('/')) {
        realSymbol += ':USDT';
      }

      if (ex.markets && !ex.markets[realSymbol]) {
        const bases = realSymbol.split(':');
        const withoutColon = bases[0];
        const withColon = withoutColon.includes('/') ? `${withoutColon}:USDT` : `${withoutColon}/USDT:USDT`;
        if (ex.markets[withColon]) realSymbol = withColon;
        else if (ex.markets[withoutColon]) realSymbol = withoutColon;
      }

      const cacheKey = `${exName}_${realSymbol.replace(/[\/:]/g, '_')}_${timeframe}`;
      let ohlcv: any[] = [];
      const ohlcvCache = ctx.getOhlcvCache();
      
      if (ohlcvCache[cacheKey] && (Date.now() - ohlcvCache[cacheKey].timestamp < 60000)) {
        ohlcv = ohlcvCache[cacheKey].data;
      } else {
        ohlcv = await ex.fetchOHLCV(realSymbol, timeframe, undefined, 100);
        ohlcvCache[cacheKey] = { data: ohlcv, timestamp: Date.now() };
      }

      if (!ohlcv || ohlcv.length === 0) {
        return res.status(404).json({ success: false, error: 'OHLCV data could not be fetched for technical summary.' });
      }

      const closes = ohlcv.map(x => x[4]);
      const highs = ohlcv.map(x => x[2]);
      const lows = ohlcv.map(x => x[3]);
      const currentPrice = closes[closes.length - 1];

      const rsiValues = calculateRSI(closes, 14);
      const sma20 = calculateSMA(closes, 20);
      const ema20 = calculateEMA(closes, 20);

      const rsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
      const sma = sma20.length > 0 ? sma20[sma20.length - 1] : currentPrice;
      const ema = ema20.length > 0 ? ema20[ema20.length - 1] : currentPrice;

      let score = 0;
      if (rsi > 70) score -= 3;
      else if (rsi > 60) score -= 1;
      else if (rsi < 30) score += 3;
      else if (rsi < 40) score += 1;

      if (currentPrice > ema) score += 2;
      else score -= 2;

      if (currentPrice > sma) score += 2;
      else score -= 2;

      const recentHighs = highs.slice(-10);
      const recentLows = lows.slice(-10);
      const localResistance = Math.max(...recentHighs);
      const localSupport = Math.min(...recentLows);

      let recommendation = 'NEUTRAL';
      if (score >= 6) recommendation = 'STRONG BUY';
      else if (score >= 2) recommendation = 'BUY';
      else if (score <= -6) recommendation = 'STRONG SELL';
      else if (score <= -2) recommendation = 'SELL';

      res.json({
        success: true,
        symbol: realSymbol,
        price: currentPrice,
        rsi: Number(rsi.toFixed(2)),
        sma20: Number(sma.toFixed(5)),
        ema20: Number(ema.toFixed(5)),
        score,
        recommendation,
        support: localSupport,
        resistance: localResistance
      });

    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/ticker
  router.get('/ticker', (req: Request, res: Response) => {
    const { symbol, exchange } = req.query;
    if (!symbol) {
      if (ctx.log400) ctx.log400('/api/ticker', 'Symbol is required');
      return res.status(400).json({ success: false, error: 'Symbol is required' });
    }
    const globalSettings = ctx.getGlobalSettings();
    let exName = (exchange as string)?.toLowerCase() || 'weex';
    if (exName === 'real') {
      const config = globalSettings.exchangeApiConfig;
      exName = (config && config.isEnabled && config.exchange) ? config.exchange.toLowerCase() : 'weex';
    }
    const GLOBAL_CCXT_TICKERS = ctx.getGlobalCcxtTickers();
    if (GLOBAL_CCXT_TICKERS[exName]) {
      const searchSym = (symbol as string).toUpperCase();
      const ccxtSymbol = Object.keys(GLOBAL_CCXT_TICKERS[exName]).find(s => {
        const normalized = s.replace('/', '').replace(/:.*$/, '');
        return normalized === searchSym;
      });
      if (ccxtSymbol && GLOBAL_CCXT_TICKERS[exName][ccxtSymbol]) {
        const ticker = GLOBAL_CCXT_TICKERS[exName][ccxtSymbol];
        return res.json({ success: true, price: ticker.last || ticker.close || ticker.bid });
      }
    }
    const wsTickers = ctx.getWsTickers();
    if (exName === 'binance' && wsTickers.Binance) {
      const wsTicker = Object.values(wsTickers.Binance).find((t: any) => t.pair === symbol);
      if (wsTicker) return res.json({ success: true, price: (wsTicker as any).bid });
    }

    // Server-side fallback directly from exchange API
    const cleanSym = (symbol as string).replace('/', '').replace(':', '').split('_')[0].toUpperCase();
    const isBinanceGeoblocked = ctx.getIsBinanceGeoblocked();
    const restBlockedExchanges = ctx.getRestBlockedExchanges();

    if (exName === 'binance' && !isBinanceGeoblocked) {
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`)
        .then(bRes => {
          if (bRes.status === 451) {
            ctx.setIsBinanceGeoblocked(true);
            restBlockedExchanges.add('binance');
            throw new Error('Binance API is restricted in this location (451)');
          }
          return bRes.json();
        })
        .then(bData => {
          if (bData && bData.price) {
            res.json({ success: true, price: parseFloat(bData.price) });
          } else {
            // Fallback to MEXC
            fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${cleanSym}`)
              .then(mRes => mRes.json())
              .then(mData => {
                if (mData && mData.price) res.json({ success: true, price: parseFloat(mData.price) });
                else res.status(404).json({ success: false, error: 'Ticker not found' });
              })
              .catch(() => res.status(404).json({ success: false, error: 'Ticker not found' }));
          }
        })
        .catch(() => {
          // Fallback to MEXC
          fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${cleanSym}`)
            .then(mRes => mRes.json())
            .then(mData => {
              if (mData && mData.price) res.json({ success: true, price: parseFloat(mData.price) });
              else res.status(404).json({ success: false, error: 'Ticker not found' });
            })
            .catch(() => res.status(500).json({ success: false, error: 'Failed to fetch ticker' }));
        });
      return;
    } else if (exName === 'mexc' || (exName === 'binance' && isBinanceGeoblocked)) {
      fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${cleanSym}`)
        .then(mRes => mRes.json())
        .then(mData => {
          if (mData && mData.price) {
            res.json({ success: true, price: parseFloat(mData.price) });
          } else {
            res.status(404).json({ success: false, error: 'Ticker not found on MEXC' });
          }
        })
        .catch(err => {
          res.status(500).json({ success: false, error: `Failed to fetch from MEXC on server: ${err.message}` });
        });
      return;
    }

    res.status(404).json({ success: false, error: 'Ticker not found' });
  });

  return router;
}
