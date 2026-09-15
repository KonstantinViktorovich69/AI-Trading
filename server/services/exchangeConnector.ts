import ccxt from 'ccxt';

export interface ExchangeTicker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  quoteVolume: number;
  percentage: number;
}

export interface OrderBookDepth {
  bids: [number, number][]; // [price, volume]
  asks: [number, number][]; // [price, volume]
  spread: number;
  bidLiquidityUsdt: number;
  askLiquidityUsdt: number;
}

const initializedExchanges: Record<string, any> = {};

/**
 * Получение или инициализация экземпляра CCXT коннектора к бирже
 */
export function getExchangeInstance(exchangeName: string): any | null {
  const name = exchangeName.toLowerCase();
  if (initializedExchanges[name]) {
    return initializedExchanges[name];
  }

  try {
    if (name === 'binance' && ccxt.binance) {
      initializedExchanges[name] = new ccxt.binance({ enableRateLimit: true, timeout: 10000 });
    } else if (name === 'bybit' && ccxt.bybit) {
      initializedExchanges[name] = new ccxt.bybit({ enableRateLimit: true, timeout: 10000 });
    } else if (name === 'mexc' && ccxt.mexc) {
      initializedExchanges[name] = new ccxt.mexc({ enableRateLimit: true, timeout: 10000 });
    } else if (name === 'okx' && ccxt.okx) {
      initializedExchanges[name] = new ccxt.okx({ enableRateLimit: true, timeout: 10000 });
    } else if (name === 'gateio' && (ccxt.gate || ccxt.gateio)) {
      const GateClass = ccxt.gate || ccxt.gateio;
      initializedExchanges[name] = new GateClass({ enableRateLimit: true, timeout: 10000 });
    } else if (name === 'weex') {
      // Прямой провайдер WEEX через REST
      return null;
    }
  } catch (err) {
    console.error(`[EXCHANGE_CONNECTOR] Ошибка инициализации ${exchangeName}:`, err);
  }

  return initializedExchanges[name] || null;
}

/**
 * Симуляция ликвидности стакана и проскальзывания ордера (Level 2 Depth Matching)
 */
export function simulateOrderbookSlippage(
  orderBook: OrderBookDepth,
  orderAmountUsdt: number,
  side: 'BUY' | 'SELL'
): { estimatedExecutionPrice: number; slippagePercent: number } {
  const depthList = side === 'BUY' ? orderBook.asks : orderBook.bids;
  if (!depthList || depthList.length === 0) {
    return { estimatedExecutionPrice: 0, slippagePercent: 0 };
  }

  const bestPrice = depthList[0][0];
  let remainingUsdt = orderAmountUsdt;
  let totalCost = 0;
  let filledVolume = 0;

  for (const [price, volume] of depthList) {
    const levelValue = price * volume;
    if (remainingUsdt <= levelValue) {
      const takeVol = remainingUsdt / price;
      totalCost += remainingUsdt;
      filledVolume += takeVol;
      remainingUsdt = 0;
      break;
    } else {
      totalCost += levelValue;
      filledVolume += volume;
      remainingUsdt -= levelValue;
    }
  }

  if (filledVolume === 0) return { estimatedExecutionPrice: bestPrice, slippagePercent: 0 };

  const avgExecutionPrice = totalCost / filledVolume;
  const slippagePercent = Math.abs((avgExecutionPrice - bestPrice) / bestPrice) * 100;

  return {
    estimatedExecutionPrice: avgExecutionPrice,
    slippagePercent
  };
}
