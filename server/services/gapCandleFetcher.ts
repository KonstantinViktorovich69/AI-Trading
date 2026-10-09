import { ensureExchangeMarket } from './marketDataHubService.ts';

export interface GapCandleResult {
  ok: boolean;
  reason?: string;
  candles?: any[][];
  timeframe?: string;
  complete?: boolean;
}

/**
 * Resolves symbol for WEEX / CCXT exchange, matching the logic in updateTrueOHLCV:
 * nativeId, unified `${base}/USDT:USDT`, ensureExchangeMarket.
 */
export function resolveFetchSymbol(exchange: any, rawSymbol: string): string {
  if (!exchange) return rawSymbol;
  try {
    ensureExchangeMarket(exchange, rawSymbol);
    const nativeId = rawSymbol.split(':')[0].replace(/[\/_]/g, '');
    const unified = rawSymbol.includes(':') ? rawSymbol : `${rawSymbol.split(':')[0]}:USDT`;
    const market = (Object.values(exchange.markets || {}) as any[]).find(
      (m: any) =>
        (m.id === nativeId || m.symbol === unified || m.symbol === rawSymbol) &&
        (m.swap || m.future || m.linear || m.contract)
    );
    if (market) {
      return market.symbol;
    }
    ensureExchangeMarket(exchange, unified);
    return unified;
  } catch {
    return rawSymbol;
  }
}

/**
 * Fetches candles covering a downtime gap from `fromTs` to `toTs`.
 * Timeframe:
 *   - gap <= 6 hours -> '1m'
 *   - gap <= 48 hours -> '5m'
 *   - gap > 48 hours -> { ok: false, reason: 'GAP_TOO_LONG' }
 *
 * Pagination:
 *   - since pagination, limit 500, max 4 requests
 *   - 350ms delay between requests, 2 retries on error
 *   - total timeout 25 seconds
 */
export async function fetchGapCandles(
  exchange: any,
  symbol: string,
  fromTs: number,
  toTs: number
): Promise<GapCandleResult> {
  if (!exchange || !symbol || !fromTs || !toTs) {
    return { ok: false, reason: 'INVALID_ARGS' };
  }

  const gapMs = Math.max(0, toTs - fromTs);
  const sixHoursMs = 6 * 60 * 60 * 1000;
  const fortyEightHoursMs = 48 * 60 * 60 * 1000;

  if (gapMs > fortyEightHoursMs) {
    return { ok: false, reason: 'GAP_TOO_LONG' };
  }

  const timeframe = gapMs <= sixHoursMs ? '1m' : '5m';
  const tfMs = timeframe === '1m' ? 60 * 1000 : 5 * 60 * 1000;

  const realSymbol = resolveFetchSymbol(exchange, symbol);

  const overallTimeoutMs = 25000;
  const startTime = Date.now();

  const allCandles: any[][] = [];
  const seenTimestamps = new Set<number>();
  let currentSince = Math.max(0, fromTs - tfMs); // include preceding/first candle
  const maxRequests = 4;
  let requestCount = 0;
  let complete = false;

  while (requestCount < maxRequests && currentSince < toTs) {
    if (Date.now() - startTime >= overallTimeoutMs) {
      break;
    }

    if (requestCount > 0) {
      await new Promise((res) => setTimeout(res, 350));
    }

    let fetchedChunk: any[][] | null = null;
    let retries = 2;

    while (retries >= 0) {
      try {
        const remainingTime = Math.max(1000, overallTimeoutMs - (Date.now() - startTime));
        const fetchPromise = exchange.fetchOHLCV(realSymbol, timeframe, currentSince, 500);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), Math.min(10000, remainingTime))
        );
        fetchedChunk = await Promise.race([fetchPromise, timeoutPromise]);
        break;
      } catch (err) {
        retries--;
        if (retries < 0) {
          break;
        }
        await new Promise((res) => setTimeout(res, 350));
      }
    }

    requestCount++;

    if (!Array.isArray(fetchedChunk) || fetchedChunk.length === 0) {
      break;
    }

    for (const c of fetchedChunk) {
      const ts = c[0];
      if (typeof ts === 'number' && !seenTimestamps.has(ts)) {
        seenTimestamps.add(ts);
        allCandles.push(c);
      }
    }

    const lastTs = fetchedChunk[fetchedChunk.length - 1][0];
    if (typeof lastTs !== 'number' || lastTs <= currentSince) {
      break;
    }

    if (lastTs >= toTs) {
      complete = true;
      break;
    }

    currentSince = lastTs + tfMs;
  }

  allCandles.sort((a, b) => a[0] - b[0]);

  if (allCandles.length > 0 && allCandles[allCandles.length - 1][0] >= toTs - tfMs) {
    complete = true;
  }

  if (allCandles.length === 0) {
    return { ok: false, reason: 'NO_CANDLES_FETCHED' };
  }

  return {
    ok: true,
    candles: allCandles,
    timeframe,
    complete
  };
}
