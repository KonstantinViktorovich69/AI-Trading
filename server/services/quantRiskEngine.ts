export interface StructuredFilterMatchResult {
  matched: boolean;
  isPenalty: boolean;
  isBlock: boolean;
  isBonus: boolean;
  reason: string;
}

export interface QuantRiskEngineContext {
  getGlobalTrueOHLCV: () => Record<string, any>;
  getGlobalCcxtTickers: () => Record<string, Record<string, any>>;
  getWsTickers: () => Record<string, Record<string, any>>;
  getOrderBookImbalance: () => Record<string, { imbalance: number }>;
  getModelWeights: () => Record<string, number>;
  getAiKnowledgeBase: () => any[];
  getMarketPulse: () => { sentiment: string; bias: number; recommendation: string; lastUpdated: number; fomoIndex?: number };
  setMarketPulse: (pulse: { sentiment: string; bias: number; recommendation: string; lastUpdated: number; fomoIndex?: number }) => void;
  getSocialSentimentCache: () => Record<string, { score: number; mentions: number; lastScraped: number; trend: 'PUMP_HYPE' | 'NEUTRAL' | 'FADING'; sources: string[] }>;
  getSignalsCache: () => { data?: any[]; btcTrend24h?: number } | null;
  getGlobalLiquidations: () => Record<string, { shortsSq?: number; longsSq?: number }>;
  runAiGeneration?: (params: any) => Promise<any>;
  getMarketPulsePrompt?: (context: string, shortsSq: any, longsSq: any) => string;
  getSocialScraperPrompt?: (symbol: string, change: number, volume: number) => string;
  safeJsonParse: (json: string, fallback: any) => any;
}

/**
 * Проверка соответствия структурированного правила индикаторам рынка
 */
export function matchesStructuredFilter(
  rule: any,
  trueRsi: number,
  volumeSpike: number,
  marketBias: number,
  volatility?: number,
  obImbalance?: number,
  fomoIndex?: number,
  change24h?: number
): StructuredFilterMatchResult {
  if (!rule || !rule.filterIndicator || rule.filterIndicator === 'none') {
    return { matched: false, isPenalty: false, isBlock: false, isBonus: false, reason: '' };
  }

  let currentValue = 0;
  const ind = String(rule.filterIndicator).toLowerCase();
  if (ind === 'rsi') {
    currentValue = trueRsi;
  } else if (ind === 'volume' || ind === 'volume_spike' || ind === 'volumespike') {
    currentValue = volumeSpike;
  } else if (ind === 'trend' || ind === 'bias' || ind === 'bias_score' || ind === 'biasscore') {
    currentValue = marketBias;
  } else if (ind === 'volatility') {
    currentValue = volatility ?? 0;
  } else if (ind === 'ob_imbalance' || ind === 'imbalance' || ind === 'orderbook_imbalance') {
    currentValue = obImbalance ?? 0;
  } else if (ind === 'fomo' || ind === 'fomoindex' || ind === 'fomo_index') {
    currentValue = fomoIndex ?? 0;
  } else if (ind === 'change24h' || ind === 'change_24h') {
    currentValue = change24h ?? 0;
  } else {
    return { matched: false, isPenalty: false, isBlock: false, isBonus: false, reason: '' };
  }

  const condition = String(rule.filterCondition || 'gt').toLowerCase();
  const targetValue = Number(rule.filterValue);
  if (isNaN(targetValue)) {
    return { matched: false, isPenalty: false, isBlock: false, isBonus: false, reason: '' };
  }

  let isMatched = false;
  if (condition === 'gt') {
    isMatched = currentValue > targetValue;
  } else if (condition === 'gte') {
    isMatched = currentValue >= targetValue;
  } else if (condition === 'lt') {
    isMatched = currentValue < targetValue;
  } else if (condition === 'lte') {
    isMatched = currentValue <= targetValue;
  } else if (condition === 'eq') {
    isMatched = Math.abs(currentValue - targetValue) < 0.1;
  }

  if (isMatched) {
    const isPenalty = rule.filterAction === 'penalty' || (rule.impact !== undefined && rule.impact < 0);
    const isBlock = rule.filterAction === 'block';
    const isBonus = rule.filterAction === 'bonus' || (!isPenalty && !isBlock && (rule.impact !== undefined && rule.impact > 0));
    return {
      matched: true,
      isPenalty,
      isBlock,
      isBonus,
      reason: `Сработало правило [${rule.text}] для индикатора ${rule.filterIndicator} (${currentValue} ${condition} ${targetValue})`
    };
  }

  return { matched: false, isPenalty: false, isBlock: false, isBonus: false, reason: '' };
}

/**
 * Интеллектуальное извлечение числовых триггеров из текста правила базы знаний.
 */
export function inferStructuredFilterFromRule(rule: any): {
  filterIndicator: string;
  filterCondition: string;
  filterValue: number;
  filterAction: string;
} | null {
  if (!rule || typeof rule !== 'object') return null;

  if (rule.filterIndicator && rule.filterIndicator !== 'none' && typeof rule.filterValue === 'number') {
    return {
      filterIndicator: rule.filterIndicator,
      filterCondition: rule.filterCondition || 'gt',
      filterValue: rule.filterValue,
      filterAction: rule.filterAction || ((rule.impact && rule.impact < 0) ? 'penalty' : 'bonus')
    };
  }

  const text = (rule.text || '').toLowerCase();
  const isLoss = (rule.impact !== undefined && rule.impact < 0) || text.includes('pnl -') || (rule.successRate !== undefined && rule.successRate < 0.4);
  const action = isLoss ? 'penalty' : 'bonus';

  // 1. RSI
  const rsiGtMatch = text.match(/rsi\s*(?:>|более|выше|больше|>=)\s*(\d+)/i);
  if (rsiGtMatch) {
    return { filterIndicator: 'rsi', filterCondition: 'gt', filterValue: parseFloat(rsiGtMatch[1]), filterAction: action };
  }
  const rsiLtMatch = text.match(/rsi\s*(?:<|менее|ниже|меньше|<=)\s*(\d+)/i);
  if (rsiLtMatch) {
    return { filterIndicator: 'rsi', filterCondition: 'lt', filterValue: parseFloat(rsiLtMatch[1]), filterAction: action };
  }
  if (text.includes('перекуплен')) {
    return { filterIndicator: 'rsi', filterCondition: 'gt', filterValue: 68, filterAction: action };
  }
  if (text.includes('перепродан')) {
    return { filterIndicator: 'rsi', filterCondition: 'lt', filterValue: 32, filterAction: action };
  }

  // 2. Change 24h / Pump
  const changeGtMatch = text.match(/(?:рост|памп|движение|изменение)\s*(?:>|более|выше|больше)?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (changeGtMatch) {
    return { filterIndicator: 'change24h', filterCondition: 'gt', filterValue: parseFloat(changeGtMatch[1]), filterAction: action };
  }
  if (text.includes('памп') || text.includes('парабол') || text.includes('pump hunt')) {
    return { filterIndicator: 'change24h', filterCondition: 'gt', filterValue: 6.0, filterAction: action };
  }

  // 3. Volume
  const volGtMatch = text.match(/(?:объем|volume|всплеск)\s*(?:>|более|выше|больше|x)?\s*(\d+(?:\.\d+)?)/i);
  if (volGtMatch) {
    return { filterIndicator: 'volume', filterCondition: 'gt', filterValue: parseFloat(volGtMatch[1]), filterAction: action };
  }
  if (text.includes('кульминац') || text.includes('аномали') || text.includes('всплеск объема') || text.includes('climax')) {
    return { filterIndicator: 'volume', filterCondition: 'gt', filterValue: 1.5, filterAction: action };
  }
  if (text.includes('затухание') || text.includes('без объема') || text.includes('низкий объем') || text.includes('отрицательная динамика объема')) {
    return { filterIndicator: 'volume', filterCondition: 'lt', filterValue: 1.0, filterAction: 'penalty' };
  }

  // 4. Order Book Imbalance
  if (text.includes('стакан') || text.includes('имбаланс') || text.includes('плотност') || text.includes('order book')) {
    return { filterIndicator: 'ob_imbalance', filterCondition: 'gt', filterValue: 15, filterAction: action };
  }

  // 5. Default heuristic for trade auto-learning
  if (text.includes('[авто-обучение') || text.includes('[авто-разбор')) {
    if (isLoss) {
      return { filterIndicator: 'change24h', filterCondition: 'gt', filterValue: 3.0, filterAction: 'penalty' };
    } else {
      return { filterIndicator: 'volume', filterCondition: 'gt', filterValue: 1.2, filterAction: 'bonus' };
    }
  }

  return null;
}

/**
 * Обогащает правила базы знаний структурированными фильтрами для прямого исполнения.
 */
export function enrichKnowledgeBaseWithStructuredFilters(kb: any[]): number {
  if (!Array.isArray(kb)) return 0;
  let count = 0;
  for (const rule of kb) {
    if (!rule || typeof rule !== 'object') continue;
    if (!rule.filterIndicator || rule.filterIndicator === 'none') {
      const inferred = inferStructuredFilterFromRule(rule);
      if (inferred) {
        rule.filterIndicator = inferred.filterIndicator;
        rule.filterCondition = inferred.filterCondition;
        rule.filterValue = inferred.filterValue;
        rule.filterAction = inferred.filterAction;
        count++;
      }
    }
  }
  return count;
}

/**
 * Логистический расчет вероятности уверенности квантовой модели
 */
export function calculateConfidenceProbability(
  symbol: string,
  currentPrice: number,
  volume: number,
  ctx: QuantRiskEngineContext
): { p: number; features: number[] } {
  const globalTrueOHLCV = ctx.getGlobalTrueOHLCV();
  const indicators = globalTrueOHLCV[symbol];
  if (!indicators) return { p: 0.5, features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

  const x1 = indicators.is48hBreakout || 0;
  const x2 = (indicators.rsi1h || 50) - 50;
  const x3 = ((indicators.macdHistogram || 0) / (currentPrice || 1)) * 100;
  const x4 = indicators.ema50 ? ((currentPrice - indicators.ema50) / indicators.ema50) * 100 : 0;
  const x5 = indicators.ema200 ? ((currentPrice - indicators.ema200) / indicators.ema200) * 100 : 0;

  const globalCcxtTickers = ctx.getGlobalCcxtTickers();
  const ticker = globalCcxtTickers['mexc']?.[symbol + '/USDT:USDT'] ||
                 globalCcxtTickers['mexc']?.[symbol + '/USDT'] ||
                 globalCcxtTickers['binance']?.[symbol.replace('USDT', '') + '/USDT'] ||
                 {};
  const avgHourlyVol = (ticker.quoteVolume || 0) / 24;
  const x6 = (volume > avgHourlyVol * 1.5) ? 1 : 0;

  const orderBookImbalance = ctx.getOrderBookImbalance();
  const ob = orderBookImbalance[symbol] || { imbalance: 0 };
  const x7 = (ob.imbalance || 0) / 100;

  const x8 = indicators.wicks?.topPct || 0;
  const x9 = (indicators.isLiquiditySweep || indicators.isLiquiditySweep1h || indicators.isLiquiditySweep5m) ? 1 : 0;
  const x10 = indicators.vwap ? ((currentPrice - indicators.vwap) / indicators.vwap) * 100 : 0;
  const x11 = indicators.psarStatus === 'BEARISH' ? 1 : -1;

  const modelWeights = ctx.getModelWeights();
  const z = (modelWeights.beta0 ?? 0) +
            (modelWeights.beta1 ?? 0) * x1 +
            (modelWeights.beta2 ?? 0) * x2 +
            (modelWeights.beta3 ?? 0) * x3 +
            (modelWeights.beta4 ?? 0) * x4 +
            (modelWeights.beta5 ?? 0) * x5 +
            (modelWeights.beta6 ?? 0) * x6 +
            (modelWeights.beta7 ?? 0) * x7 +
            (modelWeights.beta8 ?? 0) * x8 +
            (modelWeights.beta9 ?? 0) * x9 +
            (modelWeights.beta10 ?? 0) * x10 +
            (modelWeights.beta11 ?? 0) * x11;

  let p = 1 / (1 + Math.exp(-z));

  let probAdjustment = 0;
  try {
    const aiKnowledgeBase = ctx.getAiKnowledgeBase();
    const marketPulse = ctx.getMarketPulse();
    for (const rule of aiKnowledgeBase) {
      if (!rule || !rule.filterIndicator || rule.filterIndicator === 'none') continue;

      let isAssetSpecific = false;
      const symbolMatch = rule.text?.toLowerCase()?.match(/\[авто-обучение\s*\|\s*([a-z0-9\/:]+)\s*\|/);
      if (symbolMatch) {
        const ruleSymbol = symbolMatch[1].replace(/[\/:]/g, '');
        if (ruleSymbol === symbol.toLowerCase().replace(/[\/:]/g, '')) {
          isAssetSpecific = true;
        }
      }

      const structMatch = matchesStructuredFilter(
        rule,
        x2 + 50,
        x6 > 0 ? 2 : 1,
        marketPulse.bias,
        indicators.volatility || 10,
        ob.imbalance,
        marketPulse.fomoIndex || 50,
        indicators.change24h || 0
      );

      if (structMatch.matched) {
        const assetMultiplier = isAssetSpecific ? 1.3 : 1.0;
        const ruleWeight = (rule.successRate ?? 0.5) * (rule.impact || 10) / 100 * assetMultiplier;
        if (structMatch.isBonus) {
          probAdjustment += ruleWeight * 0.1;
        } else if (structMatch.isPenalty) {
          probAdjustment -= ruleWeight * 0.1;
        } else if (structMatch.isBlock) {
          probAdjustment -= 0.3 * assetMultiplier;
        }
      }
    }
  } catch (err) {
    console.error('[PROBABILITY-KBASE-ADJUST] Error applying knowledge base rules to confidence p:', err);
  }

  p = Math.max(0.01, Math.min(0.99, p + probAdjustment));
  return { p, features: [x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11] };
}

export interface KnowledgeBaseEvaluationResult {
  isBlocked: boolean;
  blockReason?: string;
  penaltyScore: number;
  bonusScore: number;
  matchedRuleIds: string[];
  matchedRuleTexts: string[];
}

/**
 * Оценивает сигнал на соответствие выученным правилам из базы знаний ИИ.
 * Применяет правила глобально ко всем активам, с повышенным приоритетом для правил той же монеты.
 */
export function evaluateKnowledgeBaseForSignal(
  symbol: string,
  indicators: {
    rsi?: number;
    volumeSpike?: number;
    bias?: number;
    volatility?: number;
    imbalance?: number;
    fomoIndex?: number;
    change24h?: number;
  },
  aiKnowledgeBase: any[]
): KnowledgeBaseEvaluationResult {
  if (!Array.isArray(aiKnowledgeBase) || aiKnowledgeBase.length === 0) {
    return { isBlocked: false, penaltyScore: 0, bonusScore: 0, matchedRuleIds: [], matchedRuleTexts: [] };
  }

  const cleanSym = symbol ? symbol.toLowerCase().replace(/[\/:]/g, '') : '';
  let penaltyScore = 0;
  let bonusScore = 0;
  let isBlocked = false;
  let blockReason: string | undefined;
  const matchedRuleIds: string[] = [];
  const matchedRuleTexts: string[] = [];

  for (const rule of aiKnowledgeBase) {
    if (!rule) continue;

    // Smart retention: Do NOT discard penalty/warning rules just because isArchived=true!
    const isWarningRule = rule.filterAction === 'penalty' || rule.filterAction === 'block' || (rule.impact !== undefined && rule.impact < 0);
    if (rule.isArchived && !isWarningRule) continue;

    let isAssetSpecific = false;
    let ruleSymbol: string | null = null;
    const symbolMatch = rule.text?.toLowerCase()?.match(/\[(?:авто-обучение|авто-разбор)\s*\|\s*([a-z0-9\/:]+)\s*\|/);
    if (symbolMatch) {
      ruleSymbol = symbolMatch[1].replace(/[\/:]/g, '');
      if (ruleSymbol === cleanSym) {
        isAssetSpecific = true;
      }
    }

    // Dynamic resolution of structured filter if missing on the rule object
    let effectiveRule = rule;
    if (!rule.filterIndicator || rule.filterIndicator === 'none') {
      const inferred = inferStructuredFilterFromRule(rule);
      if (inferred) {
        effectiveRule = {
          ...rule,
          ...inferred
        };
      }
    }

    if (effectiveRule.filterIndicator && effectiveRule.filterIndicator !== 'none') {
      const structMatch = matchesStructuredFilter(
        effectiveRule,
        indicators.rsi ?? 50,
        indicators.volumeSpike ?? 1,
        indicators.bias ?? 0,
        indicators.volatility ?? 10,
        indicators.imbalance ?? 0,
        indicators.fomoIndex ?? 50,
        indicators.change24h ?? 0
      );

      if (structMatch.matched) {
        matchedRuleIds.push(rule.id);
        matchedRuleTexts.push(rule.text);

        const assetMultiplier = isAssetSpecific ? 1.4 : 1.0;
        const ruleWeight = (rule.successRate ?? 0.5) * (Math.abs(rule.impact || 10)) / 100 * assetMultiplier;

        if (structMatch.isBlock) {
          isBlocked = true;
          blockReason = structMatch.reason || `Сработало блокирующее правило базы знаний: [${rule.text}]`;
          break; // Hard block triggered
        } else if (structMatch.isPenalty) {
          penaltyScore += Math.max(5, Math.round(ruleWeight * 15));
        } else if (structMatch.isBonus) {
          bonusScore += Math.max(3, Math.round(ruleWeight * 10));
        }
      }
    } else if (isAssetSpecific && isWarningRule) {
      // Heuristic fallback: if this rule was learned specifically for this coin on a loss, apply coin-specific penalty
      matchedRuleIds.push(rule.id);
      matchedRuleTexts.push(rule.text);
      penaltyScore += 8;
    }
  }

  return {
    isBlocked,
    blockReason,
    penaltyScore,
    bonusScore,
    matchedRuleIds,
    matchedRuleTexts
  };
}

/**
 * Обновление квантового пульса рынка
 */
export async function executeUpdateMarketPulse(ctx: QuantRiskEngineContext): Promise<void> {
  try {
    const signalsCache = ctx.getSignalsCache();
    const topSignals = (signalsCache?.data || []).slice(0, 10);
    const context = topSignals.map((s: any) => `${s.symbol}: ${s.change}% vol=${s.volume}`).join('\n');

    const globalLiquidations = ctx.getGlobalLiquidations();
    const shortsSq = globalLiquidations['BTC']?.shortsSq?.toFixed(0) || 0;
    const longsSq = globalLiquidations['BTC']?.longsSq?.toFixed(0) || 0;

    if (ctx.runAiGeneration && ctx.getMarketPulsePrompt) {
      const prompt = ctx.getMarketPulsePrompt(context, shortsSq, longsSq);
      const result = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json' }
      });

      if (result && result.text) {
        const data = ctx.safeJsonParse(result.text, {});
        ctx.setMarketPulse({
          ...data,
          lastUpdated: Date.now()
        });
        const currentPulse = ctx.getMarketPulse();
        console.log('[AI PULSE] Market Sentiment:', currentPulse.sentiment, 'Bias:', currentPulse.bias);
        return;
      }
    }
    throw new Error('AI generation returned empty');
  } catch (err: any) {
    const isQuota = err?.message?.includes('429') || err?.message?.includes('quota') || err?.message?.includes('Too Many');
    if (!isQuota) {
      console.warn('[AI PULSE] Warning:', err?.message || err);
    }
    const btcTrend = ctx.getSignalsCache()?.btcTrend24h || 0;
    const calcBias = Math.max(-1, Math.min(1, btcTrend / 10));
    const calcSentiment = calcBias > 0.2 ? 'BULLISH' : (calcBias < -0.2 ? 'BEARISH' : 'NEUTRAL');
    ctx.setMarketPulse({
      sentiment: calcSentiment,
      bias: Number(calcBias.toFixed(2)),
      recommendation: calcSentiment === 'BULLISH' ? 'Long Focus / Fade Short Extreme' : (calcSentiment === 'BEARISH' ? 'Short Scalp / Parabolic Fade' : 'Range Trading'),
      lastUpdated: Date.now()
    });
  }
}

/**
 * Сбор социального сентимента монет с кэшированием
 */
export async function executeScrapeSocialSentiment(
  symbol: string,
  ctx: QuantRiskEngineContext
): Promise<{ score: number; mentions: number; lastScraped: number; trend: 'PUMP_HYPE' | 'NEUTRAL' | 'FADING'; sources: string[] }> {
  const cleanSymbol = symbol.replace('USDT', '').replace(':', '').replace('/', '');
  const now = Date.now();
  const cache = ctx.getSocialSentimentCache();

  if (cache[cleanSymbol] && (now - cache[cleanSymbol].lastScraped < 5 * 60 * 1000)) {
    return cache[cleanSymbol];
  }

  const wsTickers = ctx.getWsTickers();
  try {
    const change = (wsTickers.Binance?.[`${cleanSymbol}/USDT`] as any)?.change ?? 0;
    const vol = (wsTickers.Binance?.[`${cleanSymbol}/USDT`] as any)?.quoteVolume ?? 0;

    if (ctx.runAiGeneration && ctx.getSocialScraperPrompt) {
      const prompt = ctx.getSocialScraperPrompt(cleanSymbol, change, vol);
      const result = await ctx.runAiGeneration({
        model: 'gemini-3.7-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: 'application/json' }
      });

      if (result && result.text) {
        const data = ctx.safeJsonParse(result.text, null);
        if (data && typeof data.score === 'number') {
          cache[cleanSymbol] = {
            score: data.score,
            mentions: data.mentions || 10,
            trend: data.trend || 'NEUTRAL',
            lastScraped: now,
            sources: data.sources || ['Twitter/X', 'Telegram']
          };
          console.log(`[SOCIAL SCRAPER] Scraped ${cleanSymbol}: Sentiment Score=${data.score}, Mentions=${data.mentions}, Trend=${data.trend}`);
          return cache[cleanSymbol];
        }
      }
    }
  } catch (err: any) {
    console.warn(`[SOCIAL SCRAPER ERR] Failed scraping sentiment for ${cleanSymbol}:`, err.message);
  }

  const fallbackHype = ((wsTickers.Binance?.[`${cleanSymbol}/USDT`] as any)?.change ?? 0) > 15 ? 'PUMP_HYPE' : 'NEUTRAL';
  const score = fallbackHype === 'PUMP_HYPE' ? 82 : 45;
  cache[cleanSymbol] = {
    score,
    mentions: fallbackHype === 'PUMP_HYPE' ? 240 : 18,
    lastScraped: now - 3 * 60 * 1000,
    trend: fallbackHype,
    sources: ['Twitter (Simulated Scrape/Fallback)', 'Telegram (Simulated Scrape/Fallback)']
  };
  return cache[cleanSymbol];
}
